use crate::{
    backend::Backend,
    commands,
    config::Config,
    discord::{Request, no_mentions},
    node::{self, Node},
    resolver::{self, Failure, Resolution},
    session::{GuildSession, Message},
    urls,
    voice::Cache,
};
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{Semaphore, mpsc, oneshot, watch},
    task::JoinSet,
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use twilight_gateway::{
    Event, EventTypeFlags, Intents, MessageSender, Shard, ShardId, StreamExt as _,
};
use twilight_http::Client;
use twilight_model::{
    application::{command::CommandOptionChoice, interaction::InteractionType},
    guild::Permissions,
    http::interaction::{InteractionResponse, InteractionResponseData, InteractionResponseType},
};

pub(crate) struct Shared {
    pub config: Config,
    pub http: Client,
    pub node: Node,
    pub bot: u64,
    pub cache: RwLock<Cache>,
    pub changed: watch::Sender<u64>,
    pub gateway: MessageSender,
    pub cancel: CancellationToken,
    pub latency_ms: AtomicU64,
    pub interaction_errors: AtomicU64,
    autocomplete: Mutex<HashMap<String, (Instant, Vec<CommandOptionChoice>)>>,
    searches: Semaphore,
}

/// Reserve a bounded response lane for rejected admission. At extreme saturation,
/// count the failed delivery without delaying gateway heartbeats or growing tasks.
fn reject(jobs: &mut JoinSet<()>, shared: &Arc<Shared>, request: Request, reason: &'static str) {
    shared.interaction_errors.fetch_add(1, Ordering::Relaxed);
    if jobs.len() < 16 {
        let shared = shared.clone();
        jobs.spawn(async move {
            request.reject(&shared.http, reason).await;
        });
    }
}

