# Bounded sender queue validation — 2026-09-15

## Decision

**Do not promote this prototype to Raydio or start a six-hour Discord test of
it.** Incremental buffering demonstrably absorbs a bounded Tokio runtime stall.
The matched Oracle loopback runs do not establish better continuity on the
actual host, and the production source/control/DAVE contracts are not yet
implemented by this test-only prototype. Raydio v0.2.2 remains deployed;
Testbot remains stopped. This is a conditional validation outcome, not a
completed production integration or a claim that queues can never help.

## Correction to the previous experiment

The September 14 candidate pre-encrypted all 185 frames and supplied them from
a second native producer. The nominal eight-slot (160 ms) queue therefore
appeared to survive a 250 ms runtime stall. The source vector alone retained
481,000 bytes, omitted from its 20,800-byte ring-storage figure. Those numbers
cannot support promotion. The old report and JSON now explicitly mark this
limitation, retaining the original observations instead of overwriting them.

The replacement experiment lives only in Oto's Linux test module
`crates/oto/src/sender_queue_experiment.rs`, based on the deployed Oto revision
`e205f9a3f44be36fab2fa3cd48ef113cbb0f4d1f`. It is not in a release library.
Final experiment commit: [`3a20b68`](https://github.com/rayan6ms/oto/commit/3a20b68),
branch `experiment/independent-sender-queue`.

## What the replacement measures

Both paths use a capacity-one Oto owned source channel, an incremental Tokio
producer, the actual DAVE owner and transport encryption, and two Tokio workers
(the bot default). Maximum-size synthetic 1,275-byte inputs stress the crypto
path; they are not decoded music. No candidate audio vector grows with run
length, and there is no native feeder. The candidate has an eight- or
sixteen-slot fixed ring and one native sender worker. Raw Opus is retained for
potential re-encryption; RTP and transport nonces are assigned at transmission.

An independent receiver continuously drains loopback UDP. Every datagram is
transport-authenticated; RTP sequence, timestamp and nonce continuity are
checked. Candidate encrypted payload digests are matched with preparation-time
digests. This is a corruption/order check, not DAVE receiver decryption or an
audibility test. Exactly five terminal silence frames are checked separately
and excluded from the music-interval statistics.

The final local and all Oracle runs also retain successful UDP submission
intervals from Oto's bounded send trace (the candidate uses the same trace
writer). These distinguish sender pauses from delayed receiver scheduling.
Full interval arrays and tool output are retained. There is no active browser,
no Discord control input and no source download during these loopback runs.

Fault injection is coordinated by a separate native test thread. It submits
bounded blockers to the runtime's global queue and waits for all requested
workers to stop. Counters prove that both source production and candidate
DAVE preparation make **zero** progress during a full-runtime stall. Blocking
only one of two workers allows production to continue. All condition-variable
waits and the enclosing process are time-limited.

An earlier two-worker injector deadlocked because a worker blocked before a
locally spawned task could reach its rendezvous. Only that owned test process
was terminated. This was a benchmark failure, not a bot failure. The corrected
injector uses external coordination and bounded waits; its runs completed.

## Controlled local results

Representative final traced runs; cells show maximum **send** interval in ms.
Each scenario sends 180 music + 5 silence packets, all received. The separate
untraced repetitions corroborate bounded coverage; see the raw logs.

| Fault | Current sender | Eight slots (160 ms) | Sixteen slots (320 ms) |
|---|---:|---:|---:|
| Both workers blocked 100 ms | 101.408–101.640 | 20.163 | 20.177 |
| Both workers blocked 250 ms | 251.391–251.567 | 91.358 | 20.175 |
| Both workers blocked 400 ms | 400.875–401.252 | 241.275 | 81.160 |
| One of two workers blocked 100 ms | 20.736–20.744 | 20.195 | 20.182 |
| Native sender itself blocked 100 ms | n/a | 100.115 | 100.174 |

