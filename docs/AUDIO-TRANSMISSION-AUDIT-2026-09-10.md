# Audio continuity and transmission audit — 2026-09-10

Seven actionable findings were identified in the deployed dependency revisions.
Seven targeted characterization tests reproduce six findings; the seventh is
confirmed by configuration and call-site inspection. Three findings concern
permanent silence or failed recovery, two concern media recovery, one concerns
invalid DSP output, and one concerns missing stall detection.

**The latest 30-packet loss burst is real and concerning, but none of these
findings has been established as its cause.** This audit does not claim a fix,
a performance improvement, or a passed six-hour test. Only documentation and
reproduction artifacts are retained; the temporary test additions were removed
from the dependency checkouts. No deployment or Discord control was changed.

## Scope and versions

The audit follows the bot's actual path: Mantle source input and decoding →
Crust media actor and frame bridge → Oto pacing, DAVE and UDP → Discord receiver.
It uses the versions pinned by Raydio, rather than unrelated work in the original
project directories:

| Component | Revision | Reviewed checkout |
| --- | --- | --- |
| Oto | `352fa9a277377dbeb4f44513961c34f0785d870a` | `oto-rust-fix` |
| Crust | `4a05a7db7500884eee30f0d32041a55ab26b1ce1` | `crust-raydio-public` |
| Mantle | `88fbed2e6f32e5b3d021ede3cf9a279fecd54e98` | `mantle-rust-fix` |
| Raydio deployed code | `20f1cec` | `raydio-rust` |

Source references below are relative to the named repository at these revisions.
Raw test output, revision metadata and replayable test patches are in
[audio-transmission-audit-20260910](audio-transmission-audit-20260910/).
Previously fixed attachment, filter-drain, read-cancellation and EOF-event
defects are not counted again.

## Was packet loss this bad before?

| Observation | Duration | Received | Net loss-counter change | Sum of positive changes | Silent concealment |
| --- | ---: | ---: | ---: | ---: | ---: |
| Earlier EOF smoke check | 300 s | 15,000 | 0 | 0 | 0 ms |
| Previous interrupted dependency run | 9,091.592 s | 453,596 | 22 | 37 | 17,811.813 ms |
| Latest DAVE candidate | 300 s | 14,956 | 30 | 30 | 442.542 ms |

Sources: [earlier five-minute summary](../evidence/eof-live-20260910/summary.json),
[interrupted run](../evidence/dependency-fixes-20260910/results/summary.json),
and [latest summary](../evidence/dave-recovery-20260910/live/summary.json).

The latest nominal fraction is `30 / (14,956 + 30) = 0.2002%`. More important
than the average, all 30 positive loss increments appear in one approximately
one-second receiver sample, which received only 20 packets. Thirty 20 ms packets
represent 600 ms of encoded audio. The receiver reconstructed some of it, but
decoded PCM still had **441.771 ms of actual off-boundary silence**, ending at
12:15:22.216646 UTC. The speaking indicator also stopped briefly. This violates
the requested audio-continuity criterion.

These observations show a worse short-window outcome, not a controlled code
regression. The earlier long run had negative loss-counter corrections and the
confirmed receiver-network outage. Positive increments are not necessarily a
count of permanently lost, unique packets, and net loss can include late-arrival
corrections. Test durations, network conditions and source phases differ.

The sender's 12:14:23.495–12:15:23.495 interval brackets the latest incident:
3,000 frames sent, no new missed deadlines, source underruns, send failures or
active gaps above 40 ms. No DAVE transition or terminal failure was logged in
the receiver window. That argues against a 600 ms bot scheduling/source stall
and supports a delivery/receiver-path interruption. Successful UDP writes are
not delivery acknowledgements. Existing evidence cannot distinguish Oracle's
external path, Discord, the listener's path, or unobserved native receiver work.

## Findings, in recommended repair order

### A1 — Dropping an admitted audio operation can strand Crust in Busy

