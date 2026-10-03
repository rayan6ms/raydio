# Playlist playback stopped after partial downloads — 2026-10-03

## Incident and cause

THE CLUB / comandos reported three consecutive track failures at 12:47 São
Paulo time, followed by idle disconnect at 12:49. Raydio did not crash or restart
(Oracle PID 34605, zero service restarts). The reported input was the YouTube
playlist `PLiqVPtLMK7NypiXPyWSgDr9dQTbnKz2fZ`, starting at `4kae32uj7dA`.

Oracle journal establishes the download → cache exhaustion → failure sequence:

| Generation | Start UTC | Source bytes | Cached at failure | Download elapsed | Track exception UTC / playback position |
| --- | --- | ---: | ---: | ---: | --- |
| 20 | 15:44:10.297 | 12,553,041 | 933,888 | 29.092 s | 15:45:07.054 / 55.720 s |
| 21 | 15:45:16.958 | 13,179,454 | 950,272 | 28.816 s | 15:46:14.820 / 57.220 s |
| 22 | 15:46:24.628 | 14,141,030 | 933,888 | 28.992 s | 15:47:21.969 / 56.560 s |

An earlier generation 16 cached 7,602,128 of 7,919,055 bytes before the same
timeout and failed later at playback position 461.880 s. The downloader remained
subject to the ordinary 30-second request limit, even when it continued receiving
bytes. The ~32 KiB/s transfer rate in the three later tracks could stay ahead of
audio consumption, but could not download each whole object in 30 seconds.
The cause of the lower upstream throughput is not established by these records.

Mantle's socket-origin regression reproduced TimedOut at 49,152 bytes from a
healthy 128 KiB source delivering 16 KiB every 100 ms with a 250 ms short timeout.
Extending only the body budget still failed with Ureq 3.4.0: its completed header
phase deadlines incorrectly applied during body reads. Ureq 3.4.2 includes the
upstream phase-budget fix introduced in 3.4.1.

## Correction

Progressive caches use a distinct 30-minute total download budget, validated
nonzero and at most one hour. An absolute deadline survives recovery. Setup
retains short phase budgets, body reads retain the ordinary timeout as an
inactivity limit, and cancellation polls at 100 ms. Default complete staging and
ordinary range streaming retain their short deadline. The source bytes, codecs,
volume, prefix, memory limits and sender pacing are unchanged.

The three-failure policy remains: genuinely failed sources cannot loop forever.
Lifecycle diagnostics now include guild ID and queue length; source failures
also include track duration and previous failure count, without credentials,
exception text, source URLs or encoded tracks.

## Verification

The paced-origin regression now returns every byte after roughly 0.7 seconds,
past the short deadline. Negative regressions cover inactivity, continuous
trickling past the total deadline, ETag recovery unable to reset that deadline,
and complete staging retaining its original deadline. Existing range identity,
truncation, cancellation, replay, proxy and media tests remain required.

Mantle media all-target tests pass (existing live/environment exclusions
unchanged); Clippy passes with warnings denied. Advisory/license/Cargo Vet
gates pass, with reviewed Ureq 3.4.0 → 3.4.2 and protocol 0.6.1 → 0.6.4 delta
audits and no exemptions. Deployment and live playlist evidence follow below.

This fix addresses the demonstrated permanent stop. Sender scheduling delays,
downstream packet loss and receiver concealment require their own measurements;
an incidental short live check cannot establish six-hour reliability.

## Oracle deployment and live check

Mantle `aba9bb1` and Crust `32b923b` are pinned by Raydio `a49eb65`. The
Debian 12 / Rust 1.97.1 release passed offline backend checks, checksum
verification and Discord readiness through the existing rollback-capable
`raydioctl`. Package size is 7,541,268 bytes, SHA256
`c47d3423cf792320a3537540f58638fcb24ea292e3b0190e5b58cc5b41f500d5`;
maximum required glibc symbol version remains 2.34. Production is active as
PID 37145 with zero automatic restarts; Testbot remains inactive.

The supplied playlist was submitted through Discord's signed-in T3 browser in
test / chat, with that browser joined to General. It queued 22 tracks. Loop
remained off to preserve ordinary playlist behavior. First playback began at
16:46:31.731 UTC, about 4.34 seconds after the send click returned.

| Track | Source / fully cached bytes | Download time | Result |
| --- | ---: | ---: | --- |
| Megafunk GAITAÇO DJ João Vitor | 8,934,074 / 8,934,074 | 5.958 s | Continued beyond six minutes; no source failure |
| MEGA GAITAÇO 2020 Part 9 - ( DJ Wellinton Olliveira ) | 9,731,564 / 9,731,564 | 11.613 s | Next control advanced the queue; continued beyond three minutes |

These sources finished downloading within 30 seconds under the current network
conditions. The paced-origin regression, not this live download speed, proves
the corrected behavior when a healthy progressive transfer outlives the short
deadline. The live check verifies deployment, playlist loading and playback.

| Receiver metric | First track: 16:47:09–16:52:09 UTC | Second track: 16:55:08–16:56:28 UTC |
| --- | ---: | ---: |
| Receiver / PCM observation | 299.999 / 300.011 s | 79.999 / 80.000 s |
| Received packets | 14,993 | 4,000 |
| Net loss / discards | 0 / 3 | 0 / 0 |
| Concealed / silently concealed audio | 150.063 / 0 ms | 0 / 0 ms |
| Clipped / nonfinite / empty frames | 0 / 0 / 0 | 0 / 0 / 0 |
| Longest PCM quiet interval | 10 ms | 10 ms |
| Connection interruptions | 0 | 0 |

Both recordings pass poll, PCM, speaking, track-phase, stable-buffer and event
coverage. No test controls were touched during either measured interval. Builds,
packet capture and network probes were absent. One mid-recording browser status
read checked that collection was running; source/host logs were retrieved after
each recording. Oracle's bounded sampler ran at nice 19 every ten seconds;
smaps was read only at that cadence. Process PSS during the first measurement
was stable at 16,766 KiB (16.37 MiB), with about 3.77% of one CPU core.

The controlled browser used its previously accepted 120 ms receiver-buffer
helper throughout, with no setting changes or browser long tasks. This preference
does not configure other Discord clients. Tracks and network conditions differ
from previous experiments, so no matched packet-quality improvement is claimed.

The first recording retains four concealment events and three discarded packets.
Oracle checkpoints also retain three sender gaps ≥40 ms (maximum 69.508 ms),
six skipped deadlines, zero source overruns, zero unavailable frames, zero
silence frames and zero send failures. The last 70.167 ms concealment event
follows the recorded sender gap at 16:50:42.491 UTC; its ten-second host interval
contains 29 CPU steal ticks. This is consistent with guest scheduling delay,
but these aggregated samples do not establish exact scheduler attribution.
The three earlier concealments/discards occurred before any recorded sender gap,
and remain downstream timing incidents without a proven cause. No memory
pressure or UDP error counter growth was observed in the sampled host window.

Validation: 245 Mantle media tests passed with eight existing environment/live
exclusions; 33 Crust adapter tests passed with two existing exclusions; all
58 Raydio tests passed; three collector tests passed, including song-boundary
classification with the additional guild/queue log fields. Relevant Clippy and
Mantle advisory/license/vet checks passed. The temporary sampler finished by
itself and both receiver observers completed. Raw aggregate reports, host
samples, sanitized lifecycle logs and the derived summary are retained in
[playlist-timeout-20261003](playlist-timeout-20261003/).
