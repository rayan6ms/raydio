use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
    time::{sleep, timeout},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Default)]
pub struct Health {
    pub ready: bool,
    pub session: String,
    pub connections: u64,
    pub errors: u64,
    pub audio: AudioHealth,
}
/// Crust's last node-wide frame window, not cumulative per-guild counters.
#[derive(Clone, Debug, Default)]
pub struct AudioHealth {
    pub windows: u64,
    pub sent: u64,
    pub unavailable: u64,
    pub missed_deadlines: u64,
    pub observed_at: Option<Instant>,
}
impl AudioHealth {
    fn observe(&mut self, value: &Value) {
        let Some(sent) = value["sent"].as_u64() else {
            return;
        };
        let Some(unavailable) = value["nulled"].as_u64() else {
            return;
        };
        let Some(missed_deadlines) = value["deficit"].as_u64() else {
            return;
        };
        self.windows = self.windows.saturating_add(1);
        self.sent = sent;
        self.unavailable = unavailable;
        self.missed_deadlines = missed_deadlines;
        self.observed_at = Some(Instant::now());
    }
}
#[derive(Debug)]
pub enum Event {
    Connected,
    Invalidated,
    Payload(Value),
}

#[derive(Clone)]
pub struct Node {
    client: Client,
    base: Arc<str>,
    password: Arc<str>,
    health: watch::Receiver<Health>,
}
pub struct NodeOwner {
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl Node {
    pub fn start(
        address: std::net::SocketAddr,
        password: String,
        bot_user_id: u64,
    ) -> Result<(Self, NodeOwner, mpsc::Receiver<Event>)> {
        let client = Client::builder()
            // Crust is always embedded on loopback; it does not use a proxy or TLS.
            .no_proxy()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(5))
            .build()?;
        let (health_tx, health) = watch::channel(Health::default());
        let (events, receiver) = mpsc::channel(128);
        let cancel = CancellationToken::new();
        let node = Self {
            client,
            base: Arc::from(format!("http://{address}")),
            password: Arc::from(password),
            health,
        };
        let task = tokio::spawn(run(
            node.clone(),
            health_tx,
            events,
            cancel.clone(),
            bot_user_id,
        ));
        Ok((
            node,
            NodeOwner {
                cancel,
                task: Some(task),
            },
            receiver,
        ))
    }
    pub fn health(&self) -> Health {
        self.health.borrow().clone()
    }
    pub async fn wait_ready(&self) -> Result<()> {
        let mut health = self.health.clone();
        timeout(Duration::from_secs(10), async {
            loop {
                if health.borrow().ready {
                    return Ok(());
                }
                health.changed().await.context("music service stopped")?;
            }
        })
        .await
        .context("music service connection timed out")?
    }
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .header("Authorization", self.password.as_ref())
            .query(query);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("music service request failed"))?;
        if !response.status().is_success() {
            bail!("music service returned HTTP {}", response.status().as_u16());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("music response interrupted"))?
        {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                bail!("music service response exceeds limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            Ok(Value::Null)
        } else {
            serde_json::from_slice(&bytes).context("invalid music service response")
        }
    }
    pub async fn load(&self, identifier: &str) -> Result<Value> {
        if !self.health.borrow().ready {
            bail!("music service unavailable");
        }
        self.request(
            Method::GET,
            "/v4/loadtracks",
            &[("identifier", identifier)],
            None,
        )
        .await
    }
    pub async fn update(&self, guild: u64, update: Value) -> Result<Value> {
        let health = self.health();
        if !health.ready {
            bail!("music service unavailable");
        }
        self.request(
            Method::PATCH,
            &format!("/v4/sessions/{}/players/{guild}", health.session),
            &[],
            Some(update),
        )
        .await
    }
    pub async fn destroy(&self, guild: u64) -> Result<()> {
        let health = self.health();
        if health.ready {
            self.request(
                Method::DELETE,
                &format!("/v4/sessions/{}/players/{guild}", health.session),
                &[],
                None,
            )
            .await?;
        }
        Ok(())
    }
}