**Priority: high. Confirmed API lifecycle defect.**

Crust `crates/crust-oto-adapter/src/lib.rs:266`, `:341`, `:388`:
`set_source_inner` and `stop_audio_inner` replace the audio slot with `Busy`,
then await several operations. Completion calls `finish_audio`, but there is no
guard or independently owned operation that restores/completes the slot when
the public future itself is dropped. The cancellation token being an admission
gate does not protect against future destruction.

**Reproduction:** connect to the local fake voice gateway, attach a source,
poll `stop_audio()` once until pending, then drop that future. A subsequent
`set_source` returns `Overloaded`; `shutdown()` remains blocked after 50 ms.
The test repairs only its own slot to permit bounded cleanup. A cancelled
shutdown also leaves `closed=true` before cleanup has finished, so a later
shutdown can return success prematurely.

**Impact:** a timeout or cancelled task can prevent further playback on that
connection and obstruct cleanup. This is a direct public-API reproduction, not
proof that the live server abandoned that operation during the loss burst.

**Proposed fix:** give admitted audio operations a structured owner with tracked
completion, or a rollback guard that safely restores a usable/terminal slot on
drop. Preserve Oto's encoder/nonce ownership. Make shutdown completion durable
and distinguish it from shutdown admission; do not simply clear Busy while an
operation could still complete into a replacement binding.

**Acceptance:** cancellation before/after attach, replacement and Stop must allow
bounded shutdown and a valid retry, with no orphan producer, stale binding or
nonce reset. Test concurrent shutdown and replacement as well as token cancellation.

### A2 — A single UDP send error permanently terminates the sender

**Priority: high. Confirmed recovery-policy inconsistency.**

Oto `crates/oto/src/audio.rs:1084`, `:592`, `:670`; Crust
`crates/crust-oto-adapter/src/lib.rs:463`.

Oto turns any short/failed/timed-out UDP send into `SendIo` with
`RetryDisposition::RetryingInternally`. The error propagates out of the audio
executor, sets its durable state to Failed and tears down the attachment. Crust
converts a failed sender into a closed voice event, independently of the
retry disposition. No internal send recovery actually occurs.

**Reproduction:** the existing test injection exercises the send-error return
path once. After the sender fails, clear the injection and allow another 60 ms.
It remains Failed with one send failure and zero sent frames. This reproduces
the error policy; it is not a measurement of real UDP congestion or a real
Oracle syscall failure. The latest live incident had zero send failures.

**Impact:** a transient local socket error or 20 ms send timeout can become a
permanent session stop instead of a bounded interruption. The same review found
that Speaking write errors can escape to the sender while the gateway starts
its own resume; that adjacent interleaving needs its own regression before repair.

**Proposed fix:** classify retryable socket conditions separately from permanent
socket/protocol errors. Use bounded retry or transport renewal with preserved
source ownership and fresh monotonic crypto counters. Define what happens to
the unsent frame and avoid catch-up bursts. Retrying a transport operation must
not reuse a nonce or presume that every timeout proves non-delivery. Expose the
actual recovery action and exhaustion in typed state.

**Acceptance:** one injected recoverable error resumes; repeated errors reach a
bounded terminal state; Stop remains responsive; no duplicated source frame,
nonce reuse, plaintext fallback or packet burst occurs. Match error disposition
to the actual behavior.

### A3 — DAVE not-readiness has no overall progress deadline

**Priority: high reliability gap. Confirmed state-machine behavior.**

Oto `crates/oto/src/audio.rs:739`, `:971`; gateway
`crates/oto/src/gateway.rs:745`; DAVE command timeouts in
`crates/oto/src/dave.rs:15` and `:230`.

The new DAVE race fix correctly retains a frame and waits safely for readiness.
However, a successful epoch reset followed by no successor key/transition has
no overall readiness timeout or recovery budget. The two-second DAVE command
timeouts bound individual owner operations, not the wait for future protocol
progress. A healthy heartbeat alone does not prove that media can resume.

