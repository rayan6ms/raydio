use anyhow::Result;
use crust::{
    media::{LoadOutcome, LoadRequest, MantleAdapter, SourceRoute},
    routeplanner::RoutePlanner,
};
use crust_mantle_adapter::RealMantleAdapter;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    let adapter = RealMantleAdapter::with_defaults(RoutePlanner::disabled())?;
    let cancel = CancellationToken::new();
    for identifier in [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=5NV6Rdv1a3I",
        "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
    ] {
        let start = Instant::now();
        let loaded = match adapter
            .load(
                LoadRequest {
                    identifier: identifier.to_owned(),
                    route: SourceRoute::default(),
                },
                cancel.clone(),
            )
            .await
        {
            Ok(value) => value,
            Err(error) => {
                println!(
                    "{}",
                    serde_json::json!({"identifier":identifier,"stage":"load","error":error.to_string()})
                );
                continue;
            }
        };
        let LoadOutcome::Track(track) = loaded else {
            anyhow::bail!("expected track");
        };
        let player = adapter.create_player(cancel.clone()).await?;
        player
            .set_filters(
                crust::filters::FilterConfiguration {
                    player_volume: Some(70),
                    ..Default::default()
                },
                cancel.clone(),
            )
            .await?;
        let result = tokio::time::timeout(Duration::from_secs(45), async {
            player.play(track, cancel.clone()).await?;
            let mut frame_count = 0;
            let mut bytes = 0;
            for _ in 0..10 {
                if let Some(frame) = player.next_frame(cancel.clone()).await? {
                    frame_count += 1;
                    bytes += frame.payload.as_slice().len();
                }
            }
            Ok::<_, anyhow::Error>((frame_count, bytes))
        })
        .await;
        println!(
            "{}",
            serde_json::json!({"identifier":identifier,"elapsedMs":start.elapsed().as_millis(),"result":match result { Ok(Ok((frames,bytes))) => serde_json::json!({"frames":frames,"bytes":bytes}), Ok(Err(error)) => serde_json::json!({"error":error.to_string()}), Err(_) => serde_json::json!({"error":"timed out"}) }})
        );
        player.shutdown().await?;
    }
    adapter.shutdown().await?;
    Ok(())
}
