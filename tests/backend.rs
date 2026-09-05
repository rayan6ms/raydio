use raydio::{backend::Backend, node::Node};
use serde_json::json;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_crust_session_uses_ready_id_for_player_requests_and_shuts_down() {
    let backend = Backend::start().await.unwrap();
    let address = backend.address;
    let (node, owner, _events) =
        Node::start(address, backend.password.clone(), 1544468432907669644).unwrap();
    node.wait_ready().await.unwrap();
    let health = node.health();
    assert!(health.ready);
    assert!(!health.session.is_empty());
    let player = node
        .update(1544468013582127238, json!({"volume":37}))
        .await
        .unwrap();
    assert_eq!(player["volume"], 37);
    assert_eq!(player["guildId"], "1544468013582127238");
    node.destroy(1544468013582127238).await.unwrap();
    let response = reqwest::Client::new()
        .get(format!("http://{address}/v4/info"))
        .header("Authorization", "incorrect-test-password")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    owner.shutdown().await;
    backend.shutdown().await.unwrap();
    assert!(tokio::net::TcpStream::connect(address).await.is_err());
}
