//! Bounded source audit, separate from receiver qualification.
//! Writes length-prefixed Opus packets for an independent decoder, never URLs
//! or credentials. Use --staged --repeat to measure the integrated input cache.
use anyhow::{Context, Result};
use crust::{
    media::{LoadOutcome, LoadRequest, MantleAdapter, SourceRoute},
    routeplanner::RoutePlanner,
};
use crust_mantle_adapter::{MantleAdapterOptions, RealMantleAdapter};
use std::{
    fs::OpenOptions,
    io::{BufWriter, Write},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let path = args.first().context("supply a new output path")?;
    anyhow::ensure!(
        args[1..].iter().all(|arg| matches!(
            arg.as_str(),
            "--paced" | "--staged" | "--repeat" | "--redundant-filters"
        )),
        "unknown audit option"
    );
    let paced = args.iter().any(|arg| arg == "--paced");
    let staged = args.iter().any(|arg| arg == "--staged");
    let redundant_filters = args.iter().any(|arg| arg == "--redundant-filters");
    let repeats = if args.iter().any(|arg| arg == "--repeat") {
        2
    } else {
        1
    };
    anyhow::ensure!(
        !redundant_filters || (staged && repeats == 2),
        "--redundant-filters requires --staged --repeat"
    );
    let mut out = BufWriter::new(OpenOptions::new().write(true).create_new(true).open(path)?);
    let adapter = RealMantleAdapter::with_options(
        RoutePlanner::disabled(),
        MantleAdapterOptions {
            staging_max_bytes: if staged { 16 * 1024 * 1024 } else { 0 },
            ..MantleAdapterOptions::default()
        },
    )?;
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
    let result = tokio::time::timeout(Duration::from_secs(720), async {
        player.set_filters(crust::filters::FilterConfiguration {
            player_volume: Some(70), ..Default::default()
        }, cancel.clone()).await?;
        let mut reports = Vec::new();
        for iteration in 0..repeats {
            let play_cancel = CancellationToken::new();
            let opening = Instant::now();
            player.play(track.clone(), play_cancel.clone()).await?;
            let startup_ms = opening.elapsed().as_secs_f64() * 1000.0;
            let mut frames = 0_u64;
            let mut bytes = 0_u64;
            let mut max_read_ms = 0_f64;
            let started = Instant::now();
            let mut deadline = tokio::time::Instant::now();
            let mut stalls = Vec::new();
            let mut filter_updates = 0_u64;
            let mut filter_update_ms = 0_f64;
            loop {
                // The second play reuses the identical staged compressed input.
                // Compare it against the first play, without redundant controls.
                if redundant_filters && iteration == 1 && frames > 0 && frames.is_multiple_of(100) {
                    let updating = Instant::now();
                    player.set_filters(crust::filters::FilterConfiguration {
                        player_volume: Some(70), ..Default::default()
                    }, cancel.clone()).await?;
                    filter_update_ms += updating.elapsed().as_secs_f64() * 1000.0;
                    filter_updates += 1;
                }
                let reading = Instant::now();
                let Some(frame) = player.next_frame(cancel.clone()).await? else { break; };
                let read_ms = reading.elapsed().as_secs_f64() * 1000.0;
                max_read_ms = max_read_ms.max(read_ms);
                if read_ms >= 20.0 && stalls.len() < 500 {
                    stalls.push(serde_json::json!({"frame":frames,"elapsedSeconds":started.elapsed().as_secs_f64(),"readMs":read_ms}));
                }
                anyhow::ensure!(frames < 15_000, "five-minute frame limit exceeded");
                anyhow::ensure!(frame.sequence == frames, "sequence did not reset or remain contiguous");
                let payload = frame.payload.as_slice();
                out.write_all(&u16::try_from(payload.len())?.to_le_bytes())?;
                out.write_all(payload)?;
                frames += 1;
                bytes += payload.len() as u64;
                if paced {
                    deadline += Duration::from_millis(20);
                    deadline = deadline.max(tokio::time::Instant::now());
                    tokio::time::sleep_until(deadline).await;
                } else {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
            out.flush()?;
            reports.push(serde_json::json!({"iteration":iteration,"startupMs":startup_ms,"frames":frames,"bytes":bytes,"maxReadMs":max_read_ms,"elapsedSeconds":started.elapsed().as_secs_f64(),"filterUpdates":filter_updates,"filterUpdateMs":filter_update_ms,"stalls":stalls}));
            // A repeat must rebind cancellation before seeking the retained input.
            play_cancel.cancel();
        }
        println!("{}", serde_json::json!({"scope":"integrated source and volume processing, no Discord transport", "volume":70,"paced":paced,"staged":staged,"runs":reports}));
        Ok::<_, anyhow::Error>(())
    }).await;
    player.shutdown().await?;
    adapter.shutdown().await?;
    result.context("source audit timeout")?
}
