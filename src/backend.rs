use anyhow::{Context, Result};
use crust::routeplanner::{RoutePlanner, RoutePlannerConfig, RoutePlannerStrategy};
use crust_mantle_adapter::{MantleAdapterOptions, RealMantleAdapter};
use crust_oto_adapter::OtoVoiceBackend;
use crust_server::{CrustServer, config::ServerConfig};
use mantle_media::{
    YoutubeAuthentication, YoutubeCipherResolver, YoutubeProcessCipherOptions,
    YoutubeProcessCipherResolver,
};
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
        // Copy small finite compressed tracks to an anonymous file before
        // playback, so source HTTP stalls cannot interrupt their audio frames.
        // One completed input per player is reused on a natural repeat.
        let authentication = youtube_authentication_from_env()?;
        let route_planner = youtube_route_planner_from_env()?;
        let cipher_resolver = youtube_cipher_resolver_from_env()?;
        let media = Arc::new(
            RealMantleAdapter::with_options_authentication_and_cipher_resolver(
                route_planner,
                MantleAdapterOptions {
                    staging_max_bytes: 16 * 1024 * 1024,
                    ..MantleAdapterOptions::default()
                },
                authentication,
                cipher_resolver,
            )?,
        );
        let mut voice = OtoVoiceBackend::with_defaults(100, 4)?;
        if std::env::var("RAYDIO_SEND_TRACE").as_deref() == Ok("1") {
            voice = voice.with_send_trace();
        }
        tracing::info!(
            isolated_audio_worker = cfg!(feature = "experimental-audio-worker"),
            "voice execution configuration"
        );
        let voice = Arc::new(voice);
        Self::start_with(media, voice).await
    }
    #[cfg(test)]
    pub(crate) async fn start_fixture() -> Result<Self> {
        Self::start_with(
            Arc::new(crust_testkit::FakeMantle::default()),
            Arc::new(crust_testkit::FakeVoiceBackend::new(128, 4)),
        )
        .await
    }
    async fn start_with(
        media: Arc<dyn crust::media::MantleAdapter>,
        voice: Arc<dyn crust::voice::VoiceBackend>,
    ) -> Result<Self> {
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

fn optional_secret(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// Builds the Lavalink-style local-address route planner when an operator supplies
/// a real pool of source addresses. Leaving the address pool unset keeps the
/// existing single-route behavior; the planner cannot manufacture new egress IPs.
fn youtube_route_planner_from_env() -> Result<RoutePlanner> {
    let Some(blocks) = optional_secret("RAYDIO_ROUTE_PLANNER_IP_BLOCKS") else {
        return Ok(RoutePlanner::disabled());
    };
    let strategy_name = optional_secret("RAYDIO_ROUTE_PLANNER_STRATEGY")
        .unwrap_or_else(|| "rotate_on_ban".to_owned())
        .to_ascii_lowercase();
    let strategy = match strategy_name.as_str() {
        "rotate_on_ban" | "rotating" => RoutePlannerStrategy::RotateOnBan,
        "load_balance" | "balancing" => RoutePlannerStrategy::LoadBalance,
        "nano_switch" | "nano" => RoutePlannerStrategy::NanoSwitch,
        "rotating_nano_switch" | "rotating_nano" => RoutePlannerStrategy::RotatingNanoSwitch,
        _ => anyhow::bail!(
            "invalid RAYDIO_ROUTE_PLANNER_STRATEGY: expected rotate_on_ban, load_balance, nano_switch, or rotating_nano_switch"
        ),
    };
    let mut config = RoutePlannerConfig::new(
        strategy,
        blocks
            .split(',')
            .map(str::trim)
            .filter(|block| !block.is_empty()),
    );
    if let Some(excluded) = optional_secret("RAYDIO_ROUTE_PLANNER_EXCLUDED_ADDRESSES") {
        config.excluded_addresses = excluded
            .split(',')
            .map(str::trim)
            .filter(|address| !address.is_empty())
            .map(str::parse)
            .collect::<std::result::Result<Vec<IpAddr>, _>>()
            .map_err(|_| anyhow::anyhow!("invalid RAYDIO_ROUTE_PLANNER_EXCLUDED_ADDRESSES"))?;
    }
    if let Some(value) = optional_secret("RAYDIO_ROUTE_PLANNER_SEARCH_TRIGGERS_FAIL") {
        config.search_triggers_fail = value
            .parse::<bool>()
            .map_err(|_| anyhow::anyhow!("invalid RAYDIO_ROUTE_PLANNER_SEARCH_TRIGGERS_FAIL"))?;
    }
    if let Some(value) = optional_secret("RAYDIO_ROUTE_PLANNER_MAX_FAILURES") {
        config.max_failures = value
            .parse::<usize>()
            .map_err(|_| anyhow::anyhow!("invalid RAYDIO_ROUTE_PLANNER_MAX_FAILURES"))?;
    }
    let planner = RoutePlanner::configured(config)
        .map_err(|error| anyhow::anyhow!("invalid YouTube route planner configuration: {error}"))?;
    tracing::info!(strategy = %strategy_name, "YouTube route planner enabled");
    Ok(planner)
}

fn youtube_cipher_resolver_from_env() -> Result<Option<Arc<dyn YoutubeCipherResolver>>> {
    let deno = optional_secret("RAYDIO_YOUTUBE_DENO_BIN");
    let adapter = optional_secret("RAYDIO_YOUTUBE_EJS_ADAPTER");
    match (deno, adapter) {
        (None, None) => Ok(None),
        (Some(deno), Some(adapter)) => {
            let resolver = YoutubeProcessCipherResolver::deno(
                deno,
                adapter,
                YoutubeProcessCipherOptions::default(),
            )
            .map_err(|_| anyhow::anyhow!("invalid YouTube cipher resolver configuration"))?;
            tracing::info!("isolated YouTube cipher fallback enabled");
            Ok(Some(Arc::new(resolver)))
        }
        _ => anyhow::bail!("both YouTube cipher resolver paths must be configured"),
    }
}

fn youtube_authentication_from_env() -> Result<YoutubeAuthentication> {
    let oauth_access_token = optional_secret("RAYDIO_YOUTUBE_OAUTH_ACCESS_TOKEN");
    let oauth_refresh_token = optional_secret("RAYDIO_YOUTUBE_OAUTH_REFRESH_TOKEN");
    let cookies = optional_secret("RAYDIO_YOUTUBE_COOKIES");
    let po_token = optional_secret("RAYDIO_YOUTUBE_PO_TOKEN");
    let visitor_data = optional_secret("RAYDIO_YOUTUBE_VISITOR_DATA");
    tracing::info!(
        oauth_access_token = oauth_access_token.is_some(),
        oauth_refresh_token = oauth_refresh_token.is_some(),
        cookies = cookies.is_some(),
        po_token = po_token.is_some(),
        visitor_data = visitor_data.is_some(),
        "YouTube authentication material loaded"
    );
    YoutubeAuthentication::with_credentials(
        oauth_access_token,
        oauth_refresh_token,
        cookies,
        po_token,
        visitor_data,
    )
    .map_err(|_| anyhow::anyhow!("invalid YouTube authentication configuration"))
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
