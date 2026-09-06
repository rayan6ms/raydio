//! Bounded compressed-source staging experiment; not a bot feature.
use anyhow::{Context, Result, ensure};
use mantle_media::{
    EncodedPacket, HttpRangeInput, HttpRangeOptions, MediaCancellation, MediaInput, MediaLimits,
    MediaSession, YoutubeAudioSourceManager, YoutubeAuthentication, YoutubeSourceOptions,
};
use std::{
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    time::{Duration, Instant},
};

fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("new staging file path required")?;
    let staged = std::env::args().nth(2).is_some_and(|s| s == "--staged");
    let started = Instant::now();
    let source = YoutubeAudioSourceManager::new(
        YoutubeSourceOptions::default(),
        YoutubeAuthentication::default(),
    )?;
    let cancel = MediaCancellation::new();
    let formats = source.discover_playback_formats("dQw4w9WgXcQ", &cancel)?;
    let url = source.resolve_selected_playback_url(&formats, &cancel)?;
    let mut input = HttpRangeInput::open_with_cancellation(
        url.as_str(),
        HttpRangeOptions {
            max_source_bytes: 8 * 1024 * 1024,
            ..Default::default()
        },
        cancel.clone(),
    )?;
    let expected = input.byte_len().context("finite source required")?;
    let mut fetch_stalls = Vec::new();
    let mut copied = 0_u64;
    let input: Box<dyn MediaInput> = if staged {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        // This diagnostic targets Linux. An unlinked file cannot accumulate
        // after cancellation, crash, or ordinary close.
        #[cfg(unix)]
        std::fs::remove_file(&path)?;
        let mut buf = [0_u8; 64 * 1024];
        loop {
            ensure!(
                started.elapsed() < Duration::from_secs(90),
                "staging deadline exceeded"
            );
            let read_started = Instant::now();
            let n = input.read(&mut buf)?;
            let ms = read_started.elapsed().as_secs_f64() * 1000.0;
            if ms >= 20.0 && fetch_stalls.len() < 500 {
                fetch_stalls.push(serde_json::json!({"offset":copied,"readMs":ms}));
            }
            if n == 0 {
                break;
            }
            copied += n as u64;
            ensure!(copied <= expected, "source grew during staging");
            file.write_all(&buf[..n])?;
        }
        ensure!(copied == expected, "incomplete staged media");
        file.seek(SeekFrom::Start(0))?;
        Box::new(file)
    } else {
        Box::new(input)
    };
    let mut media =
        MediaSession::open_with_cancellation(input, None, MediaLimits::default(), cancel)?;
    let startup_ms = started.elapsed().as_secs_f64() * 1000.0;
    let playback_start = Instant::now();
    let mut deadline = playback_start;
    let mut packet = EncodedPacket::with_capacity(media.limits().max_packet_bytes);
    let mut frames = 0_u64;
    let mut max_read_ms = 0.0_f64;
    let mut stalls = Vec::new();
    loop {
        ensure!(
            frames < 15_000 && playback_start.elapsed() < Duration::from_secs(360),
            "playback diagnostic limit"
        );
        let read_started = Instant::now();
        if !media.read_encoded(&mut packet)? {
            break;
        }
        let ms = read_started.elapsed().as_secs_f64() * 1000.0;
        max_read_ms = max_read_ms.max(ms);
        if ms >= 20.0 && stalls.len() < 500 {
            stalls.push(serde_json::json!({"frame":frames,"readMs":ms}));
        }
        frames += 1;
        deadline += Duration::from_millis(20);
        let now = Instant::now();
        if deadline > now {
            std::thread::sleep(deadline - now);
        } else {
            deadline = now;
        }
    }
    println!(
        "{}",
        serde_json::json!({"scope":"same Mantle compressed input and demuxer; no decode, filtering or Discord", "staged":staged,"sourceBytes":expected,"copiedBytes":copied,"startupMs":startup_ms,"fetchStalls":fetch_stalls,"frames":frames,"elapsedSeconds":playback_start.elapsed().as_secs_f64(),"maxReadMs":max_read_ms,"stalls":stalls})
    );
    Ok(())
}