impl Shared {
    #[cfg(test)]
    pub(crate) async fn fixture() -> (
        Arc<Self>,
        Backend,
        node::NodeOwner,
        mpsc::Receiver<node::Event>,
    ) {
        let backend = Backend::start_fixture().await.unwrap();
        let (node, owner, events) =
            Node::start(backend.address, backend.password.clone(), 9).unwrap();
        node.wait_ready().await.unwrap();
        let config = Config::from_env(
            &HashMap::from([("DISCORD_TOKEN".into(), "fixture".into())]),
            false,
        )
        .unwrap();
        let shard = Shard::new(ShardId::ONE, "fixture".into(), Intents::empty());
        let (changed, _) = watch::channel(0);
        let shared = Arc::new(Self {
            config,
            http: Client::builder()
                .token("fixture".into())
                .proxy("127.0.0.1:1".into(), true)
                .ratelimiter(None)
                .build(),
            node,
            bot: 9,
            cache: RwLock::new(Cache::default()),
            changed,
            gateway: shard.sender(),
            cancel: CancellationToken::new(),
            latency_ms: AtomicU64::new(0),
            interaction_errors: AtomicU64::new(0),
            autocomplete: Mutex::new(HashMap::new()),
            searches: Semaphore::new(4),
        });
        (shared, backend, owner, events)
    }
    pub fn loaded(&self, guild: u64) -> bool {
        self.cache
            .read()
            .unwrap()
            .guilds
            .get(&guild)
            .is_some_and(|g| g.available)
    }
    pub fn access(&self, guild: u64, user: u64, intended: Option<u64>) -> Result<u64, String> {
        self.cache
            .read()
            .unwrap()
            .guilds
            .get(&guild)
            .ok_or("Raydio commands are available only in a loaded server.".to_owned())?
            .access(guild, user, self.bot, intended)
    }
    pub async fn resolve(
        &self,
        input: &str,
        capacity: usize,
        search_limit: usize,
    ) -> Result<Resolution, Failure> {
        let (first, fallback, playlist) = resolver::identifiers(input)?;
        let search = fallback.is_some();
        let mut result = self
            .node
            .load(&first)
            .await
            .map_err(|_| Failure::Unavailable)
            .and_then(|v| {
                resolver::normalize(
                    v,
                    playlist,
                    search,
                    if search {
                        capacity.min(search_limit)
                    } else {
                        capacity
                    },
                    &self.config.limits,
                )
            });
        if result.is_err()
            && let Some(fallback) = fallback
        {
            result = self
                .node
                .load(&fallback)
                .await
                .map_err(|_| Failure::Unavailable)
                .and_then(|v| {
                    resolver::normalize(
                        v,
                        false,
                        true,
                        capacity.min(search_limit),
                        &self.config.limits,
                    )
                });
        }
        result
    }
    async fn autocomplete(&self, request: Request) {
        let query = request.option("request").trim();
        let guild = request.interaction.guild_id.map(|id| id.get());
        let valid = query.len() >= 2
            && query.len() <= 500
            && matches!(urls::classify(query), urls::Input::Search(_))
            && guild.is_some_and(|id| {
                let cache = self.cache.read().unwrap();
                cache.guilds.get(&id).is_some_and(|guild| {
                    guild.available
                        && guild.activity.queue_count < self.config.limits.queue
                        && guild.activity.pending < self.config.pending
                        && guild
                            .access(id, request.user(), self.bot, None)
                            .is_ok_and(|channel| {
                                guild
                                    .activity
                                    .channel
                                    .is_none_or(|active| active == channel)
                            })
                })
            })
            && self.node.health().ready;
        let choices = if valid {
            let cached = self
                .autocomplete
                .lock()
                .unwrap()
                .get(query)
                .filter(|(at, _)| at.elapsed() < Duration::from_secs(30))
                .map(|(_, choices)| choices.clone());
            if let Some(choices) = cached {
                choices
            } else if let Ok(_permit) = self.searches.try_acquire() {
                match timeout(Duration::from_millis(1900), self.resolve(query, 10, 10)).await {
                    Ok(Ok(result)) => {
                        let choices = crate::views::search_choices(result.tracks);
                        let mut cache = self.autocomplete.lock().unwrap();
                        cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(30));
                        if cache.len() >= 500
                            && let Some(oldest) = cache
                                .iter()
                                .min_by_key(|(_, (at, _))| *at)
                                .map(|(key, _)| key.clone())
                        {
                            cache.remove(&oldest);
                        }
                        cache.insert(query.to_owned(), (Instant::now(), choices.clone()));
                        choices
                    }
                    _ => vec![],
                }
            } else {
                vec![]
            }
        } else {
            vec![]
        };
        let response = InteractionResponse {
            kind: InteractionResponseType::ApplicationCommandAutocompleteResult,
            data: Some(InteractionResponseData {
                choices: Some(choices),
                ..Default::default()
            }),
        };
        let _ = timeout(
            Duration::from_millis(350),
            self.http
                .interaction(request.interaction.application_id)
                .create_response(
                    request.interaction.id,
                    &request.interaction.token,
                    &response,
                ),
        )
        .await;
    }
}