**Reproduction:** with the real DAVE fixture ready, send one frame, queue an
epoch reset ahead of the next media request, and withhold the successor setup.
After advancing Tokio's clock by 300 seconds, the sender is still Starting,
with exactly one frame sent and no failure. An initially unready fixture likewise
stays silent for 300 simulated seconds without failure. Stop remains responsive.
These tests deliberately keep connection state unchanged; they do not simulate
Discord's full recovery protocol or establish a real five-minute Discord timeout.

**Impact:** recovery can turn a crash into prolonged unexplained silence if key
setup never finishes. Raydio's track-end watchdog is not a short media-progress
watchdog and may eventually advance the song instead of repairing the connection.

**Proposed fix:** track protocol progress with a generation-aware deadline that
resets only on meaningful progress. On expiry, invoke bounded supported recovery
or surface a typed failure requiring fresh voice information. Retain normal
short rekeys and responsive controls; never send plaintext to escape the wait.

**Acceptance:** short rekey resumes the exact staged frame; absent successor
events trigger recovery within the documented budget; repeated non-progress does
not extend the budget forever; replacement/Stop invalidate old timers.

### A4 — HTTP retries exclude failures during response-body reads

**Priority: medium; higher for long, unstaged tracks. Confirmed resilience gap.**

Mantle `crates/mantle-media/src/http_input.rs:431` and `:1113`.

`call_with_retries` retries request/response acquisition. `HttpRangeInput::read`
returns a body read failure or premature EOF directly, without reopening the
range at the already consumed byte position. Rejecting a truncated response is
correct; treating every recoverable body disconnect as unrecoverable is the gap.

**Reproduction:** a local server advertises a stable 96-byte object and a valid
32-byte range, then closes after eight body bytes. Subsequent requests would
return the correct stable object. With `max_retries=3`, `read_to_end` still fails
with UnexpectedEof after eight bytes, and the server sees only one request.

**Impact:** an otherwise recoverable source interruption can stop an unstaged
track. Raydio stages finite objects up to 16 MiB, so a completed staged repeat
does not depend on source HTTP during playback. This is not an explanation for
the latest staged song's UDP loss burst.

**Proposed fix:** bounded body recovery from the precise consumed offset, using
the existing range and validator checks and an overall time budget. Fail if
object identity or the returned range cannot be established; never splice
different objects or restart from zero into an active decoder. Keep cancellation
responsive and close the abandoned response.

**Acceptance:** compare every recovered byte/frame against an uninterrupted
reference; test changed ETag/length, repeated disconnects, missing validators,
cancellation and retry exhaustion. Quantify restart latency and source buffer
coverage instead of masking failures with a larger unbounded buffer.

### A5 — Finite transcoder EOF destroys the seekable input

**Priority: medium. Confirmed seek/recovery defect.**

Mantle `crates/mantle-media/src/youtube_playback.rs:1037`, `:1067`, `:1131`,
`:1166`; Crust read-ahead at `crates/crust-mantle-adapter/src/lib.rs:925`.

The PCM transcoder removes its `MediaSession` at input EOF. `seek` subsequently
requires that session and returns AudioPipeline when it is absent, even though
the source was seekable. Filter/encoder drain and Crust's sixteen-frame read-ahead
can put input EOF ahead of what the listener has heard.

**Reproduction:** AAC, FLAC and resampled mono WAV fixtures all seek successfully
before EOF; all fail a seek to zero after being drained, with AudioPipeline.
The test proves the EOF-state defect. The near-end UI race follows from read-ahead
ownership and is not a separately measured Discord command race.

**Impact:** seek or position restoration near the end of a finite transcoded
track can fail. Normal staged looping reopens the input and is a different path;
this does not show that current loops are broken.

**Proposed fix:** preserve seekable input ownership separately from its EOF flag,
or reopen retained staged input on seek, then reset decoder/resampler/filter and
encoder state consistently. Avoid retaining unnecessary decoded buffers.

