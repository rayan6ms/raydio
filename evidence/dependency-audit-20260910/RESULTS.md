# Crust, Oto, and Mantle dependency audit

Audit date: 2026-09-10 UTC. The audit used the exact revisions pinned by the Rust Raydio rewrite:

- Crust `dba892f8e12dca582db6848acae9f37b8a1ffc5e`
- Oto `1869e671d086386be7ecb5bb58674008d6b7a62f`
- Mantle `6366cc60a46df7712f1e41219050dedc4cd190cc`

The production checkout and Oracle Testbot were not changed. Reproduction-only tests were added in detached worktrees under `/home/rayan/Documents/Projects/.dependency-audit-20260910`; those tests are not production fixes.

## Findings

### M1 — filter changes discard decoded audio and can create an audible gap (high)

**Path:** Mantle `crates/mantle-media/src/youtube_playback.rs`, `PcmTranscoder::set_filter_factory` around lines 1130–1175, called by Crust adapter `PlaybackSession::set_filters` around lines 600–620. The replacement resets `decoded`, `resampled`, `assembled`, encoder input, resampler, encoder, and filter state while a decoder may already hold samples that have not been emitted.

**Reproduction:** The audit test opened local fixtures and changed to an identity filter after the first encoded frame. Baseline versus changed frame counts were:

| fixture | buffered samples at change | baseline | after change | lost audio |
| --- | ---: | ---: | ---: | ---: |
| FLAC | 7,296 | 300 | 297 | 60 ms |
| AAC 24 kHz (resampled) | 2,048 | 103 | 100 | 60 ms |
| MP3 | 384 | 302 | 301 | 20 ms |
| AAC 48 kHz | 128 | 302 | 302 | below one 20 ms output frame |

This affects volume and Lavalink filter updates because Crust's filter factory includes player volume and all nontrivial DSP. A user changing volume/equalizer during playback can hear a discontinuity, and the dropped source position is not recovered. Fix by applying a replacement at a frame boundary after draining already decoded/assembled data, or by retaining a bounded pending input and explicitly defining a transition; do not reset the source position while unplayed PCM exists. Add fixture tests for every supported codec and resampler path.

### M2 — changing filters after finite EOF reaches `unreachable!` (high reliability)

**Path:** Mantle `PcmTranscoder::read_frame`, around lines 974–979, treats `PcmTranscodePoll::NeedInput` as impossible. `set_filter_factory` resets `input_eof` to false after `finish_input` has set `session=None`. The next read cannot obtain input and returns `NeedInput`, so the `unreachable!` panics.

**Reproduction:** Drain `tone-aac-lc.m4a` to EOF, install an identity filter, then read one frame. The audit test catches the panic at the `unreachable!` site. In a server process this is a task panic; depending on the owning actor, it can terminate a player or lose the track rather than returning a normal terminal event.

Fix the state machine so a replacement after EOF either returns `Ended` safely (and keeps the completed input available for an explicit repeat) or reopens a fresh finite session before clearing EOF. Never use `unreachable!` for a state reachable through the public filter API. Add a regression test without `catch_unwind` once fixed.

### C1 — Oto can lose a transport encoder when `start_audio` is cancelled after gateway attach (medium/high)

**Path:** Oto `crates/oto/src/gateway.rs`, `attach_audio` around lines 1521–1544. The gateway takes `active.encoder` and sends it through a oneshot. If the receiver is dropped after the send has succeeded (the caller future is cancelled), `reply.send` returns `Err(Ok(returned))` only when the receiver was already gone at send time; the race where the send succeeds and the receiver is dropped immediately afterward leaves `attachment` installed and the gateway encoder absent. A retry sees `ResourceLimit` (`"the current transport encoder is already attached"`).

**Reproduction:** The audit test models the exact sequence: attach succeeds, drop the response and update receivers, then attach again. The second attach returns `ResourceLimit` and `transport.encoder.is_none()` is true. This is a connection-local stuck state until reconnect. Fix ownership so the gateway keeps a recoverable attachment guard until the caller acknowledges/installs the `AudioControl`, or have cancellation send a bounded detach/return command carrying the same encoder. Do not reconstruct an encoder with a fresh nonce state.

### C2 — Oto pacer registration cancellation can retain an idle coordinator slot (medium, scalability)

**Path:** Oto `crates/oto/src/pacer.rs`, `Pacer::register` and `run_coordinator` around lines 80–120 and 265–287. Registration enqueues a `Register` command and waits for a oneshot. If the future is dropped after the coordinator sends the reply but before the `PacerRegistration` value is constructed, no `Drop` guard can mark `live=false`. The coordinator keeps the slot indefinitely; its closed deadline channel is retained in the `HashMap` and scanned on every scheduling iteration.