/// One owned gateway pump; each guild serializes controls while source loading runs separately.
pub async fn run(config: Config, cancel: CancellationToken) -> Result<()> {
    let http = Client::builder()
        .token(config.token.clone())
        .default_allowed_mentions(no_mentions())
        .build();
    let user = timeout(Duration::from_secs(10), http.current_user())
        .await
        .context("Discord login timed out")?
        .map_err(|_| anyhow::anyhow!("Discord login failed; check the selected bot token"))?
        .model()
        .await?;
    let app = timeout(Duration::from_secs(10), http.current_user_application())
        .await??
        .model()
        .await?;
    let backend = Backend::start().await?;
    let (node, owner, mut node_events) =
        Node::start(backend.address, backend.password.clone(), user.id.get())?;
    node.wait_ready().await?;
    timeout(
        Duration::from_secs(15),
        http.interaction(app.id)
            .set_global_commands(&commands::definitions()),
    )
    .await??;
    let mut shard = Shard::new(
        ShardId::ONE,
        config.token.clone(),
        Intents::GUILDS | Intents::GUILD_VOICE_STATES,
    );
    let (changed, _) = watch::channel(0);
    let shared = Arc::new(Shared {
        config,
        http,
        node,
        bot: user.id.get(),
        cache: RwLock::new(Cache::default()),
        changed,
        gateway: shard.sender(),
        cancel: cancel.clone(),
        latency_ms: AtomicU64::new(0),
        interaction_errors: AtomicU64::new(0),
        autocomplete: Mutex::new(HashMap::new()),
        searches: Semaphore::new(4),
    });
    let mut guilds: HashMap<u64, mpsc::Sender<Message>> = HashMap::new();
    let mut actors = JoinSet::new();
    let mut jobs = JoinSet::new();
    let mut rejections = JoinSet::new();
    let mut presence_tick = tokio::time::interval(Duration::from_secs(1));
    presence_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_presence = String::new();
    let mut last_presence_at = Instant::now() - Duration::from_secs(20);
    let outcome = loop {
        tokio::select! {
            _ = cancel.cancelled() => break Ok(()),
            Some(_) = jobs.join_next(), if !jobs.is_empty() => {},
            Some(_) = rejections.join_next(), if !rejections.is_empty() => {},
            _ = presence_tick.tick() => {
                let presence = {
                    let cache = shared.cache.read().unwrap();
                    let count = cache.guilds.values().filter(|guild| guild.activity.channel.is_some()).count();
                    let title = (cache.guilds.len() == 1).then(|| cache.guilds.values().next().and_then(|guild| guild.activity.title.clone())).flatten();
                    match title { Some(title) => (2, title), None if count == 0 => (3, "/play".to_owned()), None => (2, format!("{count} active session{}", if count == 1 { "" } else { "s" })) }
                };
                let key = format!("{}:{}", presence.0, presence.1);
                if key != last_presence && last_presence_at.elapsed() >= Duration::from_secs(4) && shared.cache.read().unwrap().ready {
                    let activity = serde_json::from_value::<twilight_model::gateway::presence::Activity>(serde_json::json!({"name":presence.1,"type":presence.0})).expect("valid activity");
                    if let Ok(update) = twilight_model::gateway::payload::outgoing::UpdatePresence::new(vec![activity], false, None, twilight_model::gateway::presence::Status::Online) {
                        shard.command(&update); last_presence = key; last_presence_at = Instant::now();
                    }
                }
            },
            Some(result) = actors.join_next(), if !actors.is_empty() => {
                match result { Ok(guild) => { guilds.remove(&guild); }, Err(_) => { tracing::error!("Guild worker terminated unexpectedly"); break Err(anyhow::anyhow!("guild worker failed")); } }
            },
            event = node_events.recv() => match event {
                Some(node::Event::Invalidated) => { if guilds.values().any(|tx| tx.try_send(Message::Invalidated).is_err()) { break Err(anyhow::anyhow!("guild lifecycle queue overloaded")); } },
                Some(node::Event::Connected) => { if guilds.values().any(|tx| tx.try_send(Message::Connected).is_err()) { break Err(anyhow::anyhow!("guild lifecycle queue overloaded")); } },
                Some(node::Event::Payload(payload)) => {
                    if let Some(tx) = payload["guildId"].as_str().and_then(|id| id.parse::<u64>().ok()).and_then(|id| guilds.get(&id))
                        && tx.try_send(Message::Backend(payload)).is_err() { break Err(anyhow::anyhow!("guild music event queue overloaded")); }
                }
                None => break Err(anyhow::anyhow!("music event stream closed")),
            },
            event = shard.next_event(EventTypeFlags::all()) => {
                let event = match event {
                    Some(Ok(event)) => event,
                    Some(Err(_)) => { shared.cache.write().unwrap().ready = false; tracing::warn!("Discord gateway receive failed; reconnecting"); continue; },
                    None => break Err(anyhow::anyhow!("Discord gateway stopped")),
                };
                if let Some(latency) = shard.latency().average() { shared.latency_ms.store(latency.as_millis() as u64, Ordering::Relaxed); }
                let changed_guild = shared.cache.write().unwrap().update(&event, shared.bot);
                shared.changed.send_modify(|version| *version = version.wrapping_add(1));
                if let Some(guild) = changed_guild && let Some(tx) = guilds.get(&guild) { let _ = tx.try_send(Message::VoiceChanged); }
                match event {
                    Event::Ready(_) => tracing::info!(bot_id = shared.bot, "Raydio ready"),
                    Event::InteractionCreate(interaction) => {
                        let interaction = Arc::new(interaction.0);
                        let Some(guild) = interaction.guild_id.map(|id| id.get()) else {
                            reject(&mut rejections, &shared, Request::new(interaction), "Raydio commands are available only in a loaded server.");
                            continue;
                        };
                        if jobs.len() >= 128 {
                            reject(&mut rejections, &shared, Request::new(interaction), "Raydio is busy. Please try again in a moment.");
                            continue;
                        }
                        if interaction.kind == InteractionType::ApplicationCommandAutocomplete {
                            let shared = shared.clone();
                            jobs.spawn(async move { tokio::select! { _ = shared.cancel.cancelled() => {}, _ = shared.autocomplete(Request::new(interaction)) => {} } });
                            continue;
                        }
                        if !matches!(interaction.kind, InteractionType::ApplicationCommand | InteractionType::MessageComponent) { continue; }
                        let request = Request::new(interaction.clone());
                        // Check administrator-only diagnostics before acknowledging publicly.
                        let denied = request.name == "diagnostics" && !interaction.member.as_ref().and_then(|m| m.permissions).is_some_and(|p| p.intersects(Permissions::MANAGE_GUILD | Permissions::ADMINISTRATOR));
                        if denied || !shared.loaded(guild) {
                            reject(&mut rejections, &shared, request, if denied { "`/diagnostics` requires the Manage Server permission." } else { "Raydio commands are available only in a loaded server." });
                            continue;
                        }
                        if !guilds.contains_key(&guild) {
                            if guilds.len() >= crate::voice::MAX_GUILDS {
                                reject(&mut rejections, &shared, request, "Raydio is at capacity. Please try again later.");
                                continue;
                            }
                            let (tx, rx) = mpsc::channel(128);
                            guilds.insert(guild, tx);
                            let shared = shared.clone();
                            actors.spawn(async move { GuildSession::new(guild, shared).run(rx).await; guild });
                        }
                        let (ack_tx, ack_rx) = oneshot::channel();
                        if guilds[&guild].try_send(Message::Interaction(request, ack_rx)).is_err() {
                            reject(&mut rejections, &shared, Request::new(interaction), "Raydio is busy in this server. Please try again in a moment.");
                            continue;
                        }
                        let shared = shared.clone();
                        jobs.spawn(async move {
                            let request = Request::new(interaction);
                            let ok = request.acknowledge(&shared.http).await;
                            let _ = ack_tx.send(ok);
                        });
                    }
                    _ => {}
                }
            }
        }
    };
    cancel.cancel();
    jobs.abort_all();
    rejections.abort_all();
    while jobs.join_next().await.is_some() {}
    while rejections.join_next().await.is_some() {}
    if timeout(Duration::from_secs(5), async {
        while actors.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        actors.abort_all();
        while actors.join_next().await.is_some() {}
    }
    shard.close(twilight_gateway::CloseFrame::NORMAL);
    let _ = timeout(
        Duration::from_secs(1),
        shard.next_event(EventTypeFlags::all()),
    )
    .await;
    owner.shutdown().await;
    backend.shutdown().await?;
    outcome
}
