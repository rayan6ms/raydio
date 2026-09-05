use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::HeaderMap,
    response::IntoResponse,
    routing::{get, patch},
};
use raydio::node::{Event, Node};
use serde_json::json;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{sync::Notify, time::timeout};

#[derive(Clone)]
struct Peer {
    connections: Arc<AtomicUsize>,
    headers: Arc<Mutex<Vec<Option<String>>>>,
    disconnect: Arc<Notify>,
    resumed: bool,
}
async fn ws(
    State(peer): State<Peer>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    peer.headers.lock().unwrap().push(
        headers
            .get("Session-Id")
            .map(|value| value.to_str().unwrap().to_owned()),
    );
    upgrade.on_upgrade(move |socket| serve(socket, peer))
}
async fn serve(mut socket: WebSocket, peer: Peer) {
    let number = peer.connections.fetch_add(1, Ordering::Relaxed);
    let session = if number == 0 || peer.resumed {
        "issued-session-one"
    } else {
        "issued-session-two"
    };
    socket
        .send(Message::Text(
            json!({"op":"ready","sessionId":session,"resumed":number > 0 && peer.resumed})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({"op":"stats","frameStats":{"sent":3000,"nulled":2,"deficit":1}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    if number == 0 {
        peer.disconnect.notified().await;
        let _ = socket.send(Message::Close(None)).await;
    } else {
        while socket.recv().await.is_some() {}
    }
}
#[tokio::test]
async fn reconnect_preserves_resumed_sessions_and_invalidates_replacements() {
    for resumed in [true, false] {
        let peer = Peer {
            connections: Arc::new(AtomicUsize::new(0)),
            headers: Arc::new(Mutex::new(vec![])),
            disconnect: Arc::new(Notify::new()),
            resumed,
        };
        let router = Router::new()
            .route("/v4/websocket", get(ws))
            .route(
                "/v4/sessions/{session}",
                patch(|| async { axum::Json(json!({"resuming":true,"timeout":60})) }),
            )
            .with_state(peer.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let (node, owner, mut events) = Node::start(address, "fixture-password".into(), 9).unwrap();
        node.wait_ready().await.unwrap();
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        timeout(Duration::from_secs(2), async {
            while node.health().audio.windows == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(node.health().audio.sent, 3000);
        assert_eq!(node.health().audio.unavailable, 2);
        assert_eq!(node.health().audio.missed_deadlines, 1);
        peer.disconnect.notify_one();
        timeout(Duration::from_secs(5), async {
            while node.health().connections < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let event = events.recv().await.unwrap();
        if resumed {
            assert!(matches!(event, Event::Connected));
            assert_eq!(node.health().session, "issued-session-one");
        } else {
            assert!(matches!(event, Event::Invalidated));
            assert!(matches!(events.recv().await, Some(Event::Connected)));
            assert_eq!(node.health().session, "issued-session-two");
        }
        assert_eq!(
            *peer.headers.lock().unwrap(),
            [None, Some("issued-session-one".into())]
        );
        owner.shutdown().await;
        server.abort();
        let _ = server.await;
    }
}
