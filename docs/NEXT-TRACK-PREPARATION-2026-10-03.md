# Preparing the next queued track — 2026-10-03

## Cause and change

Raydio resolved playlist metadata upfront, but waited for natural TrackEnd to
discover/open the next media object and fill its progressive prefix. The supplied
playlist reproduced 2,160.803 ms from the current track's finish event to the next
start event. The receiver observed 5,247.771 ms of quiet across that boundary;
this includes silence in the recording itself and must not all be called a bot
interruption. It also reported 1,991.271 ms of concealment, with 1,947.5 ms silent.

Raydio now schedules preparation of the immediate upcoming finite track when
the current track has at most 45 seconds remaining. At most one HTTP intent is
owned by the guild session; queue changes coalesce in submission order. Clear,
reorder, shuffle, remove, pause, loop changes, Stop and disconnect all recompute
or cancel the target. An acknowledged request overtaken by Stop is still tracked
so its stale server intent can be cancelled. Same-track natural loops continue
using their existing completed compressed cache.

Crust exposes an authenticated, structurally bounded preparation extension without
changing Lavalink's player update schema. Mantle's adapter actor owns one
speculative opener and one ready session, keeping current frame/command delivery
independent of network preparation. Cancellation joins/disposes of the old source
on the blocking worker before opening another. Opening owns the existing global
load/source/connection admission; ready sources release load/source slots while
retaining connection admission until adoption/disposal. There is no hidden queue
of detached speculative workers.

Adoption uses the ordinary Mantle playback pipeline with the current volume and
filters, normal frame sequence reset, and existing lifecycle generation checks.
Speculative opening errors leave current playback alone and permit normal loading
at handoff. No codec, bitrate, packet pacing, audio worker or receiver-buffer
change accompanies this feature. Each source keeps the existing 16 MiB compressed
staging ceiling in Raydio, plus its normal bounded decoder state; only one source
is prepared. A track queued too late, a live source, or failed
preparation can still require ordinary startup. Source recordings may contain
intentional silence, and this feature does not crossfade or trim their samples.

## Offline verification

Crust's adapter has 38 passing tests and two existing manual benchmarks ignored.
All server targets pass, including request authentication/validation, player
lifecycle isolation and the standalone binary (its missing progressive-options
initializer was corrected). Warnings-denied all-target Clippy passes in Crust
and Raydio. Raydio has 60 passing unit/integration tests, including the new
extension through embedded Crust and queue lead-time/target changes.

Regression cases cover every synthetic frame across natural EOF/adoption, latest
filters, failed preparation, cancelled Play, 100 coalesced replacements, frame and
Stop delivery during a slow opener, and global admission held until actual source
cleanup. A deterministic 200 ms source-opening delay measures 202.103 ms cold
versus 0.083 ms prepared. This establishes avoidance of source setup, not an
end-to-end Discord timing guarantee.

## Live method

The same playlist is requested in test / chat with Raydio and the controlled
browser joined to General; THE CLUB is not used for tests. Loop stays off, and
the first track ends naturally into the second without Next, seek, restart or
controls during observation. The observer keeps its existing 120 ms receiver
helper, records decoded PCM, track phases, connection/ICE events, packet counters
and browser scheduling, and retains silence at track boundaries. The first tracks
are “Megafunk GAITAÇO DJ João Vitor” (9:25) and “MEGA GAITAÇO 2020 Part 9” (10:01).

Baseline recording: 17:33:25–17:39:25 UTC, 360 seconds. The baseline receiver
remained connected, with zero browser long tasks and zero missing PCM reports.
Bounded local validation work overlapped part of this recording. Receiver/network
totals are observations rather than statistical evidence of a network-quality
change; Oracle finish/start timestamps directly measure the loading delay.

Evidence is in [next-track-preparation-20261003](next-track-preparation-20261003/).

## Oracle result

Raydio `2e669b4` pins Crust `a229515`; Mantle and Oto pins are unchanged. The
checksum-verified native release passed offline backend checks and systemd
Discord readiness. Package size is 7,566,748 bytes (25,480 bytes above the prior
package), SHA256 `aeaa70f47ddde49a199fa460ec5cd6c2378d8fc1ed4e9bb0a6d760d6245eb1b7`.
Maximum required glibc remains 2.34.

Candidate receiver recording: 18:01:30–18:07:30 UTC, 360 seconds, with no local
build/probe or playback controls during collection. The upcoming source opened
at 18:04:46.045, and all 9,731,564 compressed bytes were cached by 18:04:53.740,
34.1 seconds before the current track ended. The next song then used that
prepared session, with no new discovery/download at the boundary.

| Metric | Baseline | Prepared successor |
| --- | ---: | ---: |
| Bot finish → next start | 2,160.803 ms | 3.518 ms |
| Decoded quiet across the same song boundary | 5,247.771 ms | 3,167.771 ms |
| Total receiver concealment | 1,991.271 ms | 5.5 ms |
| Silent concealment | 1,947.5 ms | 0 ms |
| Received packets in six minutes | 17,896 | 18,000 |
| Net lost / discarded packets | 0 / 0 | 0 / 0 |
| Clipped / nonfinite samples | 0 / 0 | 0 / 0 |
| Sender gaps ≥40 ms / skipped deadlines | 1 / 2 | 0 / 0 |
| Sender unavailable frames / source overruns | 5 / 0 | 0 / 0 |
| Browser long tasks / missing PCM reports | 0 / 0 | 0 / 0 |

The directly measured loading delay is 99.84% lower. Decoded quiet is 2.080 s
shorter. Candidate packets continue across the boundary with no concealment
there; its 5.5 ms concealment event occurs earlier, during ordinary playback.
The approximately 3.17 seconds still quiet at the boundary include the ending
and beginning encoded in these recordings. This interval is retained rather
than incorrectly counted as packet loss or a new bot interruption. Peak PCM is
identical in both windows (0.7053132653), and regression coverage verifies the
same playback/frame pipeline. These six-minute observations do not establish
six-hour reliability or a general fix for downstream network loss.

Candidate PSS median/max during playback is 16,922/17,342 KiB (16.53/16.94 MiB).
The preparation period is sampled at 17,342 KiB, about 0.41 MiB above the playback
median, and CPU averages 3.85% of one core over the sampled active interval.
The bounded host sampler has 91 samples over 900 seconds, with zero errors. It
finishes and is automatically collected by systemd. Post-session authenticated
idle PSS is 17,269 KiB versus the old process's 17,716 KiB; differing process
history means this is not an attributable idle-memory optimization claim.

The test queue was stopped only after observation completed. Production Raydio
remains enabled/active on Oracle (PID 37427, zero automatic restarts); Testbot is
inactive. The existing home-source companion and tunnel are preserved. The
previous release remains available through `raydioctl rollback`.