**Reproduction:** Applying `Register`, dropping the response and deadline receiver, and running the coordinator’s cancellation retain predicate leaves one slot (`retained_slots=1`, closed receiver, no deadline). In normal one-channel operation this is small; repeated connect/attach cancellation makes coordinator scans and memory grow. Fix with a registration transaction/rollback command, or mark the shared `live` flag false before awaiting the reply and only publish the handle after a successful acknowledgement.

### C3 — Crust controls can wait behind a blocking source read (medium, user-visible latency)

**Path:** Crust adapter `PlayerActor::start_read_ahead` and `settle_read` around lines 795–838, and `with_session` around lines 1124–1147. A finite read is moved to `spawn_blocking`; controls settle that task before seek, stop, filter replacement, and play proceed. The source request policy permits a 30-second socket/request timeout. The actor therefore cannot process a stop or seek while a source read is stalled.

**Reproduction:** The audit actor test supplied a read task blocked on a oneshot. `Stop` remained pending after 100 ms and completed only after the read was released. This is deterministic proof of head-of-line blocking; a real HTTP stall can extend it to the configured request timeout. The public request cancellation may return to the caller, but the queued command has no cancellation token and can execute later after the stall, producing stale stop/seek/filter effects.

Fix source reads with a cancellation-aware bounded operation, and carry the command cancellation token into every mutating command. If a read cannot be interrupted, let the actor invalidate the read generation and discard its result before applying newer controls; preserve ownership of the blocking worker until it exits.

### C4 — Crust player registry retains dead weak entries (low/medium memory)

**Path:** Crust adapter `AdapterInner::players` and `create_player` around lines 189–194 and 363–382. `create_player` appends a `Weak` and only adapter shutdown clears the vector.

**Reproduction:** Creating, shutting down, and dropping 1,000 players leaves `entries=1000`, `live=0`, vector capacity 1024. On this build a `Weak<RealMantlePlayer>` is 8 bytes, so this is about 8 KiB per 1,000 churned players (plus vector growth), not a retained player/task. It is not a six-hour single-player leak, but reconnect/guild churn makes it monotonic. Prune dead entries during insertion or replace the vector with a bounded registry keyed by live handles.

### C5 — dropped direct adapter loads leave a watcher until cancellation (low API hygiene)

**Path:** Crust adapter `RealMantleAdapter::load` around lines 291–324. The cancellation watcher is aborted only after the `spawn_blocking` result is awaited. If a caller drops the returned future, Tokio detaches both the watcher and blocking worker; the watcher remains until the caller’s token or adapter shutdown is cancelled.

**Reproduction:** With the sole blocking worker held, poll `load` once, drop it, release the worker, and fence the worker queue. One async task (the watcher) remains. Cancelling the token removes it. The deployed Crust REST handler owns `RequestCancellation` and cancels it on drop, so this is mainly a direct-adapter/API risk, but the adapter should still use an owned guard or cancellation-aware join pattern.

## Reviewed areas with no confirmed defect

- Oto’s 20 ms pacer uses bounded capacity-one deadline delivery and intentionally counts skipped deadlines rather than bursting catch-up packets. Existing delayed-executor tests pass; command-first selection and `HashMap` minimum scans remain scalability opportunities to benchmark, not proven six-hour audio faults.
- Oto frame-source polling has a Linux thread-CPU watchdog and bounded frame channel. The watchdog cannot detect a callback that sleeps while descheduled; this is documented as a caller contract, not a newly reproduced fault.
- Mantle HTTP range input validates status, content range, validators, and declared lengths, checks cancellation before/after body reads, and bounds staging at the configured limit. No corruption reproduction was found in the offline range tests.
- Existing EOF identity handling in Crust was previously fixed and its deterministic/live tests remain passing.

## Verification

Reproduction commands (all with one cargo job and the pinned Rust toolchain) were:

```text
cargo test -p crust-mantle-adapter --lib audit_ -- --nocapture --test-threads=1
cargo test -p oto --lib audit_ -- --nocapture --test-threads=1
cargo test -p mantle-media --lib audit_ -- --nocapture --test-threads=1
```

Results: Crust 3/3, Oto 2/2, Mantle 2/2 characterization tests passed. The complete pinned library suites also passed: Crust adapter 26 passed/2 ignored, Oto 97 passed/6 ignored, and Mantle media 23 passed/1 ignored. The Mantle EOF test intentionally catches the current panic to make the reachable defect deterministic. No source or deployment checkout was modified by the audit.

## Recommended order

1. Fix M1 and M2 in Mantle, with codec/resampler continuity regressions.
2. Fix C1 before relying on reconnect/retry as an audio-reliability mechanism.
3. Add cancellation generations for C3, then prune C4 and make C5’s task ownership explicit.
4. Rebuild Raydio and repeat the five-minute receiver test before another six-hour run; collect filter-change, reconnect, and control-latency counters separately.