This demonstrates finite protection, including failure when a stall outlasts
the prepared audio. The native sender does not protect against its own
scheduling pause, whole-VM descheduling, or downstream network loss. Surviving
a deliberately blocked runtime is not equivalent to improving Oracle playback.

## Oracle matched comparison

Existing São Paulo `VM.Standard.E2.1.Micro`, Ubuntu 24.04, same two-worker
executable and source fixture. Runs were sequential, in order current1,
native1, native2, current2, native16, current3. Each used a new process and
3,000 music frames (about one minute), plus five silence packets. No build ran
on Oracle and no service was restarted. Raydio stayed idle/active; Testbot was
inactive. These runs describe the existing shared VM, not an isolated host.

| Run | Queue slots | Max send interval | p99.9 send interval¹ | Send gaps ≥40 ms | Packets received |
|---|---:|---:|---:|---:|---:|
| current1 | 0 | 31.744 ms | 24.631 ms | 0 | 3,005/3,005 |
| native1 | 8 | 33.823 ms | 27.530 ms | 0 | 3,005/3,005 |
| native2 | 8 | 30.316 ms | 26.901 ms | 0 | 3,005/3,005 |
| current2 | 0 | 30.404 ms | 24.498 ms | 0 | 3,005/3,005 |
| native16 | 16 | 65.755 ms | 59.859 ms | 3 | 3,005/3,005 |
| current3 | 0 | 37.400 ms | 31.844 ms | 0 | 3,005/3,005 |

¹ Sorted element `ceil(0.999 × (n−1))`; arrays contain 2,999 music intervals.

The eight-slot path tightens ordinary intervals, but has no demonstrated
reduction in ≥40 ms gaps and overlapping tail timing with the baseline. The
sixteen-slot run has three actual sender gaps, also visible at the receiver.
This rules out attributing those gaps solely to receiver scheduling. It does
**not** identify their scheduler/host cause or prove that queue capacity caused
them: there was no simultaneous CPU-steal/context-switch capture. Six minutes
of sequential synthetic loopback data cannot establish a rare-event rate,
Discord path loss, concealed audio, or perceptual quality.

The native benchmark used roughly 0.95–1.00% of one logical CPU in its first
three Oracle runs, versus 1.23–1.41% in the first two current runs. These costs
include synthetic production, DAVE, receiver/trace instrumentation and a
short-lived fault coordinator. The prototype omits parts of the production
lifecycle/state bookkeeping, so this is **not** a measured bot CPU saving.

## Memory and allocations

- Eight/sixteen ring slots retain 20,800/41,600 bytes. One preparing/admitting
  frame and one native in-flight frame can also exist, plus the source channel,
  source producer's temporary frame, reusable DAVE buffers, and transport buffer.
- One extra sender stack requests 256 KiB. A stack reservation is not resident
  memory. DAVE/runtime/task/control state and allocator overhead are additional.
- The one-minute receiver reserves 6,226,360 bytes of capture records; the send
  trace reserves 336,560 bytes. Candidate digest metadata reserves 24,040 bytes.
  These are test instrumentation, explicitly reported separately from the ring.
- Per-process PSS is sampled at approximately packet 50, not at peak residency
  or after all capture pages have been touched. It must not be reported as
  authenticated idle bot memory or subtracted to claim a precise queue cost.
- The exclusive allocation probe now includes the owned channel, source
  generation, real DAVE actor, native pacing/transport and UDP receiver.
  **Zero allocations/reallocations over 100 frames after 64 warm-up frames.**
  A preliminary 16-frame warm-up still encountered two lazy allocations; the
  zero figure describes steady state, not startup or lifecycle operations.

No memory reduction in the actual bot is claimed.

## Production integration requirements found in review

These are limitations of introducing this prototype, not claims that the
current deployed sender has these queue-induced bugs.

1. **Pause/resume must retain unsent audio.** Crust currently increments the
   source generation on pause, calls `stop_audio`, then attaches a new source
   on resume (`crust-server/src/player.rs`, `refresh_audio` and
   `apply_voice_audio`). Simply dropping a deeper queue would skip up to its
   retained tail because Mantle has already advanced. Draining it would instead
   delay pause. The integration needs a distinct acknowledged pause operation,
   retained frames, and consumption-aware position/EOF reporting.
