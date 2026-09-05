use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, env, sync::Arc};
use tokio::sync::Mutex;
use twilight_gateway::{Event, EventTypeFlags, Intents, Shard, StreamExt as GatewayStreamExt};
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
        }
    }
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
}

#[derive(Clone)]
struct App {
    http: Client,
    token: Arc<str>,
    crust: Arc<str>,
    state: Arc<Mutex<State>>,
    application: Arc<Mutex<Option<Id<ApplicationMarker>>>>,
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
            .header("Authorization", "Bot")
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
        let body:Vec<Value>=names.iter().map(|(name,description)|{let mut x=json!({"name":name,"description":description,"type":1}); if *name=="play" {x["options"]=json!([{"name":"request","description":"Search or YouTube URL","type":3,"required":true}]);} x}).collect();
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
        self.crust(reqwest::Method::PATCH,&format!("/v4/sessions/{session}/players/{guild}?noReplace={no_replace}"),json!({"encodedTrack":encoded,"volume":70,"voice":{"token":voice.token,"endpoint":voice.endpoint,"sessionId":voice.session_id}})).await?;
        Ok(())
    }
    async fn handle(&self, i: Interaction, shard: &Shard) -> Result<()> {
        let id = i.id.to_string();
        let token = i.token.clone();
        let Some(ref data) = i.data else {
            return Ok(());
        };
        let InteractionData::ApplicationCommand(c) = data else {
            return Ok(());
        };
        let guild = i.guild_id.context("DM unsupported")?;
        let text = i.channel_id.context("missing channel")?;
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
                shard.command(&UpdateVoiceState::new(guild, Some(channel), true, false));
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
        crust: Arc::from(env::var("CRUST_URL").unwrap_or_else(|_| CRUST.into())),
        state: Default::default(),
        application: Default::default(),
    };
    while let Some(item) = shard.next_event(EventTypeFlags::all()).await {
        let event = item?;
        match event {
            Event::Ready(r) => {
                *app.application.lock().await = Some(r.application.id);
                app.commands().await?;
                tracing::info!("Raydio Rust connected");
            }
            Event::InteractionCreate(x) => app.handle(x.0, &shard).await?,
            Event::VoiceServerUpdate(v) => {
                let endpoint = v.endpoint.context("missing voice endpoint")?;
                app.state.lock().await.bot_voice.insert(
                    v.guild_id,
                    Voice {
                        token: v.token,
                        endpoint,
                        session_id: String::new(),
                    },
                );
            }
            Event::VoiceStateUpdate(v) => {
                if let Some(g) = v.guild_id {
                    app.state
                        .lock()
                        .await
                        .voice_sessions
                        .insert(v.user_id, (g, v.channel_id, v.session_id.clone()));
                }
            }
            _ => {}
        }
    }
    Ok(())
}