**Acceptance:** seek during final output drain and after EOF for each codec,
including resampled input; compare post-seek output against a fresh session and
verify bounded retained memory and correct source time.

### A6 — Accepted karaoke parameters can create silent invalid audio

**Priority: medium, conditional on enabling this filter. Confirmed DSP defect.**

Crust `crates/crust-server/src/player.rs:1434` and
`crates/crust-mantle-adapter/src/filters.rs:140`; Mantle conversion in
`crates/mantle-audio/src/transform.rs:39`.

Filter validation does not bound karaoke width/band or validate the resulting
coefficients. With finite `filterWidth=1000000`, the exponential coefficient
underflows to zero; the subsequent expression divides by zero and creates NaN.
The filter's process method returns success. Integer PCM conversion maps these
nonfinite values to zero, concealing the DSP failure as silence.

**Reproduction:** one normal 20 ms stereo frame produces 1,920 nonfinite samples;
conversion produces 1,920 zero samples without an error. The accepted-value
path is confirmed in server validation; the test directly exercises the runtime
filter and PCM conversion. Default karaoke settings and the volume-70 live run
do not use this failing parameter.

**Proposed fix:** validate supported parameter domains and finite coefficients
before replacing the current chain. Add a bounded invalid-output diagnostic or
typed error at the processing boundary; avoid silently accepting invalid DSP.
Preserve ordinary filter behavior and distinguish deliberate volume-zero silence.

**Acceptance:** boundary/large/invalid coefficients are rejected transactionally;
the previous valid chain remains active; valid extreme settings produce finite
PCM. Measure any added sample-validation cost before enabling a full scan per frame.

### A7 — Configured track-stuck detection is not wired to real playback

**Priority: medium observability/recovery defect. Confirmed by static tracing.**

Crust `crates/crust-server/src/config.rs:135` defines and validates a default
10,000 ms `track_stuck_threshold`. Repository-wide references only parse,
initialize and validate it. Real adapter construction does not receive it.
`TrackStuck` production handling serializes an event, but the real Mantle adapter's
only event creation is inside a `#[cfg(test)]` fixture branch.

**Impact:** operators can configure a stall threshold that never detects real
stalls. Source-read waits, DAVE readiness waits and intentional pause also need
different diagnoses; an end-of-song wall-clock watchdog cannot substitute for
those measurements.

**Proposed fix:** wire the threshold into the owning playback monitor, measure
actual progress and classify the blocking phase. Emit bounded events once per
incident/recovery. Do not use speaking-indicator state or low PCM energy alone
as a source-stall signal.

**Acceptance:** fake-clock tests for progressing playback, blocked reads,
intentional pause, natural EOF, DAVE recovery, resumed progress and generation
replacement. Prove that changing the configured threshold changes detection time.

## Additional opportunities requiring measurement

These are not counted as confirmed bugs or measured performance improvements.

| Area | Evidence and proposed experiment |
| --- | --- |
| Per-frame read scheduling | Crust `start_read_ahead` starts one blocking task per finite frame: nominally 50 dispatches/s. Profile time in dispatch, decode and encode separately. Compare a small bounded batch on the existing worker facility against current control latency, CPU and tail lateness. Preserve cancellation, buffered-frame identity and the existing memory ceiling; do not introduce another worker pool speculatively. |
| Gateway fairness | Oto uses biased selection with UDP readiness before WebSocket input, and drains at most 32 datagrams per turn. The bound limits one turn but does not guarantee WebSocket fairness under sustained UDP readiness. Use a bounded local fake peer to test heartbeat/DAVE progress under ordinary multi-participant traffic; no production flooding. This was not reproduced as a fault in the one-channel test. |
| Delivery feedback | Oto `drain_udp` discards all inbound datagrams. Sender counters cannot show which transmitted sequences reached Discord. Investigate supported receiver reports/feedback before adding protocol behavior. Do not assume the browser's NACK count means the bot received a retransmission request. |
| Codec resilience | Mantle's Opus wrapper exposes complexity but no explicit loss/FEC policy. Characterize supported settings against representative music and isolated losses, measuring bitrate, quality and CPU. Do not assume FEC can restore a 30-packet burst or change codec settings without evidence. |
| Decode corruption | Mantle skips up to eight consecutive Symphonia DecodeError packets before failing. Add bounded counters for skipped input packets and affected source duration, so damaged source material is distinguishable from transport loss. Compatibility policy and masking/recovery behavior need separate assessment. |

