use anyhow::{Context, Result};
use raydio::{backend::Backend, config::Config};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

fn main() -> Result<()> {
    let workers = runtime_workers(std::env::var("RAYDIO_WORKER_THREADS").ok().as_deref())?;
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .enable_all()
        .build()?
        .block_on(run())
}

fn runtime_workers(value: Option<&str>) -> Result<usize> {
    match value {
        None | Some("2") => Ok(2),
        Some("1") => Ok(1),
        _ => anyhow::bail!("RAYDIO_WORKER_THREADS must be 1 or 2"),
    }
}

async fn run() -> Result<()> {
    let mut testbot = false;
    let mut probe = false;
    let mut check = false;
    let mut env_file = PathBuf::from(".env");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--testbot" => testbot = true,
            "--probe-backend" => probe = true,
            "--check" => check = true,
            "--version" | "-V" => {
                println!(
                    "raydio {} {}",
                    env!("CARGO_PKG_VERSION"),
                    std::env::consts::ARCH
                );
                return Ok(());
            }
            "--env-file" => {
                env_file = PathBuf::from(args.next().context("--env-file needs a path")?)
            }
            "--help" | "-h" => {
                println!(
                    "raydio [--testbot] [--env-file PATH] [--check] [--probe-backend] [--version]\n--testbot selects DISCORD_TOKEN_TESTBOT explicitly.\n--check checks the embedded backend offline, without a Discord token."
                );
                return Ok(());
            }
            _ => anyhow::bail!("Unknown argument; use --help"),
        }
    }
    if check {
        tracing_subscriber::fmt().with_env_filter("warn").init();
        let backend = Backend::start().await?;
        let (node, owner, _events) =
            raydio::node::Node::start(backend.address, backend.password.clone(), 1)?;
        node.wait_ready().await?;
        owner.shutdown().await;
        backend.shutdown().await?;
        println!("Backend check passed");
        return Ok(());
    }
    if probe {
        tracing_subscriber::fmt().with_env_filter("warn").init();
        return probe_backend().await;
    }
    let mut values = HashMap::new();
    if env_file.exists() {
        for item in dotenvy::from_path_iter(&env_file)
            .map_err(|_| anyhow::anyhow!("Could not read the environment file"))?
        {
            let (key, value) =
                item.map_err(|_| anyhow::anyhow!("Invalid environment file syntax"))?;
            values.insert(key, value);
        }
    }
    values.extend(std::env::vars());
    let config = Config::from_env(&values, testbot)?;
    drop(values);
    let level = match config.log_level.as_str() {
        "silent" => "off",
        "fatal" => "error",
        level => level,
    };
    // Third-party HTTP/media debug logs may contain signed URLs. Keep those quiet.
    // The voice adapter emits only bounded, credential-free lifecycle summaries;
    // retain those counters so normal shutdowns can be correlated with playback.
    tracing_subscriber::fmt()
        .with_env_filter(format!("warn,raydio={level},crust_oto_adapter={level}"))
        .init();
    let cancel = CancellationToken::new();
    let run = raydio::runtime::run(config, cancel.clone());
    tokio::pin!(run);
    tokio::select! {
        result = &mut run => result,
        _ = shutdown_signal() => {
            cancel.cancel();
            tokio::time::timeout(Duration::from_secs(10), &mut run).await.context("Shutdown exceeded ten seconds")?
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install terminate handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
async fn probe_backend() -> Result<()> {
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
            serde_json::json!({"input":input,"status":status.as_u16(),"elapsedMs":start.elapsed().as_millis(),"loadType":body["loadType"],"trackCount":body["data"].as_array().map(Vec::len),"failed":body["loadType"]=="error"})
        );
    }
    backend.shutdown().await
}

#[cfg(test)]
mod tests {
    #[test]
    fn runtime_workers_are_bounded() {
        assert_eq!(super::runtime_workers(None).unwrap(), 2);
        assert_eq!(super::runtime_workers(Some("1")).unwrap(), 1);
        for invalid in ["", "0", "3", "-1", "1000000"] {
            assert!(super::runtime_workers(Some(invalid)).is_err());
        }
    }
}