2. **EOF must follow actual queued playback.** `MantleVoiceSource::next_frame`
   reports `SourceTerminal` as soon as its source is exhausted. The capacity-one
   bridge acknowledges copying, not UDP submission. Prefetching a larger tail
   can move the TrackEnd/loop replacement ahead of delivery and cancel music.
   Crust's `VoiceConnection` contract explicitly currently permits exactly one
   staged frame. It cannot silently be changed by substituting a worker.
3. **DAVE fences must be owned by real transitions.** The prototype manually
   fences, returns raw frames and re-encrypts them. Oto's current DAVE owner
   snapshot contains readiness/version/transition, not a prepared-packet epoch
   permit shared with the native sender. A same-ready-state transition or a
   queued control can overtake prepared frames. Production requires a fence
   before key changes, in-flight exclusion, ordered replay and shutdown handling.
4. **Transport and diagnostics must keep ownership.** Gateway still drains
   incoming UDP on its Tokio socket; `TransportValidity` excludes old/in-flight
   sends. A native worker must safely share the socket, hand its advanced
   encoder back at detach, retain bounded UDP retry behavior, preserve all
   counters/traces, and handle reinstallation/nonce exhaustion. The test
   worker's immediate UDP-error failure is not equivalent to Oto's recovery.

The explicit prototype fence regression passing is not proof of any of these
production behaviors. Shipping it now would violate the requested feature and
behavior parity. The available Oracle data does not justify that promotion.

## Verification and reproducibility

Oto release unit suite: **110 passed, 8 ignored**. The exclusive channel/DAVE
allocation probe and prototype fence/pause/rekey/source-replacement regression
pass. Formatting passes. Strict Clippy still reports the pre-existing
`gateway.rs:1639` large `InstalledTransport` error variant. Clippy passes with
only that lint excluded; no production error type was changed to silence it.

Build with pinned Rust 1.97.1 and `CARGO_BUILD_JOBS=1`, then run the test binary
alone (one test thread). Local timing and builds were sequential.

```sh
OTO_QUEUE_WORKERS=2 OTO_QUEUE_DEPTH=8 timeout 90s ./probe \
  compare_runtime_stalls --ignored --nocapture --test-threads=1
OTO_QUEUE_WORKERS=2 OTO_QUEUE_DEPTH=16 OTO_QUEUE_REVERSE=1 timeout 90s ./probe \
  compare_runtime_stalls --ignored --nocapture --test-threads=1
OTO_QUEUE_WORKERS=2 OTO_QUEUE_ONLY=current OTO_QUEUE_FRAMES=3000 timeout 85s ./probe \
  compare_runtime_stalls --ignored --nocapture --test-threads=1
# Repeat in another process with OTO_QUEUE_ONLY=native and chosen depth.
```

`evidence/sender-queue-20260915/results.json` is parsed from raw logs, with
interval arrays and log hashes; it is not manually transcribed. Early callback
and untraced runs are labeled by their source log and are not mixed into the
final Oracle table. Timing executable SHA-256:
`2cb205b68b87eded407c08517eb762de02ef0472d690830e7a5f7c1d93ffb40a`.
Final source adds Debug derives/direct expect for Clippy, a Linux-only module
guard for `/proc`/rustix, and validation of the manual benchmark selector;
those do not change the measured sender algorithm.

## Oracle access and final state

SSH initially timed out because this machine's current public IP was absent
from OCI's TCP/22 allowlist. OCI read-only checks confirmed the single free VM
was running at its existing address. Added only the current administrator's
`/32` TCP/22 rule with ETag protection, preserving all existing rules and
outbound policy. SSH then worked. No instance restart, second instance, paid
resource, or service deployment was performed. Final service/resource state
and the remote test binary hash are retained in `oracle-final-state.txt`.
