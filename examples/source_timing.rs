//! Opt-in, paced real-source diagnostic. Emits timing only, never media or signed URLs.
use anyhow::{Context, Result};
use crust::{
    media::{LoadOutcome, LoadRequest, MantleAdapter, SourceRoute},
    routeplanner::RoutePlanner,
};
use crust_mantle_adapter::RealMantleAdapter;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    let seconds: u64 = std::env::args().nth(1).unwrap_or("180".into()).parse()?;
    anyhow::ensure!(
        (1..=600).contains(&seconds),
        "duration must be 1..600 seconds"
    );
    let adapter = RealMantleAdapter::with_defaults(RoutePlanner::disabled())?;
    let cancel = CancellationToken::new();
    let loaded = adapter
        .load(
            LoadRequest {
                identifier: "https://www.youtube.com/watch?v=dQw4w9WgXcQ".into(),
                route: SourceRoute::default(),
            },
            cancel.clone(),
        )
        .await?;
    let LoadOutcome::Track(track) = loaded else {
        anyhow::bail!("expected track");
    };
    let player = adapter.create_player(cancel.clone()).await?;
    let result = async {
        player.set_filters(crust::filters::FilterConfiguration { player_volume: Some(70), ..Default::default() }, cancel.clone()).await?;
        player.play(track, cancel.clone()).await?;
        let start = Instant::now();
        let mut deadline = tokio::time::Instant::now();
        let mut samples = Vec::with_capacity(seconds as usize * 50);
        let mut stalls = Vec::new();
        let mut frames = 0;
        while start.elapsed() < Duration::from_secs(seconds) {
            // Match the existing bridge: one source read following each consumption.
            let read_start = Instant::now();
            let frame = tokio::time::timeout(Duration::from_secs(35), player.next_frame(cancel.clone())).await.context("source timeout")??;
            if frame.is_none() { break; }
            let read_us = read_start.elapsed().as_micros() as u64;
            frames += 1;
            samples.push(read_us);
            if read_us >= 20_000 {
                let stall = serde_json::json!({"elapsedMs":start.elapsed().as_millis(), "frame":frames, "readMs":read_us as f64/1000.0});
                eprintln!("{stall}");
                stalls.push(stall);
            }
            deadline += Duration::from_millis(20);
            if deadline < tokio::time::Instant::now() { deadline = tokio::time::Instant::now(); }
            tokio::time::sleep_until(deadline).await;
        }
        samples.sort_unstable();
        let percentile = |p: usize| samples.get((samples.len().saturating_sub(1))*p/1000).copied().unwrap_or(0) as f64/1000.0;
        println!("{}",serde_json::json!({"scope":"real Mantle source at volume 70, one-frame paced pull, no Discord transport", "elapsedSeconds":start.elapsed().as_secs_f64(),"frames":frames,"readMs":{"p50":percentile(500),"p95":percentile(950),"p99":percentile(990),"max":percentile(1000)},"stalls":stalls}));
        Ok::<_, anyhow::Error>(())
    }.await;
    player.shutdown().await?;
    adapter.shutdown().await?;
    result
}
