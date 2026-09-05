use crate::{
    commands,
    discord::Request,
    playback::{LoopMode, Queue},
    resolver::{Failure, Resolution},
    runtime::Shared,
    views::{self, View},
    voice::Server,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinSet,
    time::{Instant, MissedTickBehavior, interval, timeout},
};
use twilight_model::{gateway::payload::outgoing::UpdateVoiceState, id::Id};

pub(crate) enum Message {
    Interaction(Request, oneshot::Receiver<bool>),
    Backend(Value),
    VoiceChanged,
    Invalidated,
    Connected,
}
struct Pending {
    request: Request,
    channel: u64,
    epoch: u64,
    sequence: u64,
}
struct Panel {
    channel: u64,
    message: u64,
    token: String,
    last_view: Option<View>,
}
enum EditOutcome {
    Delivered,
    Stale,
    TransientFailure,
    TerminalFailure,
}
struct PanelEdit {
    channel: u64,
    message: u64,
    view: View,
    retire: bool,
    outcome: EditOutcome,
}
#[derive(serde::Deserialize)]
struct StoredPanel {
    #[serde(default)]
    embeds: Vec<StoredEmbed>,
}
#[derive(serde::Deserialize)]
struct StoredEmbed {
    footer: Option<StoredFooter>,
}
#[derive(serde::Deserialize)]
struct StoredFooter {
    text: String,
}
pub(crate) struct GuildSession {
    id: u64,
    shared: Arc<Shared>,
    queue: Queue,
    channel: Option<u64>,
    credentials: Option<(String, Server)>,
    token: String,
    generation: u64,
    epoch: u64,
    sequence: u64,
    volume: u16,
    paused: bool,
    position_ms: u64,
    position_at: Instant,
    end_deadline: Option<Instant>,
    started: bool,
    connected: bool,
    idle_at: Option<Instant>,
    alone_at: Option<Instant>,
    pending: VecDeque<Pending>,
    loading: Option<Pending>,
    loaders: JoinSet<(u64, Result<Resolution, Failure>)>,
    responses: JoinSet<()>,
    // At most one progress edit, with newer snapshots coalesced in session state.
    panel_edits: JoinSet<PanelEdit>,
    panel: Option<Panel>,
    notification: Option<u64>,
    events: [u64; 7],
    edits: u64,
    edit_errors: u64,
    edit_terminal: u64,
    panel_retry: Instant,
    panel_checks: u8,
    panel_check_at: Instant,
}
impl GuildSession {
    async fn interaction(&mut self, mut request: Request) {
        if !self.shared.loaded(self.id) {
            request
                .error(
                    &self.shared.http,
                    "Raydio commands are available only in a loaded server.",
                )
                .await;
            return;
        }
        if let Some(custom_id) = &request.custom_id {
            let parts: Vec<_> = custom_id.split(':').collect();
            let kind = parts.get(1).copied().unwrap_or("");
            let token = parts.get(2).copied().unwrap_or("");
            let action = parts.get(3).copied().unwrap_or("");
            let valid = parts.len() == 4
                && parts[0] == "raydio"
                && self.queue.current.is_some()
                && if kind == "queue" {
                    token == self.token
                } else {
                    kind == "player"
                        && self.panel.as_ref().is_some_and(|p| {
                            p.token == token
                                && request
                                    .interaction
                                    .message
                                    .as_ref()
                                    .is_some_and(|m| m.id.get() == p.message)
                        })
                };
            if !valid {
                let _ = request
                    .respond(
                        &self.shared.http,
                        View::text(if kind == "queue" {
                            "This queue view is no longer active. Run `/queue` again."
                        } else {
                            "These player controls are no longer active. Run `/nowplaying` again."
                        }),
                    )
                    .await;
                return;
            }
            if kind == "queue" {
                let view = self.queue_view(action.parse().unwrap_or(0));
                let _ = request.respond(&self.shared.http, view).await;
                return;
            }
            request.name = action.to_owned();
            if request.name == "pause" && self.paused {
                request.name = "resume".into();
            }
            if request.name == "loop" {
                request.options.insert(
                    "mode".into(),
                    if self.queue.loop_mode == LoopMode::Off {
                        "track"
                    } else {
                        "off"
                    }
                    .into(),
                );
            }
        }
        match request.name.as_str() {
            "play" => {
                self.prepare_play(request).await;
                return;
            }
            "nowplaying" => {
                self.present_player(&request, None).await;
                return;
            }
            "queue" => {
                let view = self.queue_view(0);
                let _ = request.respond(&self.shared.http, view).await;
                return;
            }
            "help" => {
                let _ = request
                    .respond(&self.shared.http, View::text(commands::HELP))
                    .await;
                return;
            }
            "ping" => {
                let ready = self.shared.cache.read().unwrap().ready;
                let discord = if ready {
                    format!("{} ms", self.shared.latency_ms.load(Ordering::Relaxed))
                } else {
                    "unavailable".into()
                };
                let _ = request
                    .respond(
                        &self.shared.http,
                        View::text(format!(
                            "Pong! Discord: {discord}. Lavalink: {}.",
                            if self.shared.node.health().ready {
                                "ready"
                            } else {
                                "unavailable"
                            }
                        )),
                    )
                    .await;
                return;
            }
            "diagnostics" => {
                let health = self.shared.node.health();
                let status = if self.channel.is_none() {
                    "no session"
                } else if self.queue.current.is_none() {
                    "idle"
                } else if self.paused {
                    "paused"
                } else {
                    "playing"
                };
                let mut text = format!(
                    "Raydio diagnostics\nState: {status} • upcoming {} • history {} • pending {}\nLoop: {} • volume {}% • position {} ms\nDiscord: {} • {} ms • response errors {}\nMusic service: {} • connections {} • errors {}\nVoice connected: {} • track started: {}\nEvents: queue {}, transitions {}, starts {}, finished {}, failed {}, watchdog {}, cleanup {}\nPlayer edits: {} successful • {} transient failures • {} terminal failures",
                    self.queue.upcoming.len(),
                    self.queue.history.len(),
                    self.pending.len() + usize::from(self.loading.is_some()),
                    views::mode_name(self.queue.loop_mode),
                    self.volume,
                    self.position(),
                    self.shared.cache.read().unwrap().ready,
                    self.shared.latency_ms.load(Ordering::Relaxed),
                    self.shared.interaction_errors.load(Ordering::Relaxed),
                    health.ready,
                    health.connections,
                    health.errors,
                    self.connected,
                    self.started,
                    self.events[0],
                    self.events[1],
                    self.events[2],
                    self.events[3],
                    self.events[4],
                    self.events[5],
                    self.events[6],
                    self.edits,
                    self.edit_errors,
                    self.edit_terminal
                );
                if let Some(at) = health.audio.observed_at {
                    text.push_str(&format!(
                        "\nLast node audio window ({}s ago): {} sent • {} unavailable • {} missed deadlines; {} observed windows",
                        at.elapsed().as_secs(), health.audio.sent, health.audio.unavailable,
                        health.audio.missed_deadlines, health.audio.windows
                    ));
                }
                let _ = request.respond(&self.shared.http, View::text(text)).await;
                return;
            }
            _ => {}
        }
        match self.control(&request).await {
            Ok(text) => {
                if request.updates_message() {
                    // Apply the audio control first, then serialize its message
                    // after any older progress snapshot already in flight.
                    self.flush_refresh().await;
                }
                if request.updates_message() && !matches!(request.name.as_str(), "stop" | "leave") {
                    let view = self.player_view();
                    if request
                        .respond_no_model(&self.shared.http, &view)
                        .await
                        .is_ok()
                        && let Some(panel) = self.panel.as_mut()
                    {
                        panel.last_view = Some(view);
                        // Discord has acknowledged a paused snapshot and later
                        // persisted an older Playing snapshot in live tests.
                        // Playing panels self-correct on the next progress edit;
                        // paused panels need bounded reconciliation instead.
                        if self.paused {
                            self.panel_checks = 3;
                            self.panel_check_at = Instant::now() + Duration::from_millis(500);
                        } else {
                            self.panel_checks = 0;
                        }
                    }
                } else {
                    let _ = request.respond(&self.shared.http, View::text(text)).await;
                    if request.updates_message() {
                        // A terminal button response owns the final panel text.
                        // Retire it before the periodic refresh can replace it.
                        self.panel = None;
                    }
                }
            }
            Err(error) => request.error(&self.shared.http, &error).await,
        }
        self.refresh().await;
    }
    async fn control(&mut self, request: &Request) -> Result<String, String> {
        let name = request.name.as_str();
        if name == "volume" && request.option("level").is_empty() {
            return Ok(if self.channel.is_none() {
                "There is no active music session.".into()
            } else {
                format!("Current volume: {}%.", self.volume)
            });
        }
        if !matches!(
            name,
            "pause"
                | "resume"
                | "previous"
                | "skip"
                | "stop"
                | "move"
                | "jump"
                | "shuffle"
                | "remove"
                | "clear"
                | "volume"
                | "loop"
                | "leave"
        ) {
            return Err(
                "That command is no longer registered. Type `/` to see Raydio's commands.".into(),
            );
        }
        if !self.shared.node.health().ready
            && matches!(
                name,
                "pause" | "resume" | "previous" | "skip" | "jump" | "volume"
            )
        {
            return Err("Music service is temporarily unavailable.".into());
        }
        {
            let cache = self.shared.cache.read().unwrap();
            let guild = cache
                .guilds
                .get(&self.id)
                .ok_or("There is no active music session.")?;
            let channel = guild.caller_channel(request.user()).map_err(|error| {
                if !guild.voices.contains_key(&request.user()) {
                    "Join the bot's voice channel before using that control.".into()
                } else {
                    error
                }
            })?;
            if self.channel.is_none() && !matches!(name, "stop" | "leave") {
                return Err("There is no active music session.".into());
            }
            if self.channel.is_some_and(|active| active != channel) {
                return Err(
                    "Join the bot's current voice channel before using that control.".into(),
                );
            }
        }
        let transport_error =
            |_| "The music service could not apply that control. Try again shortly.".to_owned();
        match name {
            "pause" | "resume" => {
                if self.queue.current.is_none() {
                    return Ok("Nothing is playing.".into());
                }
                let paused = name == "pause";
                if paused == self.paused {
                    return Ok(if paused {
                        "Playback is already paused."
                    } else {
                        "Playback is already running."
                    }
                    .into());
                }
                self.shared
                    .node
                    .update(self.id, json!({"paused":paused}))
                    .await
                    .map_err(transport_error)?;
                self.position_ms = self.position();
                self.position_at = Instant::now();
                self.paused = paused;
                self.schedule_end();
                Ok(if paused {
                    "Playback paused."
                } else {
                    "Playback resumed."
                }
                .into())
            }
            "volume" => {
                let volume = request
                    .option("level")
                    .parse::<u16>()
                    .ok()
                    .filter(|v| *v <= 100)
                    .ok_or("Volume must be an integer between 0 and 100.")?;
                if volume == self.volume {
                    return Ok(format!("Volume is already {volume}%."));
                }
                self.shared
                    .node
                    .update(self.id, json!({"volume":volume}))
                    .await
                    .map_err(transport_error)?;
                self.volume = volume;
                Ok(format!("Volume set to {volume}%."))
            }
            "loop" => {
                self.queue.loop_mode = match request.option("mode") {
                    "off" => LoopMode::Off,
                    "track" => LoopMode::Track,
                    "queue" => LoopMode::Queue,
                    _ => return Err("Choose off, track, or queue for loop mode.".into()),
                };
                Ok(format!(
                    "Loop mode set to {}.",
                    views::mode_name(self.queue.loop_mode)
                ))
            }
            "remove" => Ok(self
                .queue
                .remove(request.index("position"))
                .map(|t| format!("Removed **{}**.", views::safe(&t.title, 160)))
                .unwrap_or_else(|| "There is no upcoming track at that index.".into())),
            "move" => {
                let (from, to) = (request.index("from"), request.index("to"));
                Ok(self
                    .queue
                    .move_to(from, to)
                    .map(|t| {
                        if from == to {
                            format!(
                                "**{}** is already at position {from}.",
                                views::safe(&t.title, 160)
                            )
                        } else {
                            format!(
                                "Moved **{}** from {from} to {to}.",
                                views::safe(&t.title, 160)
                            )
                        }
                    })
                    .unwrap_or_else(|| {
                        "One of those upcoming queue positions does not exist.".into()
                    }))
            }
            "clear" => {
                let count = self.queue.clear();
                Ok(if count == 0 {
                    "The upcoming queue is already empty.".into()
                } else {
                    format!(
                        "Cleared {count} upcoming track{}.",
                        if count == 1 { "" } else { "s" }
                    )
                })
            }
            "shuffle" => Ok(if self.queue.shuffle() {
                "Shuffled the upcoming queue."
            } else {
                "At least two upcoming tracks are needed."
            }
            .into()),
            "previous" | "jump" | "skip" => {
                if name == "previous" && !self.queue.previous() {
                    return Ok("There is no previous track in this session.".into());
                }
                if name == "jump" && !self.queue.jump(request.index("position")) {
                    return Ok("There is no upcoming song at that position.".into());
                }
                if name == "skip" {
                    if self.queue.current.is_none() {
                        return Ok("Nothing is playing.".into());
                    }
                    self.queue.skip();
                }
                self.start_current().await.map_err(transport_error)?;
                Ok(self
                    .queue
                    .current
                    .as_ref()
                    .map(|track| {
                        format!(
                            "{} **{}**.",
                            match name {
                                "skip" => "Skipped. Now playing",
                                "jump" => "Jumped to",
                                _ => "Now playing",
                            },
                            views::safe(&track.title, 160)
                        )
                    })
                    .unwrap_or_else(|| "Skipped. The queue is now empty.".into()))
            }
            "stop" => {
                self.invalidate().await;
                let had = !self.queue.is_empty();
                self.queue.stop();
                self.token = random_token();
                self.paused = false;
                if self.channel.is_some() {
                    if self.shared.node.health().ready {
                        self.start_current().await.map_err(transport_error)?;
                    }
                    self.idle_at = Some(Instant::now());
                }
                Ok(if had {
                    "Playback stopped and the upcoming queue was cleared."
                } else {
                    "Playback is already stopped."
                }
                .into())
            }
            "leave" => {
                let active = self.channel.is_some();
                self.cleanup(None).await;
                Ok(if active {
                    "Left the voice channel and cleared the session."
                } else {
                    "There is no active music session."
                }
                .into())
            }
            _ => unreachable!(),
        }
    }
    pub fn new(id: u64, shared: Arc<Shared>) -> Self {
        Self {
            id,
            volume: shared.config.volume,
            shared,
            queue: Queue::default(),
            channel: None,
            credentials: None,
            token: random_token(),
            generation: 0,
            epoch: 0,
            sequence: 0,
            paused: false,
            position_ms: 0,
            position_at: Instant::now(),
            end_deadline: None,
            started: false,
            connected: false,
            idle_at: None,
            alone_at: None,
            pending: VecDeque::new(),
            loading: None,
            loaders: JoinSet::new(),
            responses: JoinSet::new(),
            panel_edits: JoinSet::new(),
            panel: None,
            notification: None,
            events: [0; 7],
            edits: 0,
            edit_errors: 0,
            edit_terminal: 0,
            panel_retry: Instant::now(),
            panel_checks: 0,
            panel_check_at: Instant::now(),
        }
    }
    pub async fn run(mut self, mut receiver: mpsc::Receiver<Message>) {
        let mut tick = interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = self.shared.cancel.cancelled() => break,
                message = receiver.recv() => match message {
                    Some(Message::Interaction(request, ack)) => {
                        if matches!(timeout(Duration::from_secs(4), ack).await, Ok(Ok(true))) { self.interaction(request).await; }
                    }
                    Some(Message::Backend(payload)) => self.backend(payload).await,
                    Some(Message::VoiceChanged) => self.voice_changed().await,
                    Some(Message::Invalidated) => self.cleanup(Some("Music service session changed. The queue was cleared; use `/play` again.")).await,
                    Some(Message::Connected) => {
                        if self.channel.is_none() { let _ = self.shared.node.destroy(self.id).await; }
                        else if self.queue.current.is_none() { let _ = self.start_current().await; }
                        else { self.voice_changed().await; }
                    }
                    None => break,
                },
                Some(result) = self.loaders.join_next(), if !self.loaders.is_empty() => {
                    match result {
                        Ok((sequence, result)) if self.loading.as_ref().is_some_and(|p| p.sequence == sequence) => {
                            let pending = self.loading.take().expect("matching pending resolution");
                            self.commit(pending, result).await;
                        }
                        Err(error) if error.is_panic() => {
                            if let Some(pending) = self.loading.take() { pending.request.error(&self.shared.http, "YouTube could not load that request. Try another song.").await; }
                        }
                        _ => {}
                    }
                }
                Some(_) = self.responses.join_next(), if !self.responses.is_empty() => {},
                Some(result) = self.panel_edits.join_next(), if !self.panel_edits.is_empty() => {
                    self.finish_refresh(result);
                    self.refresh().await;
                },
                _ = tick.tick() => self.tick().await,
            }
            self.start_load();
            self.publish_activity();
            if !self
                .shared
                .cache
                .read()
                .unwrap()
                .guilds
                .contains_key(&self.id)
            {
                break;
            }
        }
        self.loaders.abort_all();
        let _ = timeout(Duration::from_secs(3), self.cleanup(None)).await;
        self.panel_edits.shutdown().await;
        self.responses.abort_all();
        self.publish_activity();
    }
    fn publish_activity(&self) {
        if let Some(guild) = self.shared.cache.write().unwrap().guilds.get_mut(&self.id) {
            guild.activity = crate::voice::Activity {
                channel: self.channel,
                queue_count: self.queue.len(),
                pending: self.pending.len() + usize::from(self.loading.is_some()),
                title: self
                    .queue
                    .current
                    .as_ref()
                    .map(|track| views::truncate(&track.title, 100)),
            };
        }
    }
    fn position(&self) -> u64 {
        self.position_ms
            .saturating_add(if self.paused || !self.started {
                0
            } else {
                self.position_at.elapsed().as_millis() as u64
            })
    }
    fn schedule_end(&mut self) {
        self.end_deadline = self
            .queue
            .current
            .as_ref()
            .filter(|track| !track.stream && !self.paused)
            .and_then(|track| {
                Instant::now().checked_add(Duration::from_millis(
                    track
                        .duration_ms
                        .saturating_sub(self.position())
                        .saturating_add(15_000),
                ))
            });
    }
    fn player_view(&self) -> View {
        views::player(
            &self.queue,
            self.panel
                .as_ref()
                .map(|p| p.token.as_str())
                .unwrap_or(&self.token),
            self.paused,
            self.volume,
            self.position(),
        )
    }
    fn queue_view(&mut self, page: usize) -> View {
        let view = views::queue(
            &self.queue,
            &self.token,
            page,
            self.paused,
            self.volume,
            self.position(),
        );
        if view.components.is_empty() {
            self.token = random_token();
        }
        view
    }
    fn start_load(&mut self) {
        if self.loading.is_some() {
            return;
        }
        let Some(pending) = self.pending.pop_front() else {
            return;
        };
        let input = pending.request.option("request").to_owned();
        let capacity = self
            .shared
            .config
            .limits
            .queue
            .saturating_sub(self.queue.len());
        let shared = self.shared.clone();
        let sequence = pending.sequence;
        self.loading = Some(pending);
        self.loaders.spawn(async move {
            (
                sequence,
                timeout(Duration::from_secs(45), shared.resolve(&input, capacity, 1))
                    .await
                    .unwrap_or(Err(Failure::Unavailable)),
            )
        });
    }
    async fn invalidate(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.loaders.abort_all();
        if let Some(pending) = self.loading.take() {
            self.pending.push_front(pending);
        }
        while let Some(pending) = self.pending.pop_front() {
            if self.responses.len() < 128 {
                let shared = self.shared.clone();
                self.responses.spawn(async move {
                    pending
                        .request
                        .error(
                            &shared.http,
                            "That play request was canceled by a newer stop or disconnect.",
                        )
                        .await;
                });
            }
        }
    }
    async fn prepare_play(&mut self, request: Request) {
        if !self.shared.node.health().ready {
            request
                .error(
                    &self.shared.http,
                    "Music service is temporarily unavailable.",
                )
                .await;
            return;
        }
        if request.option("request").trim().is_empty() {
            request
                .error(
                    &self.shared.http,
                    "Use `/play request:` and enter search terms or a YouTube URL.",
                )
                .await;
            return;
        }
        if self.pending.len() + usize::from(self.loading.is_some()) >= self.shared.config.pending {
            request
                .error(
                    &self.shared.http,
                    "Too many play requests are already pending for this server.",
                )
                .await;
            return;
        }
        // Fetch only when the guild snapshot did not include our own membership.
        let needs_member = self
            .shared
            .cache
            .read()
            .unwrap()
            .guilds
            .get(&self.id)
            .is_some_and(|guild| guild.bot_roles.is_none());
        if needs_member
            && let Ok(Ok(response)) = timeout(
                Duration::from_secs(5),
                self.shared
                    .http
                    .guild_member(Id::new(self.id), Id::new(self.shared.bot)),
            )
            .await
            && let Ok(member) = response.model().await
            && let Some(guild) = self.shared.cache.write().unwrap().guilds.get_mut(&self.id)
        {
            guild.member(&member);
        }
        match self.shared.access(self.id, request.user(), None) {
            Ok(channel) if self.channel.is_some_and(|active| active != channel) => {
                request
                    .error(
                        &self.shared.http,
                        "Join the bot's current voice channel before adding music.",
                    )
                    .await
            }
            Ok(_) if self.queue.len() >= self.shared.config.limits.queue => {
                request.error(&self.shared.http, "The queue is full.").await
            }
            Ok(channel) => {
                self.sequence = self.sequence.wrapping_add(1);
                self.pending.push_back(Pending {
                    request,
                    channel,
                    epoch: self.epoch,
                    sequence: self.sequence,
                });
            }
            Err(error) => request.error(&self.shared.http, &error).await,
        }
    }
    async fn commit(&mut self, pending: Pending, resolution: Result<Resolution, Failure>) {
        let request = pending.request;
        if pending.epoch != self.epoch {
            request
                .error(
                    &self.shared.http,
                    "That play request was canceled by a newer stop or disconnect.",
                )
                .await;
            return;
        }
        let mut resolution = match resolution {
            Ok(value) => value,
            Err(error) => {
                request
                    .error(&self.shared.http, failure_message(error))
                    .await;
                return;
            }
        };
        if let Err(error) = self
            .shared
            .access(self.id, request.user(), Some(pending.channel))
        {
            request.error(&self.shared.http, &error).await;
            return;
        }
        if self.channel.is_some_and(|active| active != pending.channel) {
            request
                .error(
                    &self.shared.http,
                    "Join the bot's current voice channel before adding music.",
                )
                .await;
            return;
        }
        if self.queue.len() >= self.shared.config.limits.queue {
            request.error(&self.shared.http, "The queue is full.").await;
            return;
        }
        if self.channel.is_none() && self.join(pending.channel).await.is_err() {
            self.cleanup(None).await;
            request
                .error(
                    &self.shared.http,
                    "I could not join that voice channel. Check its permissions and try again.",
                )
                .await;
            return;
        }
        if let Err(error) = self
            .shared
            .access(self.id, request.user(), Some(pending.channel))
        {
            request.error(&self.shared.http, &error).await;
            return;
        }
        let label = request.label();
        for track in &mut resolution.tracks {
            track.requester_id = request.user().to_string();
            track.requested_by.clone_from(&label);
        }
        let Some(first) = resolution.tracks.first().cloned() else {
            return;
        };
        let started = self.queue.current.is_none();
        let resolved_count = resolution.tracks.len();
        let added = self
            .queue
            .enqueue(resolution.tracks, self.shared.config.limits.queue);
        if added == 0 {
            request.error(&self.shared.http, "The queue is full.").await;
            return;
        }
        let omitted = resolution.omitted + resolved_count - added;
        self.notification = request.channel();
        self.idle_at = None;
        self.events[0] = self.events[0].saturating_add(1);
        if started {
            if self.start_current().await.is_err() {
                request
                    .error(
                        &self.shared.http,
                        "I joined, but Lavalink could not start that track.",
                    )
                    .await;
                return;
            }
            let mut notes = vec![];
            if added > 1 {
                notes.push(format!(
                    "Queued {} more{}.",
                    added - 1,
                    resolution
                        .playlist
                        .as_ref()
                        .map(|p| format!(" from **{}**", views::safe(p, 120)))
                        .unwrap_or_default()
                ));
            }
            if omitted > 0 {
                notes.push(format!("{omitted} tracks were omitted by queue limits."));
            }
            if resolution.rejected > 0 {
                notes.push(format!(
                    "{} unsuitable tracks were omitted.",
                    resolution.rejected
                ));
            }
            self.present_player(&request, (!notes.is_empty()).then(|| notes.join(" ")))
                .await;
        } else {
            let mut text = if added == 1 {
                format!(
                    "Queued **{}** by **{}** (`{}`).",
                    views::safe(&first.title, 160),
                    views::safe(&first.author, 100),
                    crate::playback::format_duration(first.duration_ms, first.stream)
                )
            } else {
                format!(
                    "Queued {added} tracks{}.",
                    resolution
                        .playlist
                        .map(|p| format!(" from **{}**", views::safe(&p, 120)))
                        .unwrap_or_default()
                )
            };
            let mut notes = vec![];
            if omitted > 0 {
                notes.push(format!("{omitted} omitted by queue limits"));
            }
            if resolution.rejected > 0 {
                notes.push(format!("{} unsuitable", resolution.rejected));
            }
            if !notes.is_empty() {
                text.push_str(&format!(" {}.", notes.join("; ")));
            }
            let _ = request.respond(&self.shared.http, View::text(text)).await;
            self.refresh().await;
        }
        self.update_alone();
    }
    async fn join(&mut self, channel: u64) -> anyhow::Result<()> {
        let mut changed = self.shared.changed.subscribe();
        if let Some(guild) = self.shared.cache.write().unwrap().guilds.get_mut(&self.id) {
            guild.server = None;
        }
        self.shared.gateway.command(&UpdateVoiceState::new(
            Id::new(self.id),
            Some(Id::new(channel)),
            true,
            false,
        ))?;
        let credentials = timeout(Duration::from_secs(10), async {
            loop {
                let credentials = self
                    .shared
                    .cache
                    .read()
                    .unwrap()
                    .guilds
                    .get(&self.id)
                    .and_then(|g| {
                        let voice = g
                            .voices
                            .get(&self.shared.bot)
                            .filter(|v| v.channel == channel)?;
                        Some((voice.session.clone(), g.server.clone()?))
                    });
                if let Some(credentials) = credentials {
                    return Ok::<_, anyhow::Error>(credentials);
                }
                changed.changed().await?;
            }
        })
        .await??;
        self.shared.node.update(self.id, json!({"voice":{"token":credentials.1.token,"endpoint":credentials.1.endpoint,"sessionId":credentials.0,"channelId":channel.to_string()},"volume":self.volume})).await?;
        self.channel = Some(channel);
        self.credentials = Some(credentials);
        self.token = random_token();
        self.idle_at = Some(Instant::now());
        Ok(())
    }
    async fn start_current(&mut self) -> anyhow::Result<()> {
        let mut failed = false;
        loop {
            self.generation = self.generation.wrapping_add(1);
            self.position_ms = 0;
            self.position_at = Instant::now();
            self.started = false;
            self.paused = false;
            self.schedule_end();
            let update = if let Some(track) = &self.queue.current {
                json!({"track":{"encoded":track.encoded,"userData":{"raydioGeneration":self.generation}},"position":0,"paused":false,"volume":self.volume})
            } else {
                json!({"track":{"encoded":null},"paused":false})
            };
            let result = self.shared.node.update(self.id, update).await;
            self.events[1] = self.events[1].saturating_add(1);
            if result.is_ok() {
                self.idle_at = self.queue.current.is_none().then(Instant::now);
                if failed && self.queue.current.is_none() {
                    anyhow::bail!("No queued track could start");
                }
                return Ok(());
            }
            if self.queue.current.is_none() {
                self.idle_at = Some(Instant::now());
                anyhow::bail!("music service could not stop playback");
            }
            failed = true;
            self.events[4] = self.events[4].saturating_add(1);
            self.queue.fail();
            if self.queue.consecutive_failures >= 3 {
                self.notify("Playback stopped after three consecutive track failures. The source may be unhealthy.").await;
            }
        }
    }
    async fn backend(&mut self, payload: Value) {
        if self.channel.is_none() {
            return;
        }
        if payload["op"] == "playerUpdate" {
            self.position_ms = payload["state"]["position"]
                .as_u64()
                .unwrap_or(self.position_ms);
            self.position_at = Instant::now();
            self.connected = payload["state"]["connected"].as_bool().unwrap_or(false);
            return;
        }
        let kind = payload["type"].as_str().unwrap_or("");
        if kind == "WebSocketClosedEvent" {
            self.cleanup(Some(
                "The voice connection closed. Use `/play` to reconnect.",
            ))
            .await;
            return;
        }
        if self.queue.current.is_none()
            || payload["track"]["userData"]["raydioGeneration"].as_u64() != Some(self.generation)
        {
            return;
        }
        match kind {
            "TrackStartEvent" => {
                self.started = true;
                self.position_at = Instant::now();
                self.schedule_end();
                self.events[2] = self.events[2].saturating_add(1);
            }
            "TrackEndEvent" if payload["reason"] == "finished" => {
                self.queue.finish();
                self.events[3] = self.events[3].saturating_add(1);
                let _ = self.start_current().await;
            }
            "TrackEndEvent" if payload["reason"] == "loadFailed" => self.track_failure().await,
            "TrackExceptionEvent" | "TrackStuckEvent" => self.track_failure().await,
            _ => return,
        }
        self.refresh().await;
    }
    async fn track_failure(&mut self) {
        self.events[4] = self.events[4].saturating_add(1);
        self.queue.fail();
        if self.queue.consecutive_failures >= 3 {
            self.notify("Playback stopped after three consecutive track failures. The source may be unhealthy.").await;
        }
        let _ = self.start_current().await;
    }
    fn update_alone(&mut self) {
        let alone = self.channel.is_some_and(|channel| {
            self.shared
                .cache
                .read()
                .unwrap()
                .guilds
                .get(&self.id)
                .is_some_and(|g| g.alone(channel))
        });
        if alone {
            self.alone_at.get_or_insert_with(Instant::now);
        } else {
            self.alone_at = None;
        }
    }
    async fn voice_changed(&mut self) {
        let Some(channel) = self.channel else {
            return;
        };
        let (present, available, voice) = {
            let cache = self.shared.cache.read().unwrap();
            let g = cache.guilds.get(&self.id);
            (
                g.is_some(),
                g.is_some_and(|g| g.available),
                g.and_then(|g| {
                    g.voices
                        .get(&self.shared.bot)
                        .map(|v| (v.clone(), g.server.clone()))
                }),
            )
        };
        if !present {
            self.cleanup(None).await;
            return;
        }
        if !available {
            return;
        }
        let Some((voice, server)) = voice.filter(|(v, _)| v.channel == channel) else {
            self.cleanup(None).await;
            return;
        };
        if let Some(server) = server
            && self.credentials.as_ref() != Some(&(voice.session.clone(), server.clone()))
            && self.shared.node.health().ready
        {
            if self.shared.node.update(self.id, json!({"voice":{"token":server.token,"endpoint":server.endpoint,"sessionId":voice.session,"channelId":channel.to_string()}})).await.is_err() {
                self.cleanup(Some("The voice connection could not be restored. Use `/play` again.")).await;
                return;
            }
            self.credentials = Some((voice.session, server));
        }
        self.update_alone();
    }
    async fn tick(&mut self) {
        self.voice_changed().await;
        if self
            .alone_at
            .is_some_and(|at| at.elapsed().as_secs() >= self.shared.config.alone_seconds)
        {
            self.cleanup(Some(
                "Left the voice channel because no listeners remained.",
            ))
            .await;
            return;
        }
        if self
            .idle_at
            .is_some_and(|at| at.elapsed().as_secs() >= self.shared.config.idle_seconds)
        {
            self.cleanup(Some("Left the voice channel after the queue stayed idle."))
                .await;
            return;
        }
        if self.shared.node.health().ready
            && self.end_deadline.is_some_and(|at| Instant::now() >= at)
        {
            self.events[5] = self.events[5].saturating_add(1);
            self.queue.finish();
            let _ = self.start_current().await;
        }
        self.refresh().await;
    }
    async fn notify(&self, text: &str) {
        if let Some(channel) = self.notification {
            let _ = timeout(
                Duration::from_secs(4),
                self.shared
                    .http
                    .create_message(Id::new(channel))
                    .content(text),
            )
            .await;
        }
    }
    async fn cleanup(&mut self, notification: Option<&str>) {
        self.invalidate().await;
        let active = self.channel.take().is_some();
        self.queue = Queue::default();
        self.token = random_token();
        self.credentials = None;
        self.connected = false;
        self.idle_at = None;
        self.alone_at = None;
        self.started = false;
        self.paused = false;
        self.panel_checks = 0;
        self.end_deadline = None;
        self.volume = self.shared.config.volume;
        let _ = self.shared.gateway.command(&UpdateVoiceState::new(
            Id::new(self.id),
            None,
            true,
            false,
        ));
        let _ = timeout(Duration::from_secs(3), self.shared.node.destroy(self.id)).await;
        self.flush_refresh().await;
        self.refresh().await;
        self.flush_refresh().await;
        if active && let Some(text) = notification {
            self.notify(text).await;
        }
        self.events[6] = self.events[6].saturating_add(1);
    }
    async fn present_player(&mut self, request: &Request, content: Option<String>) {
        self.flush_refresh().await;
        self.panel_checks = 0;
        let token = random_token();
        let mut view = views::player(
            &self.queue,
            &token,
            self.paused,
            self.volume,
            self.position(),
        );
        view.content = content.or(view.content);
        if let Ok(message) = request.respond(&self.shared.http, view.clone()).await
            && self.queue.current.is_some()
        {
            let previous = self.panel.replace(Panel {
                channel: message.channel_id.get(),
                message: message.id.get(),
                token,
                last_view: Some(view),
            });
            if let Some(previous) = previous
                && previous.message != message.id.get()
            {
                let _ = timeout(
                    Duration::from_secs(3),
                    self.shared
                        .http
                        .delete_message(Id::new(previous.channel), Id::new(previous.message)),
                )
                .await;
            }
        }
    }
    async fn refresh(&mut self) {
        if !self.panel_edits.is_empty() || Instant::now() < self.panel_retry {
            return;
        }
        let Some(panel) = &self.panel else {
            return;
        };
        let view = self.player_view();
        let check = self.paused && self.panel_checks > 0 && Instant::now() >= self.panel_check_at;
        if panel.last_view.as_ref() == Some(&view) {
            if check {
                let (channel, message) = (panel.channel, panel.message);
                let shared = self.shared.clone();
                self.panel_checks -= 1;
                self.panel_check_at = Instant::now() + Duration::from_secs(1);
                self.panel_edits.spawn(async move {
                    let result = timeout(Duration::from_secs(3), async {
                        let bytes = shared
                            .http
                            .message(Id::new(channel), Id::new(message))
                            .await?
                            .bytes()
                            .await?;
                        let stored: StoredPanel = serde_json::from_slice(&bytes)?;
                        Ok::<_, anyhow::Error>(
                            stored
                                .embeds
                                .first()
                                .and_then(|e| e.footer.as_ref())
                                .map(|f| f.text.as_str())
                                == view
                                    .embeds
                                    .first()
                                    .and_then(|e| e.footer.as_ref())
                                    .map(|f| f.text.as_str()),
                        )
                    })
                    .await;
                    let outcome = match result {
                        Ok(Ok(true)) => EditOutcome::Delivered,
                        Ok(Ok(false)) => EditOutcome::Stale,
                        _ => EditOutcome::TransientFailure,
                    };
                    PanelEdit {
                        channel,
                        message,
                        view,
                        retire: false,
                        outcome,
                    }
                });
            }
            return;
        }
        let (channel, message) = (panel.channel, panel.message);
        let shared = self.shared.clone();
        let retire = self.queue.current.is_none();
        self.panel_edits.spawn(async move {
            let result = timeout(Duration::from_secs(4), shared
                .http
                .update_message(Id::new(channel), Id::new(message))
                .content(view.content.as_deref())
                .embeds(Some(&view.embeds))
                .components(Some(&view.components))).await;
            let outcome = match result {
                Ok(Ok(response)) => {
                    match timeout(Duration::from_secs(2), response.bytes()).await {
                        Ok(Ok(_)) => EditOutcome::Delivered,
                        _ => EditOutcome::TransientFailure,
                    }
                }
                Ok(Err(error)) if matches!(error.kind(), twilight_http::error::ErrorType::Response { status, .. } if [401, 403, 404].contains(&status.get())) => EditOutcome::TerminalFailure,
                _ => EditOutcome::TransientFailure,
            };
            PanelEdit { channel, message, view, retire, outcome }
        });
    }
    async fn flush_refresh(&mut self) {
        if let Some(result) = self.panel_edits.join_next().await {
            self.finish_refresh(result);
        }
    }
    fn finish_refresh(&mut self, result: Result<PanelEdit, tokio::task::JoinError>) {
        let edit = match result {
            Ok(edit) => edit,
            Err(_) => {
                self.edit_errors = self.edit_errors.saturating_add(1);
                self.panel_retry = Instant::now() + Duration::from_secs(3);
                return;
            }
        };
        if !self
            .panel
            .as_ref()
            .is_some_and(|p| p.channel == edit.channel && p.message == edit.message)
        {
            return;
        }
        match edit.outcome {
            EditOutcome::Stale => {
                self.panel.as_mut().expect("active panel").last_view = None;
            }
            EditOutcome::Delivered => {
                self.panel.as_mut().expect("active panel").last_view = Some(edit.view);
                self.edits = self.edits.saturating_add(1);
                if edit.retire && self.queue.current.is_none() {
                    self.panel = None;
                }
            }
            EditOutcome::TerminalFailure => {
                self.edit_terminal = self.edit_terminal.saturating_add(1);
                self.panel = None;
            }
            EditOutcome::TransientFailure => {
                self.edit_errors = self.edit_errors.saturating_add(1);
                self.panel_retry = Instant::now() + Duration::from_secs(3);
            }
        }
    }
}
fn random_token() -> String {
    format!("{:016x}", rand::random::<u64>())
}
fn failure_message(error: Failure) -> &'static str {
    match error {
        Failure::NoMatch => "No suitable YouTube result was found.",
        Failure::Full => "The queue is full.",
        Failure::Unavailable => "Music service is temporarily unavailable.",
        Failure::Unsupported => "Only YouTube and YouTube Music URLs are supported.",
        Failure::InvalidResponse | Failure::LoadFailed => {
            "YouTube could not load that request. Try another song."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        playback::Track,
        voice::{Guild, Voice},
    };
    use std::collections::HashMap;
    use twilight_model::{channel::Channel, guild::Permissions};

    fn request(name: &str, options: &[(&str, Value)]) -> Request {
        let options: Vec<_> = options.iter().map(|(name, value)| json!({"name":name,"type":if value.is_number() { 4 } else { 3 },"value":value})).collect();
        Request::new(Arc::new(serde_json::from_value(json!({
            "id":"100","application_id":"9","type":2,"token":"fixture-only","version":1,
            "guild_id":"1","channel":{"id":"10","type":0},"authorizing_integration_owners":{},"entitlements":[],
            "member":{"flags":0,"deaf":false,"mute":false,"roles":[],"user":{"id":"2","username":"listener","discriminator":"0001","avatar":null},"permissions":"32"},
            "data":{"id":"30","name":name,"type":1,"options":options}
        })).unwrap()))
    }
    fn track(id: &str) -> Track {
        Track {
            encoded: format!("fake-v1:fixture:{id}"),
            identifier: id.into(),
            title: id.into(),
            author: "Artist".into(),
            duration_ms: 20_000,
            stream: false,
            uri: None,
            requester_id: "2".into(),
            requested_by: "Listener".into(),
        }
    }
    fn guild() -> Guild {
        let channels: Vec<Channel> = [3, 4]
            .into_iter()
            .map(|id| serde_json::from_value(json!({"id":id.to_string(),"type":2})).unwrap())
            .collect();
        Guild {
            available: true,
            owner: 99,
            channels: channels.iter().map(|c| (c.id.get(), c.into())).collect(),
            roles: HashMap::from([(
                1,
                Permissions::VIEW_CHANNEL | Permissions::CONNECT | Permissions::SPEAK,
            )]),
            bot_roles: Some(vec![]),
            voices: HashMap::from([
                (
                    2,
                    Voice {
                        channel: 3,
                        bot: false,
                        session: String::new(),
                    },
                ),
                (
                    9,
                    Voice {
                        channel: 3,
                        bot: true,
                        session: "fixture".into(),
                    },
                ),
            ]),
            ..Default::default()
        }
    }
    #[tokio::test]
    async fn slow_progress_edit_does_not_block_track_restart() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let first = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let router = axum::Router::new().fallback({
            let entered = entered.clone();
            let release = release.clone();
            let calls = calls.clone();
            move || {
                let entered = entered.clone();
                let release = release.clone();
                let first = first.clone();
                calls.fetch_add(1, Ordering::Relaxed);
                async move {
                    if first.swap(false, Ordering::Relaxed) {
                        entered.notify_one();
                        release.notified().await;
                    }
                    axum::Json(json!({}))
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let (mut shared, backend, owner, _events) = Shared::fixture().await;
        Arc::get_mut(&mut shared).unwrap().http = twilight_http::Client::builder()
            .token("fixture".into())
            .proxy(address.to_string(), true)
            .ratelimiter(None)
            .build();
        shared.cache.write().unwrap().guilds.insert(1, guild());
        let mut session = GuildSession::new(1, shared.clone());
        session.channel = Some(3);
        session.queue.enqueue(vec![track("one")], 1000);
        session.queue.loop_mode = LoopMode::Track;
        session.start_current().await.unwrap();
        let generation = session.generation;
        session.panel = Some(Panel {
            channel: 3,
            message: 5,
            token: "panel".into(),
            last_view: None,
        });
        let (messages, receiver) = mpsc::channel(8);
        let actor = tokio::spawn(session.run(receiver));
        timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        let started = Instant::now();
        messages
            .send(Message::Backend(json!({
                "type":"TrackEndEvent", "reason":"finished",
                "track":{"userData":{"raydioGeneration":generation}}
            })))
            .await
            .unwrap();
        let restarted = timeout(Duration::from_secs(1), async {
            loop {
                let player = shared
                    .node
                    .request(
                        reqwest::Method::GET,
                        &format!("/v4/sessions/{}/players/1", shared.node.health().session),
                        &[],
                        None,
                    )
                    .await
                    .unwrap();
                if player["track"]["userData"]["raydioGeneration"] == generation + 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let elapsed = started.elapsed();
        let requests_while_blocked = calls.load(Ordering::Relaxed);
        release.notify_one();
        shared.cancel.cancel();
        timeout(Duration::from_secs(5), actor)
            .await
            .unwrap()
            .unwrap();
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
        server.abort();
        let _ = server.await;
        eprintln!(
            "track restart while Discord edit pending: {elapsed:?}, success={}",
            restarted.is_ok()
        );
        assert!(
            restarted.is_ok(),
            "track restart waited for a Discord progress edit"
        );
        assert_eq!(
            requests_while_blocked, 1,
            "progress edits must stay single-flight"
        );
    }
    #[tokio::test]
    async fn stop_button_retires_panel_before_periodic_refresh() {
        let (shared, backend, owner, _events) = Shared::fixture().await;
        shared.cache.write().unwrap().guilds.insert(1, guild());
        let mut session = GuildSession::new(1, shared);
        session.channel = Some(3);
        session.queue.enqueue(vec![track("one")], 1000);
        session.start_current().await.unwrap();
        let mut button = request("stop", &[]);
        button.custom_id = Some("raydio:player:panel:stop".into());
        let interaction = Arc::make_mut(&mut button.interaction);
        interaction.message = Some(serde_json::from_value(json!({
            "id":"5","channel_id":"3","author":{"id":"9","username":"fixture","discriminator":"0001","avatar":null},
            "content":"panel","timestamp":"2026-09-05T00:00:00+00:00","edited_timestamp":null,
            "tts":false,"mention_everyone":false,"mentions":[],"mention_roles":[],"attachments":[],"embeds":[],"pinned":false,"type":0
        })).unwrap());
        session.panel = Some(Panel {
            channel: 3,
            message: 5,
            token: "panel".into(),
            last_view: None,
        });
        session.interaction(button).await;
        assert!(session.panel.is_none());
        assert!(session.queue.is_empty());
        assert_eq!(
            session.edit_errors, 0,
            "periodic edit must not overwrite terminal button text"
        );
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn pause_button_applies_audio_before_progress_finishes_and_edits_in_order() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let paths = Arc::new(std::sync::Mutex::new(Vec::new()));
        let bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let observed_paths = paths.clone();
        let observed = calls.clone();
        let observed_bodies = bodies.clone();
        let wait_entered = entered.clone();
        let wait_release = release.clone();
        let router = axum::Router::new().fallback(
            move |uri: axum::http::Uri, axum::Json(body): axum::Json<Value>| {
                let index = observed.fetch_add(1, Ordering::Relaxed);
                observed_paths.lock().unwrap().push(uri.path().to_owned());
                observed_bodies.lock().unwrap().push(body);
                let entered = wait_entered.clone();
                let release = wait_release.clone();
                async move {
                    if index == 0 {
                        entered.notify_one();
                        release.notified().await;
                    }
                    // No valid Message model: successful edits only drain bytes.
                    axum::Json(json!({}))
                }
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let (mut shared, backend, owner, _events) = Shared::fixture().await;
        Arc::get_mut(&mut shared).unwrap().http = twilight_http::Client::builder()
            .token("fixture".into())
            .proxy(address.to_string(), true)
            .ratelimiter(None)
            .build();
        shared.cache.write().unwrap().guilds.insert(1, guild());
        let mut session = GuildSession::new(1, shared.clone());
        session.channel = Some(3);
        session.queue.enqueue(vec![track("one")], 1000);
        session.start_current().await.unwrap();
        let mut button = request("pause", &[]);
        button.custom_id = Some("raydio:player:panel:pause".into());
        Arc::make_mut(&mut button.interaction).message = Some(serde_json::from_value(json!({
            "id":"5","channel_id":"3","author":{"id":"9","username":"fixture","discriminator":"0001","avatar":null},
            "content":"panel","timestamp":"2026-09-05T00:00:00+00:00","edited_timestamp":null,
            "tts":false,"mention_everyone":false,"mentions":[],"mention_roles":[],"attachments":[],"embeds":[],"pinned":false,"type":0
        })).unwrap());
        session.panel = Some(Panel {
            channel: 3,
            message: 5,
            token: "panel".into(),
            last_view: None,
        });
        session.refresh().await;
        timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        let control = tokio::spawn(async move {
            session.interaction(button).await;
            session
        });
        let paused_before_edit_finished = timeout(Duration::from_secs(1), async {
            loop {
                let player = shared
                    .node
                    .request(
                        reqwest::Method::GET,
                        &format!("/v4/sessions/{}/players/1", shared.node.health().session),
                        &[],
                        None,
                    )
                    .await
                    .unwrap();
                if player["paused"] == true {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let requests_while_blocked = calls.load(Ordering::Relaxed);
        release.notify_one();
        let mut session = timeout(Duration::from_secs(3), control)
            .await
            .unwrap()
            .unwrap();
        assert!(session.paused);
        assert!(paused_before_edit_finished.is_ok());
        assert_eq!(requests_while_blocked, 1);
        assert_eq!(
            calls.load(Ordering::Relaxed),
            2,
            "one progress edit and one control edit"
        );
        assert!(
            paths
                .lock()
                .unwrap()
                .iter()
                .all(|p| p.ends_with("/channels/3/messages/5"))
        );
        {
            let bodies = bodies.lock().unwrap();
            assert!(
                bodies[0]["embeds"][0]["footer"]["text"]
                    .as_str()
                    .unwrap()
                    .starts_with("Playing")
            );
            assert!(
                bodies[1]["embeds"][0]["footer"]["text"]
                    .as_str()
                    .unwrap()
                    .starts_with("Paused")
            );
        }
        assert_eq!(
            session.panel.as_ref().unwrap().last_view.as_ref(),
            Some(&session.player_view())
        );
        session.refresh().await;
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
        server.abort();
        let _ = server.await;
    }
    #[tokio::test]
    async fn paused_panel_reconciliation_corrects_stale_state_and_stops_polling() {
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stored = Arc::new(std::sync::Mutex::new("Playing".to_owned()));
        let router = axum::Router::new().fallback({
            let reads = reads.clone();
            let writes = writes.clone();
            let stored = stored.clone();
            move |method: axum::http::Method| {
                let text = if method == axum::http::Method::GET {
                    reads.fetch_add(1, Ordering::Relaxed);
                    stored.lock().unwrap().clone()
                } else {
                    writes.fetch_add(1, Ordering::Relaxed);
                    *stored.lock().unwrap() = "Paused • Loop: OFF • refreshes every second".into();
                    stored.lock().unwrap().clone()
                };
                async move { axum::Json(json!({"embeds":[{"footer":{"text":text}}]})) }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let (mut shared, backend, owner, _events) = Shared::fixture().await;
        Arc::get_mut(&mut shared).unwrap().http = twilight_http::Client::builder()
            .token("fixture".into())
            .proxy(address.to_string(), true)
            .ratelimiter(None)
            .build();
        let mut session = GuildSession::new(1, shared);
        session.queue.enqueue(vec![track("one")], 1000);
        session.paused = true;
        session.panel = Some(Panel {
            channel: 3,
            message: 5,
            token: "panel".into(),
            last_view: None,
        });
        session.panel.as_mut().unwrap().last_view = Some(session.player_view());
        session.panel_checks = 3;
        for _ in 0..8 {
            session.panel_check_at = Instant::now();
            session.refresh().await;
            session.flush_refresh().await;
        }
        assert_eq!(
            reads.load(Ordering::Relaxed),
            3,
            "reconciliation must stop after its bounded checks"
        );
        assert_eq!(
            writes.load(Ordering::Relaxed),
            1,
            "only a stale stored snapshot needs a corrective edit"
        );
        assert_eq!(session.panel_checks, 0);
        assert!(stored.lock().unwrap().starts_with("Paused"));
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
        server.abort();
        let _ = server.await;
    }
    #[tokio::test]
    async fn unchanged_panels_skip_http_and_single_page_queue_retires_buttons() {
        let (shared, backend, owner, _events) = Shared::fixture().await;
        let mut session = GuildSession::new(1, shared);
        session.queue.enqueue(vec![track("one"); 12], 1000);
        session.paused = true;
        session.panel = Some(Panel {
            channel: 3,
            message: 5,
            token: "panel".into(),
            last_view: None,
        });
        let view = session.player_view();
        session.panel.as_mut().unwrap().last_view = Some(view);
        session.refresh().await;
        assert_eq!(
            session.edit_errors, 0,
            "unchanged content must not contact the deliberately unavailable HTTP fixture"
        );
        session.volume = 37;
        session.refresh().await;
        session.flush_refresh().await;
        assert_eq!(
            session.edit_errors, 1,
            "a real content change must attempt delivery"
        );
        assert!(!session.queue_view(0).components.is_empty());
        let previous_token = session.token.clone();
        session.queue.upcoming.truncate(10);
        assert!(session.queue_view(0).components.is_empty());
        assert_ne!(session.token, previous_token);
        session.queue.enqueue(vec![track("two"); 2], 1000);
        assert!(!session.queue_view(0).components.is_empty());
        assert_ne!(
            session.token, previous_token,
            "old controls cannot become active again"
        );
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn controls_recheck_voice_and_apply_real_backend_volume() {
        let (shared, backend, owner, _events) = Shared::fixture().await;
        shared.cache.write().unwrap().guilds.insert(1, guild());
        let mut session = GuildSession::new(1, shared.clone());
        session.channel = Some(3);
        session
            .queue
            .enqueue(vec![track("one"), track("two")], 1000);
        assert_eq!(
            session
                .control(&request("volume", &[("level", json!(37))]))
                .await
                .unwrap(),
            "Volume set to 37%."
        );
        let player = shared
            .node
            .request(
                reqwest::Method::GET,
                &format!("/v4/sessions/{}/players/1", shared.node.health().session),
                &[],
                None,
            )
            .await
            .unwrap();
        assert_eq!(player["volume"], 37);
        shared
            .cache
            .write()
            .unwrap()
            .guilds
            .get_mut(&1)
            .unwrap()
            .voices
            .get_mut(&2)
            .unwrap()
            .channel = 4;
        assert!(
            session
                .control(&request("clear", &[]))
                .await
                .unwrap_err()
                .contains("current voice channel")
        );
        assert_eq!(session.queue.upcoming.len(), 1);
        shared
            .cache
            .write()
            .unwrap()
            .guilds
            .get_mut(&1)
            .unwrap()
            .voices
            .get_mut(&2)
            .unwrap()
            .channel = 3;
        assert_eq!(
            session.control(&request("clear", &[])).await.unwrap(),
            "Cleared 1 upcoming track."
        );
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn stop_cancels_inflight_and_waiting_plays_and_stale_completion_cannot_enqueue() {
        let (shared, backend, owner, _events) = Shared::fixture().await;
        shared.cache.write().unwrap().guilds.insert(1, guild());
        let mut session = GuildSession::new(1, shared);
        session.channel = Some(3);
        session.loading = Some(Pending {
            request: request("play", &[("request", json!("one"))]),
            channel: 3,
            epoch: 0,
            sequence: 1,
        });
        session.pending.push_back(Pending {
            request: request("play", &[("request", json!("two"))]),
            channel: 3,
            epoch: 0,
            sequence: 2,
        });
        session.loaders.spawn(async {
            std::future::pending::<()>().await;
            (1, Err(Failure::Unavailable))
        });
        session.control(&request("stop", &[])).await.unwrap();
        assert_eq!(session.epoch, 1);
        assert!(session.loading.is_none());
        assert!(session.pending.is_empty());
        let stale = Pending {
            request: request("play", &[]),
            channel: 3,
            epoch: 0,
            sequence: 1,
        };
        session
            .commit(
                stale,
                Ok(Resolution {
                    tracks: vec![track("old")],
                    playlist: None,
                    rejected: 0,
                    omitted: 0,
                }),
            )
            .await;
        assert!(session.queue.is_empty());
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn delayed_load_rechecks_caller_voice_before_committing() {
        let (shared, backend, owner, _events) = Shared::fixture().await;
        let mut g = guild();
        g.voices.get_mut(&2).unwrap().channel = 4;
        shared.cache.write().unwrap().guilds.insert(1, g);
        let mut session = GuildSession::new(1, shared);
        session.channel = Some(3);
        let pending = Pending {
            request: request("play", &[]),
            channel: 3,
            epoch: 0,
            sequence: 1,
        };
        session
            .commit(
                pending,
                Ok(Resolution {
                    tracks: vec![track("old")],
                    playlist: None,
                    rejected: 0,
                    omitted: 0,
                }),
            )
            .await;
        assert!(session.queue.is_empty());
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn stale_track_events_cannot_advance_a_repeated_encoded_track() {
        let (shared, backend, owner, _events) = Shared::fixture().await;
        let mut session = GuildSession::new(1, shared);
        session.channel = Some(3);
        session.generation = 2;
        session
            .queue
            .enqueue(vec![track("same"), track("next")], 1000);
        for kind in ["TrackEndEvent", "TrackExceptionEvent", "TrackStuckEvent"] {
            session.backend(json!({"type":kind,"reason":"finished","track":{"encoded":"same","userData":{"raydioGeneration":1}}})).await;
        }
        assert_eq!(session.queue.current.as_ref().unwrap().identifier, "same");
        assert_eq!(session.queue.upcoming.len(), 1);
        assert_eq!(session.queue.consecutive_failures, 0);
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn queue_controls_drive_crust_and_cleanup_preserves_voice_rules() {
        let (shared, backend, owner, _events) = Shared::fixture().await;
        shared.cache.write().unwrap().guilds.insert(1, guild());
        let mut session = GuildSession::new(1, shared.clone());
        session.channel = Some(3);
        session.queue.enqueue(
            vec![track("one"), track("two"), track("three"), track("four")],
            1000,
        );
        session.start_current().await.unwrap();
        assert_eq!(
            session.control(&request("pause", &[])).await.unwrap(),
            "Playback paused."
        );
        let path = format!("/v4/sessions/{}/players/1", shared.node.health().session);
        let player = shared
            .node
            .request(reqwest::Method::GET, &path, &[], None)
            .await
            .unwrap();
        assert_eq!(player["paused"], true);
        assert_eq!(
            session.control(&request("resume", &[])).await.unwrap(),
            "Playback resumed."
        );
        session
            .control(&request("loop", &[("mode", json!("queue"))]))
            .await
            .unwrap();
        session
            .control(&request("move", &[("from", json!(1)), ("to", json!(3))]))
            .await
            .unwrap();
        assert_eq!(
            session
                .queue
                .upcoming
                .iter()
                .map(|t| t.identifier.as_str())
                .collect::<Vec<_>>(),
            ["three", "four", "two"]
        );
        session
            .control(&request("jump", &[("position", json!(2))]))
            .await
            .unwrap();
        assert_eq!(session.queue.current.as_ref().unwrap().identifier, "four");
        session.control(&request("previous", &[])).await.unwrap();
        assert_eq!(session.queue.current.as_ref().unwrap().identifier, "one");
        session
            .control(&request("remove", &[("position", json!(2))]))
            .await
            .unwrap();
        session.control(&request("shuffle", &[])).await.unwrap();
        assert_eq!(session.queue.upcoming.len(), 2);
        session.control(&request("skip", &[])).await.unwrap();
        let player = shared
            .node
            .request(reqwest::Method::GET, &path, &[], None)
            .await
            .unwrap();
        assert_eq!(
            player["track"]["encoded"],
            session.queue.current.as_ref().unwrap().encoded
        );
        session.control(&request("stop", &[])).await.unwrap();
        assert!(session.queue.is_empty());
        assert_eq!(session.channel, Some(3));
        let player = shared
            .node
            .request(reqwest::Method::GET, &path, &[], None)
            .await
            .unwrap();
        assert!(player["track"].is_null());
        session.control(&request("leave", &[])).await.unwrap();
        assert!(session.channel.is_none());
        assert!(
            shared
                .node
                .request(reqwest::Method::GET, &path, &[], None)
                .await
                .is_err()
        );
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn idle_alone_and_end_deadlines_cleanup_or_advance() {
        let (shared, backend, owner, _events) = Shared::fixture().await;
        shared.cache.write().unwrap().guilds.insert(1, guild());
        let mut session = GuildSession::new(1, shared.clone());
        session.channel = Some(3);
        session.idle_at = Some(Instant::now() - Duration::from_secs(121));
        session.tick().await;
        assert!(session.channel.is_none());
        session.channel = Some(3);
        session
            .queue
            .enqueue(vec![track("one"), track("two")], 1000);
        session.start_current().await.unwrap();
        session.end_deadline = Some(Instant::now() - Duration::from_secs(1));
        session.tick().await;
        assert_eq!(session.queue.current.as_ref().unwrap().identifier, "two");
        shared
            .cache
            .write()
            .unwrap()
            .guilds
            .get_mut(&1)
            .unwrap()
            .voices
            .remove(&2);
        session.alone_at = Some(Instant::now() - Duration::from_secs(121));
        session.tick().await;
        assert!(session.channel.is_none());
        assert!(session.queue.is_empty());
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn synchronous_start_failures_skip_bad_tracks_and_stop_after_three() {
        let (shared, backend, owner, _events) = Shared::fixture().await;
        let mut session = GuildSession::new(1, shared);
        session.channel = Some(3);
        let mut bad = track("bad");
        bad.encoded = "invalid".into();
        session
            .queue
            .enqueue(vec![bad.clone(), track("good")], 1000);
        session.start_current().await.unwrap();
        assert_eq!(session.queue.current.as_ref().unwrap().identifier, "good");
        session.queue.stop();
        session
            .queue
            .enqueue(vec![bad.clone(), bad.clone(), bad, track("never")], 1000);
        assert!(session.start_current().await.is_err());
        assert!(session.queue.is_empty());
        assert_eq!(session.queue.consecutive_failures, 3);
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn paused_time_does_not_consume_the_end_watchdog() {
        let (shared, backend, owner, _events) = Shared::fixture().await;
        let mut session = GuildSession::new(1, shared);
        session.queue.enqueue(vec![track("one")], 1000);
        session.position_ms = 5_000;
        session.paused = true;
        session.schedule_end();
        assert!(session.end_deadline.is_none());
        session.paused = false;
        session.schedule_end();
        let remaining = session
            .end_deadline
            .unwrap()
            .duration_since(Instant::now())
            .as_secs();
        assert!((29..=30).contains(&remaining));
        session.queue.current.as_mut().unwrap().stream = true;
        session.schedule_end();
        assert!(session.end_deadline.is_none());
        owner.shutdown().await;
        backend.shutdown().await.unwrap();
    }
}
