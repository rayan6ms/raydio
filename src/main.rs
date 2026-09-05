use anyhow::Result;
use raydio::backend::Backend;

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["--probe-backend"] {
        anyhow::bail!(
            "Rust rewrite is in progress; use --probe-backend for a read-only backend check. See MANTLE_HANDOFF.md for the current blocker."
        );
    }
    tracing_subscriber::fmt().with_env_filter("warn").init();
    let backend = Backend::start().await?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()?;
    for input in [
        "ytmsearch:Daft Punk Get Lucky",
        "ytsearch:Daft Punk Get Lucky",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ] {
        let start = std::time::Instant::now();
        let response = http
            .get(format!("http://{}/v4/loadtracks", backend.address))
            .header("Authorization", &backend.password)
            .query(&[("identifier", input)])
            .send()
            .await?;
        let status = response.status();
        let body: serde_json::Value = response.json().await?;
        println!(
            "{}",
            serde_json::json!({"input":input,"status":status.as_u16(),"elapsedMs":start.elapsed().as_millis(),"loadType":body["loadType"],"trackCount":body["data"].as_array().map(Vec::len),"error":if body["loadType"]=="error" {body["data"].clone()} else {serde_json::Value::Null}})
        );
    }
    backend.shutdown().await
}
