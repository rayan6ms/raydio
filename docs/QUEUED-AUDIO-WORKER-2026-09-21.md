# Experimental isolated audio worker — 2026-09-21

Status: integration validated; preparing Testbot-only Oracle endurance run. This is not a production promotion.

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
