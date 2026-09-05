use anyhow::{Context, Result};
use crust::routeplanner::RoutePlanner;
use crust_mantle_adapter::RealMantleAdapter;
use crust_oto_adapter::OtoVoiceBackend;
use crust_server::{CrustServer, config::ServerConfig};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{task::JoinHandle, time::timeout};
use tokio_util::sync::CancellationToken;

/// A private in-process Crust instance. Mantle owns media, Oto owns voice pacing.
pub struct Backend {
    pub address: SocketAddr,
    pub password: String,
    cancel: CancellationToken,
    task: Option<JoinHandle<std::io::Result<()>>>,
}

impl Backend {
    pub async fn start() -> Result<Self> {
        let password = format!(
            "{:032x}{:032x}",
            rand::random::<u128>(),
            rand::random::<u128>()
        );
        let mut config = ServerConfig::default().with_password(password.clone())?;
        config.listen_address = IpAddr::V4(Ipv4Addr::LOCALHOST);
        config.port = 0;
        config.player_executor_shards = 2;
        config.max_sessions = 2;
        config.max_players = 100;
        config.max_players_per_session = 100;
        config.max_concurrent_loads = 4;
        config.max_concurrent_source_requests = 8;
        config.max_concurrent_voice_connects = 4;
        config.player_update_interval = Duration::from_secs(1);
        let media = Arc::new(RealMantleAdapter::with_defaults(RoutePlanner::disabled())?);
        let voice = Arc::new(OtoVoiceBackend::with_defaults(100, 4)?);
        let server = CrustServer::bind_with_backends(config, media, voice).await?;
        let address = server.local_address()?;
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let task = tokio::spawn(server.serve(stop));
        Ok(Self {
            address,
            password,
            cancel,
            task: Some(task),
        })
    }

    pub async fn shutdown(mut self) -> Result<()> {
        self.cancel.cancel();
        if let Some(mut task) = self.task.take() {
            match timeout(Duration::from_secs(10), &mut task).await {
                Ok(result) => result.context("backend task failed")??,
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    anyhow::bail!("backend shutdown timed out");
                }
            }
        }
        Ok(())
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
