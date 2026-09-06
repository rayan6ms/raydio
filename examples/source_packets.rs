//! Bounded offline source audit, separate from receiver qualification.
//! Writes length-prefixed Opus packets for an independent decoder, never URLs
//! or credentials. The output belongs under target/ and is not test evidence.
use anyhow::{Context, Result};
use crust::{
    media::{LoadOutcome, LoadRequest, MantleAdapter, SourceRoute},
    routeplanner::RoutePlanner,
};
use crust_mantle_adapter::RealMantleAdapter;
use std::{
    fs::OpenOptions,
    io::{BufWriter, Write},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("supply a new output path under target/")?;
    let paced = std::env::args().nth(2).is_some_and(|arg| arg == "--paced");
    let mut out = BufWriter::new(OpenOptions::new().write(true).create_new(true).open(path)?);
    let adapter = RealMantleAdapter::with_defaults(RoutePlanner::disabled())?;
    let cancel = CancellationToken::new();
    let LoadOutcome::Track(track) = adapter
        .load(
            LoadRequest {
                identifier: "https://www.youtube.com/watch?v=dQw4w9WgXcQ".into(),
                route: SourceRoute::default(),
            },
            cancel.clone(),
        )
        .await?
    else {
        anyhow::bail!("expected track");
    };
    let player = adapter.create_player(cancel.clone()).await?;
    let result = tokio::time::timeout(Duration::from_secs(360), async {
        player.set_filters(crust::filters::FilterConfiguration {
            player_volume: Some(70), ..Default::default()
        }, cancel.clone()).await?;
        player.play(track, cancel.clone()).await?;
        let mut frames = 0_u64;
        let mut bytes = 0_u64;
        let started = Instant::now();
        let mut deadline = tokio::time::Instant::now();
        let mut stalls = Vec::new();
        loop {
            let reading = Instant::now();
            let Some(frame) = player.next_frame(cancel.clone()).await? else { break; };
            let read_ms = reading.elapsed().as_secs_f64() * 1000.0;
            if read_ms >= 20.0 && stalls.len() < 500 {
                stalls.push(serde_json::json!({"frame":frames,"elapsedSeconds":started.elapsed().as_secs_f64(),"readMs":read_ms}));
            }
            anyhow::ensure!(frames < 15_000, "five-minute frame limit exceeded");
            let payload = frame.payload.as_slice();
            out.write_all(&u16::try_from(payload.len())?.to_le_bytes())?;
            out.write_all(payload)?;
            frames += 1;
            bytes += payload.len() as u64;
            // Keep this diagnostic light on the shared development machine.
            if paced {
                deadline += Duration::from_millis(20);
                deadline = deadline.max(tokio::time::Instant::now());
                tokio::time::sleep_until(deadline).await;
            } else {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
        out.flush()?;
        println!("{}", serde_json::json!({"scope":"source packets, no Discord transport", "volume":70,"frames":frames,"bytes":bytes,"paced":paced,"elapsedSeconds":started.elapsed().as_secs_f64(),"stalls":stalls}));
        Ok::<_, anyhow::Error>(())
    }).await;
    player.shutdown().await?;
    adapter.shutdown().await?;
    result.context("source audit timeout")?
}