## Diagnostics needed before blaming a host or claiming uninterrupted audio

1. Use two simultaneous receivers on independent network paths, with peer/SSRC
   identity retained throughout. A shared failure implicates a different segment
   than a failure affecting only one receiver. A second tab on the same machine
   does not provide an independent network path.
2. Record bounded outbound RTP header sequence/timestamp and monotonic send time
   around incidents, plus local send error kind. Avoid audio/key/token payload
   capture, per-packet formatted logs and synchronous disk work in the sender.
   Validate instrumentation overhead before using it for acceptance results.
3. Keep counts and durations for every transition out of active sending, labeled
   by source wait, intentional pause, transport recovery and DAVE wait. Oto
   `pause_timeline` clears `last_packet_sent`, so active-gap counters intentionally
   exclude those intervals. Zero active gaps alone cannot prove continuous output.
4. Preserve the previous complete checkpoint as well as the first recovery one,
   exact state-transition times and the requested observation tail. Minute
   counters bracket an incident but cannot identify individual lost packets or
   every sub-minute state change.
5. Continue recording all quiet intervals. Match loop candidates against logged
   finish/start pairs and source waveform evidence; keep off-boundary silence,
   concealment, browser scheduling and network events separate. The existing
   source-tail reference is from an earlier build and is not a fresh waveform
   alignment of this audit's receiver audio.

The latest receiver had complete polling/PCM coverage and no overlapping recorded
browser long task for the 442 ms incident. Those are useful controls, not proof
that all native scheduling, remote services or network disturbances were absent.
Do not start another six-hour acceptance claim solely because the sender remained
connected or its average CPU and memory were low.

## Verification and reproducibility

All reproduction builds used one Cargo job and low process priority. No live
Discord credentials, cloud credentials, media payload captures or load tests
were needed. Tests used local fake peers/HTTP servers and existing audio fixtures;
the five-minute DAVE waits use Tokio's virtual clock, not real sleeps.

Decompress the corresponding `.patch.gz` from this document's artifact directory
and apply it to the exact revision in an isolated checkout (`gzip -dc <patch.gz>
| git apply -`), then run:

```sh
cargo test -j 1 -p oto --lib audit_ -- --nocapture --test-threads=1
cargo test -j 1 -p crust-oto-adapter --lib audit_dropped_stop -- --nocapture --test-threads=1
cargo test -j 1 -p crust-mantle-adapter --lib audit_finite_karaoke -- --nocapture --test-threads=1
cargo test -j 1 -p mantle-media --lib audit_transcoder -- --nocapture --test-threads=1
cargo test -j 1 -p mantle-media --test phase6_http audit_midbody -- --nocapture --test-threads=1
```

Results: Oto 3/3, Crust voice 1/1, Crust filters 1/1, Mantle playback 1/1
(three codec fixtures), Mantle HTTP 1/1. **Passing characterization tests mean
the defects were reproduced, not repaired.** No full-suite pass is newly claimed
by this audit. Raw outputs and patches are checksummed in `SHA256SUMS`.

Recommended sequence: A1–A3 for bounded recovery, A4–A5 for media resilience,
A6 for invalid DSP, and A7 plus the transport/receiver diagnostics before the
next acceptance run. Fixes should carry inverted regression expectations and a
short controlled receiver check before another six-hour run. These steps reduce
specific failure risks; they cannot promise zero loss across an external network.
