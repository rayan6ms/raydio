//! Opt-in live integration check, restricted to the user's dedicated testbot and server.
use anyhow::{Context, Result, ensure};
use raydio::{backend::Backend, node::Node, voice::Cache};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::{sleep, timeout};
use tokio_util::sync::CancellationToken;
use twilight_gateway::{EventTypeFlags, Intents, Shard, ShardId, StreamExt as _};
use twilight_model::{gateway::payload::outgoing::UpdateVoiceState, id::Id};

const BOT: u64 = 1544468432907669644;
const GUILD: u64 = 1544468012491346110;

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("Pass the test environment file path")?;
    let values: HashMap<_, _> = dotenvy::from_path_iter(path)?.collect::<Result<_, _>>()?;
    let token = values
        .get("DISCORD_TOKEN_TESTBOT")
        .context("Test token missing")?
        .clone();
    let http = twilight_http::Client::new(token.clone());
    ensure!(
        http.current_user().await?.model().await?.id.get() == BOT,
        "Unexpected bot identity"
    );
    let backend = Backend::start().await?;
    let (node, owner, mut events) = Node::start(backend.address, backend.password.clone(), BOT)?;
    node.wait_ready().await?;
    let cache = Arc::new(Mutex::new(Cache::default()));
    let mut shard = Shard::new(
        ShardId::ONE,
        token,
        Intents::GUILDS | Intents::GUILD_VOICE_STATES,
    );
    let sender = shard.sender();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let gateway_cache = cache.clone();
    let gateway = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stop.cancelled() => {
                    shard.command(&UpdateVoiceState::new(Id::new(GUILD), None, true, false));
                    let _ = timeout(Duration::from_millis(500), shard.next_event(EventTypeFlags::all())).await;
                    shard.close(twilight_gateway::CloseFrame::NORMAL);
                    let _ = timeout(Duration::from_secs(1), shard.next_event(EventTypeFlags::all())).await;
                    break;
                }
                event = shard.next_event(EventTypeFlags::all()) => {
                    if let Some(Ok(event)) = event { gateway_cache.lock().unwrap().update(&event, BOT); }
                }
            }
        }
    });
    let stop = cancel.clone();
    let event_task = tokio::spawn(async move {
        loop {
            tokio::select! { _ = stop.cancelled() => break, event = events.recv() => match event {
                None => break,
                Some(raydio::node::Event::Payload(value)) if value["op"] == "event" => println!("{}",json!({"event":value["type"],"code":value["code"],"reason":if value["type"]=="WebSocketClosedEvent" { Value::Null } else { value["reason"].clone() }})),
                _ => {}
            } }
        }
    });
    let outcome = async {
        timeout(Duration::from_secs(15), async {
            while !cache.lock().unwrap().guilds.get(&GUILD).is_some_and(|g| g.available) { sleep(Duration::from_millis(50)).await; }
        }).await?;
        let loaded = node.load("https://www.youtube.com/watch?v=dQw4w9WgXcQ").await?;
        let encoded = loaded["data"]["encoded"].as_str().context("Control video did not load")?;
        for (name, channel) in [("General",1544468013582127238_u64), ("private-vc",1544468199356112947_u64)] {
            cache.lock().unwrap().guilds.get_mut(&GUILD).unwrap().server = None;
            sender.command(&UpdateVoiceState::new(Id::new(GUILD), Some(Id::new(channel)), true, false))?;
            let (session, server) = timeout(Duration::from_secs(15), async {
                loop {
                    let value = cache.lock().unwrap().guilds.get(&GUILD).and_then(|g| {
                        let voice = g.voices.get(&BOT).filter(|v| v.channel == channel)?;
                        Some((voice.session.clone(), g.server.clone()?))
                    });
                    if let Some(value) = value { break value; }
                    sleep(Duration::from_millis(25)).await;
                }
            }).await.context("Discord voice handshake timed out")?;
            if std::env::args().any(|arg| arg == "--oto-only") {
                let oto = oto::Oto::builder().build()?;
                let connection = oto.connect(oto::VoiceConnectInfo::new(GUILD, BOT, channel, session, server.endpoint, oto::VoiceToken::new(server.token))).await?;
                for _ in 0..5 {
                    let state = connection.state();
                    println!("{}", json!({"channel":name,"otoState":format!("{state:?}")}));
                    sleep(Duration::from_secs(2)).await;
                }
                connection.shutdown().await?;
                return Ok(());
            }
            let joined = node.update(GUILD,json!({"voice":{"token":server.token,"endpoint":server.endpoint,"sessionId":session,"channelId":channel.to_string()},"volume":70})).await?;
            println!("{}",json!({"channel":name,"stage":"joined","connected":joined["state"]["connected"]}));
            node.update(GUILD,json!({"track":{"encoded":encoded,"userData":{"raydioGeneration":1}}})).await?;
            sleep(Duration::from_secs(8)).await;
            let playing = node.request(reqwest::Method::GET,&format!("/v4/sessions/{}/players/{GUILD}",node.health().session), &[], None).await?;
            println!("{}",json!({"channel":name,"stage":"playing","connected":playing["state"]["connected"],"positionMs":playing["state"]["position"],"hasTrack":playing["track"].is_object()}));
            ensure!(playing["state"]["connected"] == true && playing["state"]["position"].as_u64().unwrap_or(0) >= 4000, "Playback did not advance in {name}");
            node.update(GUILD,json!({"paused":true})).await?;
            let paused = node.request(reqwest::Method::GET,&format!("/v4/sessions/{}/players/{GUILD}",node.health().session), &[], None).await?;
            sleep(Duration::from_secs(1)).await;
            let still = node.request(reqwest::Method::GET,&format!("/v4/sessions/{}/players/{GUILD}",node.health().session), &[], None).await?;
            ensure!(paused["state"]["position"] == still["state"]["position"], "Paused position moved");
            node.update(GUILD,json!({"paused":false,"volume":37})).await?;
            sleep(Duration::from_secs(2)).await;
            println!("{}",json!({"channel":name,"stage":"pause-resume-volume","passed":true}));
            node.destroy(GUILD).await?;
            sender.command(&UpdateVoiceState::new(Id::new(GUILD), None, true, false))?;
            timeout(Duration::from_secs(5), async {
                while cache.lock().unwrap().guilds.get(&GUILD).is_some_and(|g| g.voices.contains_key(&BOT)) { sleep(Duration::from_millis(25)).await; }
            }).await?;
        }
        Ok::<_,anyhow::Error>(())
    }.await;
    let _ = node.destroy(GUILD).await;
    cancel.cancel();
    let _ = gateway.await;
    let _ = event_task.await;
    owner.shutdown().await;
    backend.shutdown().await?;
    outcome
}