async fn run(
    node: Node,
    health_tx: watch::Sender<Health>,
    events: mpsc::Sender<Event>,
    cancel: CancellationToken,
    user_id: u64,
) {
    let mut state = Health::default();
    let mut outage = None;
    while !cancel.is_cancelled() {
        let Ok(mut request) =
            format!("{}/v4/websocket", node.base.replace("http://", "ws://")).into_client_request()
        else {
            break;
        };
        let Ok(password) = node.password.parse() else {
            break;
        };
        request.headers_mut().insert("Authorization", password);
        request.headers_mut().insert(
            "User-Id",
            user_id.to_string().parse().expect("numeric header"),
        );
        request.headers_mut().insert(
            "Client-Name",
            "Raydio/0.2.0".parse().expect("constant header"),
        );
        if !state.session.is_empty() {
            request.headers_mut().insert(
                "Session-Id",
                state.session.parse().expect("validated session"),
            );
        }
        let config = WebSocketConfig::default()
            // The stream carries small control events, not audio. It can grow
            // for larger messages up to the unchanged protocol limits below.
            .read_buffer_size(8 * 1024)
            .max_message_size(Some(1024 * 1024))
            .max_frame_size(Some(1024 * 1024));
        let connection = tokio::select! { _ = cancel.cancelled() => break, result = timeout(Duration::from_secs(10), connect_async_with_config(request, Some(config), false)) => result };
        if let Ok(Ok((mut socket, _))) = connection {
            loop {
                let next = tokio::select! {
                    _ = cancel.cancelled() => { let _ = timeout(Duration::from_secs(1), socket.close(None)).await; return; },
                    result = timeout(Duration::from_secs(90), socket.next()) => result,
                };
                let Ok(Some(Ok(message))) = next else {
                    break;
                };
                match message {
                    Message::Ping(bytes) => {
                        if !matches!(
                            timeout(Duration::from_secs(3), socket.send(Message::Pong(bytes)))
                                .await,
                            Ok(Ok(()))
                        ) {
                            break;
                        }
                    }
                    Message::Text(text) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else {
                            break;
                        };
                        if value["op"] == "ready" {
                            let Some(session) = value["sessionId"].as_str().filter(|s| {
                                !s.is_empty()
                                    && s.len() < 100
                                    && s.bytes().all(|b| {
                                        b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
                                    })
                            }) else {
                                break;
                            };
                            if !state.session.is_empty() && value["resumed"] != true {
                                tokio::select! { _ = cancel.cancelled() => return, result = events.send(Event::Invalidated) => { if result.is_err() { return; } } }
                            }
                            if node
                                .request(
                                    Method::PATCH,
                                    &format!("/v4/sessions/{session}"),
                                    &[],
                                    Some(json!({"resuming":true,"timeout":60})),
                                )
                                .await
                                .is_err()
                            {
                                break;
                            }
                            state.session = session.to_owned();
                            state.ready = true;
                            state.connections += 1;
                            outage = None;
                            health_tx.send_replace(state.clone());
                            tokio::select! { _ = cancel.cancelled() => return, result = events.send(Event::Connected) => { if result.is_err() { return; } } }
                        } else if value["op"] == "stats" {
                            state.audio.observe(&value["frameStats"]);
                            health_tx.send_replace(state.clone());
                        } else if matches!(value["op"].as_str(), Some("event" | "playerUpdate")) {
                            tokio::select! { _ = cancel.cancelled() => return, result = events.send(Event::Payload(value)) => { if result.is_err() { return; } } }
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
        state.ready = false;
        state.errors = state.errors.saturating_add(1);
        health_tx.send_replace(state.clone());
        if !state.session.is_empty()
            && outage.get_or_insert_with(Instant::now).elapsed() >= Duration::from_secs(60)
        {
            state.session.clear();
            health_tx.send_replace(state.clone());
            tokio::select! { _ = cancel.cancelled() => return, result = events.send(Event::Invalidated) => { if result.is_err() { return; } } }
        }
        tokio::select! { _ = cancel.cancelled() => break, _ = sleep(Duration::from_secs(1)) => {} }
    }
}

impl NodeOwner {
    pub async fn shutdown(mut self) {
        self.cancel.cancel();
        if let Some(mut task) = self.task.take()
            && timeout(Duration::from_secs(5), &mut task).await.is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Drop for NodeOwner {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audio_windows_replace_values_and_ignore_incomplete_samples() {
        let mut health = AudioHealth::default();
        health.observe(&json!({"sent":3000,"nulled":2,"deficit":1}));
        assert_eq!(
            (
                health.windows,
                health.sent,
                health.unavailable,
                health.missed_deadlines
            ),
            (1, 3000, 2, 1)
        );
        health.observe(&Value::Null);
        health.observe(&json!({"sent":5}));
        assert_eq!(health.windows, 1);
        health.observe(&json!({"sent":2999,"nulled":0,"deficit":0}));
        assert_eq!(
            (
                health.windows,
                health.sent,
                health.unavailable,
                health.missed_deadlines
            ),
            (2, 2999, 0, 0)
        );
    }
}
