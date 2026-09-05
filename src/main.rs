use anyhow::{Context, Result, bail};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, env, sync::Arc};
use tokio::sync::Mutex;
use twilight_gateway::{
    Event, EventTypeFlags, Intents, MessageSender, Shard, StreamExt as GatewayStreamExt,
};
use twilight_model::{
    application::interaction::{Interaction, InteractionData},
    gateway::payload::outgoing::UpdateVoiceState,
    id::{
        Id,
        marker::{ApplicationMarker, ChannelMarker, GuildMarker, UserMarker},
    },
};

const DISCORD: &str = "https://discord.com/api/v10";
const CRUST: &str = "http://127.0.0.1:2333";

#[derive(Clone, Debug, Deserialize)]
struct TrackInfo {
    identifier: String,
    title: String,
    author: String,
    length: u64,
    #[serde(default)]
    is_stream: bool,
    #[serde(default)]
    uri: Option<String>,
    #[serde(default)]
    source_name: String,
}
#[derive(Clone, Debug, Deserialize)]
struct Track {
    encoded: String,
    info: TrackInfo,
}
#[derive(Clone, Debug, Deserialize)]
struct LoadResult {
    load_type: String,
    #[serde(default)]
    data: Value,
}

#[derive(Clone, Debug)]
struct Item {
    encoded: String,
    title: String,
    author: String,
    length: u64,
    uri: Option<String>,
}
struct Guild {
    channel: Id<ChannelMarker>,
    text: Id<ChannelMarker>,
    current: Option<Item>,
    queue: Vec<Item>,
    volume: u64,
    paused: bool,
    voice: Option<Voice>,
    history: Vec<Item>,
    loop_mode: LoopMode,
}
impl Guild {
    fn new(text: Id<ChannelMarker>) -> Self {
        Self {
            channel: Id::new(0),
            text,
            current: None,
            queue: Vec::new(),
            volume: 70,
            paused: false,
            voice: None,
            history: Vec::new(),
            loop_mode: LoopMode::Off,
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LoopMode {
    Off,
    Track,
    Queue,
}
#[derive(Clone, Debug)]
struct Voice {
    token: String,
    endpoint: String,
    session_id: String,
}
#[derive(Default)]
struct State {
    guilds: HashMap<Id<GuildMarker>, Guild>,
    voice_sessions: HashMap<Id<UserMarker>, (Id<GuildMarker>, Option<Id<ChannelMarker>>, String)>,
    bot_voice: HashMap<Id<GuildMarker>, Voice>,
    bot_user_id: Option<u64>,
}

#[derive(Clone)]
struct App {
    http: Client,
    token: Arc<str>,
    crust_password: Arc<str>,
    crust: Arc<str>,
    state: Arc<Mutex<State>>,
    application: Arc<Mutex<Option<Id<ApplicationMarker>>>>,
}

fn option_i64(
    data: &twilight_model::application::interaction::application_command::CommandData,
    name: &str,
) -> Option<i64> {
    data.options.iter().find(|o| o.name == name).and_then(|o| match o.value { twilight_model::application::interaction::application_command::CommandOptionValue::Integer(v) => Some(v), _ => None })
}

impl App {
    async fn discord(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let mut r = self
            .http
            .request(method, format!("{DISCORD}{path}"))
            .bearer_auth(self.token.as_ref());
        if let Some(b) = body {
            r = r.json(&b);
        }
        let x = r.send().await?;
        let status = x.status();
        let text = x.text().await?;
        if !status.is_success() {
            bail!("Discord {}: {}", status, text);
        }
        if text.is_empty() {
            Ok(Value::Null)
        } else {
            Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
        }
    }
    async fn crust(&self, method: reqwest::Method, path: &str, body: Value) -> Result<Value> {
        let x = self
            .http
            .request(method, format!("{}{}", self.crust, path))
            .header("Authorization", self.crust_password.as_ref())
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;
        let status = x.status();
        let text = x.text().await?;
        if !status.is_success() {
            bail!("Crust {}: {}", status, text)
        };
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }
    async fn respond(&self, id: &str, token: &str, content: String) -> Result<()> {
        self.http
            .post(format!("{DISCORD}/interactions/{id}/{token}/callback"))
            .json(&json!({"type":4,"data":{"content":content,"allowed_mentions":{"parse":[]}}}))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
    async fn commands(&self) -> Result<()> {
        let app = self
            .application
            .lock()
            .await
            .context("application id unavailable")?
            .to_string();
        let names = [
            ("play", "Play a YouTube song or playlist"),
            ("nowplaying", "Show the current song"),
            ("queue", "Show the queue"),
            ("pause", "Pause playback"),
            ("resume", "Resume playback"),
            ("skip", "Skip the current song"),
            ("stop", "Stop playback"),
            ("clear", "Clear the queue"),
            ("shuffle", "Shuffle the queue"),
            ("leave", "Leave voice"),
            ("ping", "Check readiness"),
            ("help", "Show commands"),
        ];
        let body: Vec<Value> = names.iter().map(|(name,description)| {
            let mut x=json!({"name":name,"description":description,"type":1});
            match *name {
                "play" => x["options"]=json!([{"name":"request","description":"Search or YouTube URL","type":3,"required":true}]),
                "volume" => x["options"]=json!([{"name":"level","description":"Volume from 0 to 100","type":4,"required":false,"min_value":0,"max_value":100}]),
                "loop" => x["options"]=json!([{"name":"mode","description":"off, track, or queue","type":3,"required":true,"choices":[{"name":"Off","value":"off"},{"name":"Current song","value":"track"},{"name":"Entire queue","value":"queue"}]}]),
                "remove"|"jump" => x["options"]=json!([{"name":"position","description":"Upcoming queue position","type":4,"required":true,"min_value":1}]),
                "move" => x["options"]=json!([{"name":"from","description":"Current queue position","type":4,"required":true,"min_value":1},{"name":"to","description":"New queue position","type":4,"required":true,"min_value":1}]),
                _ => {}
            }
            x
        }).collect();
        self.discord(
            reqwest::Method::PUT,
            &format!("/applications/{app}/commands"),
            Some(Value::Array(body)),
        )
        .await?;
        Ok(())
    }
    async fn play(
        &self,
        guild: Id<GuildMarker>,
        text: Id<ChannelMarker>,
        requester: &str,
        input: &str,
    ) -> Result<String> {
        let encoded = if input.starts_with("http://") || input.starts_with("https://") {
            input.to_string()
        } else {
            format!("ytmsearch:{input}")
        };
        let load = self
            .crust(
                reqwest::Method::GET,
                &format!(
                    "/v4/loadtracks?identifier={}",
                    urlencoding::encode(&encoded)
                ),
                Value::Null,
            )
            .await?;
        let tracks: Vec<Track> = if load["loadType"] == "track" {
            vec![serde_json::from_value(load["data"].clone())?]
        } else if load["loadType"] == "search" {
            serde_json::from_value(load["data"].clone())?
        } else if load["loadType"] == "playlist" {
            serde_json::from_value(load["data"]["tracks"].clone())?
        } else {
            vec![]
        };
        if tracks.is_empty() {
            return Ok("No suitable YouTube result was found.".into());
        }
        let mut s = self.state.lock().await;
        let g = s.guilds.entry(guild).or_insert_with(|| Guild::new(text));
        let items = tracks
            .into_iter()
            .take(250)
            .map(|t| Item {
                encoded: t.encoded,
                title: t.info.title,
                author: t.info.author,
                length: t.info.length,
                uri: t.info.uri,
            })
            .collect::<Vec<_>>();
        let first = items[0].clone();
        let idle = g.current.is_none();
        if idle {
            g.current = Some(first.clone())
        }
        g.queue.extend(items.into_iter().skip(usize::from(!idle)));
        drop(s);
        if idle {
            self.set_player(guild, first.encoded.clone(), false).await?;
            Ok(format!(
                "Playing **{}** by **{}**.",
                first.title, first.author
            ))
        } else {
            Ok(format!(
                "Queued **{}** by **{}**.",
                first.title, first.author
            ))
        }
    }
    async fn set_player(
        &self,
        guild: Id<GuildMarker>,
        encoded: String,
        no_replace: bool,
    ) -> Result<()> {
        let session = format!("raydio-{guild}");
        let voice = self
            .state
            .lock()
            .await
            .bot_voice
            .get(&guild)
            .cloned()
            .context("voice state not ready")?;
        if voice.session_id.is_empty() {
            bail!("voice session is still negotiating")
        }
        self.crust(reqwest::Method::PATCH,&format!("/v4/sessions/{session}/players/{guild}?noReplace={no_replace}"),json!({"encodedTrack":encoded,"volume":70,"voice":{"token":voice.token,"endpoint":voice.endpoint,"sessionId":voice.session_id}})).await?;
        Ok(())
    }
    async fn handle(&self, i: Interaction, sender: MessageSender) -> Result<()> {
        let id = i.id.to_string();
        let token = i.token.clone();
        let Some(ref data) = i.data else {
            return Ok(());
        };
        let InteractionData::ApplicationCommand(c) = data else {
            return Ok(());
        };
        let guild = i.guild_id.context("DM unsupported")?;
        let text = i
            .channel
            .as_ref()
            .map(|c| c.id)
            .or(i.channel_id)
            .context("missing channel")?;
        let opt=c.options.iter().find(|o|o.name=="request").and_then(|o|match &o.value {twilight_model::application::interaction::application_command::CommandOptionValue::String(s)=>Some(s.as_str()), _=>None});
        let result = match c.name.as_str() {
            "play" => {
                let user = i.author_id().context("missing user")?;
                let channel = self
                    .state
                    .lock()
                    .await
                    .voice_sessions
                    .get(&user)
                    .and_then(|(_, c, _)| *c)
                    .context("Join a voice channel before using /play")?;
                sender.command(&UpdateVoiceState::new(guild, Some(channel), true, false))?;
                for _ in 0..50 {
                    if self
                        .state
                        .lock()
                        .await
                        .bot_voice
                        .get(&guild)
                        .is_some_and(|v| !v.session_id.is_empty())
                    {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                self.play(guild, text, "user", opt.context("request required")?)
                    .await?
            }
            "ping" => "Pong!".into(),
            "help" => {
                "/play /nowplaying /queue /pause /resume /skip /stop /clear /shuffle /leave /ping"
                    .into()
            }
            "queue" => {
                let s = self.state.lock().await;
                match s.guilds.get(&guild) {
                    Some(g) => format!(
                        "Now playing: {}\nUpcoming: {}",
                        g.current
                            .as_ref()
                            .map(|x| x.title.as_str())
                            .unwrap_or("nothing"),
                        g.queue.len()
                    ),
                    None => "The queue is empty.".into(),
                }
            }
            "volume" => {
                let value = c.options.iter().find(|o| o.name == "level").and_then(|o| match o.value { twilight_model::application::interaction::application_command::CommandOptionValue::Integer(v) => Some(v.clamp(0,100) as u64), _ => None });
                let Some(volume) = value else {
                    let s = self.state.lock().await;
                    return self
                        .respond(
                            &id,
                            &token,
                            s.guilds
                                .get(&guild)
                                .map(|g| format!("Current volume: {}%.", g.volume))
                                .unwrap_or_else(|| "There is no active music session.".into()),
                        )
                        .await;
                };
                self.crust(
                    reqwest::Method::PATCH,
                    &format!("/v4/sessions/raydio-{guild}/players/{guild}"),
                    json!({"volume":volume}),
                )
                .await?;
                if let Some(g) = self.state.lock().await.guilds.get_mut(&guild) {
                    g.volume = volume;
                }
                format!("Volume set to {volume}%.")
            }
            "pause" => {
                self.crust(
                    reqwest::Method::PATCH,
                    &format!("/v4/sessions/raydio-{guild}/players/{guild}"),
                    json!({"paused":true}),
                )
                .await?;
                "Playback paused.".into()
            }
            "resume" => {
                self.crust(
                    reqwest::Method::PATCH,
                    &format!("/v4/sessions/raydio-{guild}/players/{guild}"),
                    json!({"paused":false}),
                )
                .await?;
                "Playback resumed.".into()
            }
            "clear" => {
                let n = self
                    .state
                    .lock()
                    .await
                    .guilds
                    .get_mut(&guild)
                    .map(|g| {
                        let n = g.queue.len();
                        g.queue.clear();
                        n
                    })
                    .unwrap_or(0);
                format!("Cleared {n} upcoming tracks.")
            }
            "shuffle" => {
                if let Some(g) = self.state.lock().await.guilds.get_mut(&guild) {
                    use rand::seq::SliceRandom;
                    g.queue.shuffle(&mut rand::thread_rng());
                }
                "Shuffled the upcoming queue.".into()
            }
            "remove" => {
                let p = option_i64(c, "position").unwrap_or(0).saturating_sub(1) as usize;
                let x = self
                    .state
                    .lock()
                    .await
                    .guilds
                    .get_mut(&guild)
                    .and_then(|g| {
                        if p < g.queue.len() {
                            Some(g.queue.remove(p))
                        } else {
                            None
                        }
                    });
                x.map(|t| format!("Removed **{}**.", t.title))
                    .unwrap_or_else(|| "There is no upcoming track at that index.".into())
            }
            "move" => {
                let from = option_i64(c, "from").unwrap_or(0).saturating_sub(1) as usize;
                let to = option_i64(c, "to").unwrap_or(0).saturating_sub(1) as usize;
                let changed = self
                    .state
                    .lock()
                    .await
                    .guilds
                    .get_mut(&guild)
                    .and_then(|g| {
                        if from < g.queue.len() && to < g.queue.len() {
                            let x = g.queue.remove(from);
                            let title = x.title.clone();
                            g.queue.insert(to, x);
                            Some(title)
                        } else {
                            None
                        }
                    });
                changed
                    .map(|t| format!("Moved **{t}**."))
                    .unwrap_or_else(|| "One of those queue positions does not exist.".into())
            }
            "leave" => {
                self.crust(
                    reqwest::Method::DELETE,
                    &format!("/v4/sessions/raydio-{guild}/players/{guild}"),
                    Value::Null,
                )
                .await
                .ok();
                self.state.lock().await.guilds.remove(&guild);
                sender.command(&UpdateVoiceState::new(
                    guild,
                    None::<Id<ChannelMarker>>,
                    true,
                    false,
                ))?;
                "Disconnected and cleared the session.".into()
            }
            "stop" => {
                self.crust(
                    reqwest::Method::DELETE,
                    &format!("/v4/sessions/raydio-{guild}/players/{guild}"),
                    Value::Null,
                )
                .await?;
                self.state.lock().await.guilds.remove(&guild);
                "Playback stopped.".into()
            }
            _ => "That command is not implemented yet.".into(),
        };
        self.respond(&id, &token, result).await?;
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt().with_env_filter("info").init();
    let token = env::var("DISCORD_TOKEN_TESTBOT")
        .or_else(|_| env::var("DISCORD_TOKEN"))
        .context("DISCORD_TOKEN_TESTBOT or DISCORD_TOKEN is required")?;
    let intents = Intents::GUILDS | Intents::GUILD_VOICE_STATES;
    let mut shard = Shard::new(
        twilight_model::gateway::ShardId::ONE,
        token.clone(),
        intents,
    );
    let app = App {
        http: Client::new(),
        token: Arc::from(token),
        crust_password: Arc::from(env::var("LAVALINK_PASSWORD").unwrap_or_default()),
        crust: Arc::from(env::var("CRUST_URL").unwrap_or_else(|_| CRUST.into())),
        state: Default::default(),
        application: Default::default(),
    };
    while let Some(item) = shard.next_event(EventTypeFlags::all()).await {
        let event = item?;
        match event {
            Event::Ready(r) => {
                app.state.lock().await.bot_user_id = Some(r.user.id.get());
                *app.application.lock().await = Some(r.application.id);
                app.commands().await?;
                tracing::info!("Raydio Rust connected");
            }
            Event::InteractionCreate(x) => {
                let app = app.clone();
                let sender = shard.sender();
                tokio::spawn(async move {
                    if let Err(error) = app.handle(x.0, sender).await {
                        tracing::warn!(?error, "interaction failed");
                    }
                });
            }
            Event::VoiceServerUpdate(v) => {
                let endpoint = v.endpoint.context("missing voice endpoint")?;
                let mut state = app.state.lock().await;
                let session_id = state
                    .bot_voice
                    .get(&v.guild_id)
                    .map(|voice| voice.session_id.clone())
                    .unwrap_or_default();
                state.bot_voice.insert(
                    v.guild_id,
                    Voice {
                        token: v.token,
                        endpoint,
                        session_id,
                    },
                );
            }
            Event::VoiceStateUpdate(v) => {
                if let Some(g) = v.guild_id {
                    let mut state = app.state.lock().await;
                    if state.bot_user_id == Some(v.user_id.get()) {
                        if let Some(voice) = state.bot_voice.get_mut(&g) {
                            voice.session_id = v.session_id.clone();
                        }
                    } else {
                        state
                            .voice_sessions
                            .insert(v.user_id, (g, v.channel_id, v.session_id.clone()));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}
