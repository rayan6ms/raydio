# Experimental isolated audio worker — 2026-09-21

Status: **six-hour Testbot-only Oracle run started** at 2026-09-22 00:15:53 UTC (September 21, 21:15:53 Brasília). Expected completion: September 22, 06:15:53 UTC / 03:15:53 Brasília. This is not a production promotion.

Candidate commits: Raydio `e7db90e`, Crust `25b217e`, Oto `e7dd066`. Binary SHA256: `3c17db1cfe0426ab32789d2525e767fdb8190ac4beefdef29a7200432b929e1f`. Oracle PID 53299; Raydio is stopped/disabled, and no local bot process is running. The unchanged production release remains installed.

The Discord receiver is connected, muted and not deafened. Playback and Loop ON were submitted through the signed-in UI; volume is 70. Receiver packets and PCM samples are advancing. Checkpoint persistence was verified against the current report identity; no requested WebRTC counters are missing. Oracle sender traces are present with zero dropped records at preflight. The host sampler, periodic journal saves, seven-hour maintenance restoration and local sleep inhibitor are active. The first natural loop was verified at 00:19:04 UTC: source generation advanced to 2, playback continued, the PID remained unchanged, and there were no source underruns or send failures. Short sender gaps and receiver concealment have already been recorded; the run is collecting them, not claiming flawless playback.

Evidence destinations: Oracle `/var/lib/raydio/queued-worker-six-hour-20260921`; local `evidence/queued-worker-20260921/six-hour`. The run manifest records identities/times. Keep the controlled browser and this machine running. Receiver/connection loss can still invalidate full-path coverage; no six-hour quality conclusion is available yet.

## Candidate

Eight raw 20 ms Opus frames in a bounded SPSC ring (10.3 KiB storage), plus at most one staged frame in the sender. The bridge checks capacity before asking Mantle for the next frame. One additional Tokio worker, shared across voice connections, runs the existing pacer, DAVE owner and UDP sender. The original capacity-one/main-runtime path remains the default; the candidate requires `experimental-audio-worker`.

DAVE and transport encryption still happen immediately before UDP transmission. No pre-encrypted audio, preassigned RTP sequence or old DAVE epoch is queued. The sender registers a duplicate UDP descriptor with its own reactor while retaining the original transport identity for gateway handback. Transport invalidation and same-packet bounded retries remain intact.

A successful UDP submission acknowledges queue drain. Natural completion and source failures are reported after the queued tail drains; replacement/stop cancels the old producer. Pause retains raw frames and suspends source demand. Resume preserves their order. Reported source position subtracts published-but-unsent audio; a concurrently completing source read can still contribute up to one frame of snapshot skew.

## Validation

- Oto default and isolated-worker suites: 112 passed, 9 ignored each. Includes pause/resume ordering, queue capacity/cancellation, successful-send drain, DAVE transitions, transport renewal, replacement and shutdown.
- Crust candidate library tests: 77 passed, 3 ignored. Includes real Oto pause with a finite buffered tail and delayed terminal callback.
- Playback integration suite: 11 passed, including REST pause/seek/resume and UDP delivery.
- Oto scoped Clippy passed; the pre-existing `result_large_err` lint is allowed. Crust candidate libraries passed strict Clippy.
- Bot candidate: 53 tests passed. Diagnostics: 27 Python tests plus checkpoint/endurance/audio-worklet simulations passed.

The integrated 160-packet synthetic test stalls the application's current-thread runtime for 100 ms after warm-up; an independent native receiver timestamps UDP arrivals. Both paths use the actual Oto Executor, DAVE owner and transport encryption. Baseline maximum arrival interval: **119.933 ms**. Candidate maximum: **21.397 ms** (20.608 ms during the injected stall). All 160 packets arrived in each test with zero send failures. This is controlled stall coverage, not an Oracle reliability or network-loss improvement claim. Raw outputs are in `evidence/queued-worker-20260921`.

The earlier standalone pre-encrypted queue prototype is not this implementation. Neither approach can prevent whole-VM descheduling or downstream packet loss.

Queued encoded audio can delay application of a later volume/filter change by the bounded queue depth; the audio itself is not re-encoded by this queue. This endurance trial evaluates continuity, not a claim of improved control latency.

## Six-hour acceptance

Run only Testbot on the existing Always Free Oracle instance; stop/disable Raydio but preserve its v0.2.2 release. Keep one receiver in test → General, repeat the same track at volume 70, and do not use controls during observation. No builds, fault injection, packet interception, or high-frequency probes during the run.

Collect header-only sender timing, connection/source generations, DAVE failures, queue depth, gateway/reconnect events, minute host/process/cgroup resources, independent local-host pressure samples, browser WebRTC counters, audio-worklet aggregates and receiver scheduling data. Persist receiver reports locally every minute and Oracle journals periodically. Preserve natural track-boundary classifications and receiver outages separately from unexplained silence. Do not equate successful UDP sends with remote delivery or browser net-loss counters with proven sender packet loss.

A complete, covered six-hour report is required before comparison with the previous complete baseline. Check both diagnostic coverage and maintenance/restart events before computing per-hour gap rates, lost/concealed fractions, clipping and unexpected silence. Production remains unchanged until the user reviews the results.
