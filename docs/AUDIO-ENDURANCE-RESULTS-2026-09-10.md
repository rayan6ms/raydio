# Six-hour Oracle audio endurance result — 2026-09-10

The audit-fixes candidate (`2be406be22fd64f56adaccd45c2d115c27fd380c`, binary SHA-256 `c007862072d46a0ded0b8dbe93e030d8ba029ac7087f0ef213989586ba4f3002`) ran Testbot in `test → General` for the complete 21,600-second observation. Playback was Rick Astley’s “Never Gonna Give You Up” at volume 70 with Loop enabled.

## Coverage and audio output

- Receiver and PCM coverage: **21,600.0 s / 21,600 s**; all polling and PCM reports arrived.
- PCM reports/frames: 86,171 / 1,036,800,000; empty frames: **0**.
- Non-finite samples: **0**; near-full-scale/clipping samples: **0**; peak 0.573; RMS 0.0866.
- Receiver packet counters: 1,078,984 received, final cumulative loss 47, 567 discarded. Loss deltas were +228 and −181; the negative corrections show why final cumulative loss and positive loss must both be retained.
- Concealment: 2,211,182 samples (**46.07 s**) total, of which 648,447 (**13.51 s**) were silent concealment. These counters include short jitter recovery and the two transport outages; they are not equivalent to 46 seconds of audible silence.
- NACKs: 2,074. Receiver RTT ended at 24 ms. No receiver report gaps occurred.

The source’s independently decoded natural tail is 938.46 ms. The repeated approximately 0.976-second quiet intervals at loop boundaries therefore match the source tail and are expected. They are retained in the report and were not excluded from quality totals.

## Confirmed interruptions

Two mid-song intervals exceeded the source-boundary reference:

| Receiver time | Duration | Evidence |
| --- | ---: | --- |
| 18:42:48 UTC | **8.31 s** | Receiver delivered zero packets for multiple one-second polls; silent concealment accumulated; ICE/connection changed to `disconnected`, then recovered after about 1.97 s. |
| 22:44:28 UTC | **1.46 s** | Receiver delivered zero packets, then a 42-packet loss burst and concealment; the interval was mid-song and not a natural boundary. |

The first outage began before the browser’s disconnected event, so the event timestamp is not the full outage duration. The 8.31-second PCM quiet interval is the direct audio measurement.

## Sender and host correlation

Oracle’s sender journal covers 360 one-minute checkpoints inside the receiver window. It reports:

- `send_failures=0`, `source_overruns=0` and no sender gap ≥100 ms or ≥1 s.
- 1,076,449 frames sent during the receiver window; only 6 frames were unavailable/silence frames.
- 282 skipped pacing deadlines and 228 active send gaps over 40 ms; the maximum active send gap was 96.01 ms.
- Sender frame counts continued across both receiver outages. No DAVE, source, decoder, or process restart failure was logged.

This separates the causes: the two long silences were Discord/WebRTC delivery or path interruptions after the bot continued sending, rather than a source-read, decoder, or Rust audio-loop stall. A single receiver cannot identify which network hop caused delivery loss.

Oracle resource samples during the receiver window show 5–6 threads, 16.3–16.7 MiB PSS (16,689–17,097 KiB), 18.7–19.1 MiB RSS, and approximately 4.00% of one CPU core. No cgroup memory events, OOM events, or host UDP receive errors were observed. The production `raydio.service` stayed disabled; the isolated Testbot service was stopped after collection.

## Conclusion and next action

The candidate is stable at the source and sender layers and meets the six-hour coverage and PCM-integrity requirements. It does **not** meet a strict “no audible interruption under every network condition” guarantee: the receiver observed two transport outages totaling about 9.77 seconds. The actionable remaining issue is transport resilience/Discord path behavior, not another reproduced media-codec or sender starvation bug. Future qualification should keep the same receiver and sender correlation and report transport outages separately from natural track tails.

Evidence is preserved under [`evidence/audit-fixes-20260910/results`](../evidence/audit-fixes-20260910/results) and [`evidence/audit-fixes-20260910/oracle`](../evidence/audit-fixes-20260910/oracle).
