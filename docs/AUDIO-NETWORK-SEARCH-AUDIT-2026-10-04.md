# Deeper audio, networking and search audit — 2026-10-04

Status: **audit completed; findings are not fixed or deployed by this audit.**

Follow-up: all seven findings now have implementation fixes and regression
evidence in [the repair report](AUDIO-NETWORK-SEARCH-FIXES-2026-10-04.md).
Those changes are now retained on a candidate branch after a precautionary
rollout reversal; see [the repeated comparison](AUDIO-AUDIT-REGRESSION-RETEST-2026-10-04.md).
The audit below preserves the original observations and their limits.

Six new faults were reproduced, plus a notification race whose full playback
impact still needs an integration reproduction. None is established as the cause
of a historical receiver loss/concealment incident. The useful next work is to
fix these specific triggers and validate them separately, rather than treating
all receiver concealment as a sender defect.

## Scope and provenance

Audited Raydio `409046f6c9ce21e63714aea7496044f6d4f09972`, with production
dependencies Crust `c69d2b77fe7e42071ed76012fedcccbe85f2a04f`, Mantle
`c241f9104810cca1a868fc7238ba94cd8567a92e`, and Oto
`62d2fc87e5dc239695a8b86a7372a4edc1caa933`.

Oto's local HEAD and its existing gateway/pacer/ledger edits differ from this
pin. They were preserved. The transport review used the pinned Cargo checkout;
findings therefore refer to the dependency the deployed bot actually uses.
The earlier B1–B7 fixes remain in place and are not counted again.

Reviewed paths:

- Raydio's interaction actor, queue/end recovery, successor preparation, voice
  lifecycle, search/autocomplete, response deadlines and URL normalization.
- Crust's player executor, terminal-event delivery, voice monitoring, source
  bridge, bounded frame admission and pause/stop behavior.
- Mantle's Opus bypass/processing transitions, PCM assembly, selected format
  policy, progressive/file buffering, HTTP recovery, proxy/cancellation behavior
  and YouTube search/mix parsers.
- Pinned Oto's deadline pacing, UDP submission/retry, transport encryption,
  event subscriber and durable lifecycle state.
- Receiver measurements for quiet boundaries, clipping/nonfinite samples,
  loss corrections, counter identity, incident persistence and coverage.

All reproductions were local, bounded and offline. Builds used one Cargo job;
tests ran serially. No live commands were sent to a Discord server and no service
was restarted. Oracle inspection found Raydio active, PID 38709, zero restarts;
Testbot inactive. This is a service-status check, not proof of current audio.

## Findings

| ID | Priority | Reproduced behavior | Component |
| --- | --- | --- | --- |
| D1 | High | An unrelated slow Discord response holds natural queue advancement | Raydio |
| D2 | High | Subscriber lag silently ends the voice monitor; a subsequent close is missed | Crust/Oto adapter |
| D3 | Medium | Valid mono or non-20 ms Opus fails instead of using a compatible processing path | Mantle |
| D4 | Medium | Entering processing from bypass loses decoder history and produces an amplitude transient | Mantle |
| D5 | Medium | One malformed search item discards otherwise usable neighboring results | Mantle |
| D6 | Medium | URL normalization removes the seed required by some supported YouTube Mix routes | Raydio |
| R1 | Needs integration validation | Deferred notification registration can miss a retained source failure | Crust/Oto adapter |

### D1 — Discord response I/O still blocks natural queue advancement

References: Raydio `src/session.rs:112`, `:178`, `:590`, `:1450`;
`src/discord.rs:194`.

The guild actor awaits `interaction()` and `commit()` inline. `/help`, `/queue`,
`/ping`, queue pagination, `/nowplaying` and several other response paths await
Discord HTTP in that actor. `Request::respond` has an eight-second deadline.
The periodic panel-edit path has been decoupled, but these other responses have
not. The actor cannot process `TrackEndEvent` while one is pending.

**Reproduction:** start a synthetic looping player, accept `/help`, hold its
HTTP response, then deliver the correlated natural-end event. After a deliberate
350 ms hold, the backend still has the old generation. Release the HTTP response:
the generation advances. Total observed handoff wait was **366.770 ms**. The
server's released response uses a deliberately minimal body: successful message
decoding is not required to unblock the actor. Existing slow-progress-edit
regression is the complementary control and still passes.

**Impact:** an otherwise healthy sender can finish its source while the bot
delays starting its successor. Several queued interactions can compound the
delay. This is a boundary/control-plane fault; it does not demonstrate packet
loss during the preceding song. The per-response eight-second bound is from
the code, not an eight-second live-request measurement.

**Fix direction:** move response-only work into the existing bounded, owned
response task set. For player-panel responses, send completions back with a
session/generation token; accept only current completions and retire obsolete
messages. Preserve command mutation order and response ownership without
holding the actor on Discord I/O. Apply the same rule to admission ACK waits
and response work in commit/control paths.

**Acceptance:** hold an ACK/response through EOF, including `/help`, queue
pagination, panel creation and an enqueue response. The prepared successor must
start without waiting for it. Stale completions cannot replace a newer panel;
overload remains bounded and shutdown owns every response task.

### D2 — Event lag disables voice monitoring without recovery or a terminal event

References: Crust `crates/crust-oto-adapter/src/lib.rs:778`;
`crates/crust-server/src/player.rs:502`, `:579`.
Pinned Oto `crates/oto/src/connection.rs:458`.

Oto explicitly reports broadcast subscriber lag. Its adapter translates that
into `VoiceErrorKind::Overloaded`; the server monitor matches every `Err(_)`
with `return`. The exit is silent. Oto's durable state remains queryable, but
the monitor never reconciles it. Fresh voice information can start another
monitor; an ordinary continuing session does not automatically do so.

**Reproduction:** wrap the fake voice connection to return exactly the adapter's
typed lag error on the first event read. Afterwards publish a real Closed event
with code 4014. The no-lag control delivers `WebSocketClosedEvent`; the lag case
does not deliver it in 350 ms and has made exactly **one** `next_event` call.
This deliberately injects the adapter error, rather than proving an event-ring
overflow on Oracle. Pinned Oto has a separate existing regression for broadcast
lag and durable final state; it was inspected, not rerun in this audit.

**Impact:** voice close/reconnect-ready events can remain unobserved. Raydio may
retain stale playback state or fail to rearm deferred audio after recovery. This
is a credible connected-but-silent failure path, not evidence that production
has actually overflowed its event ring.

**Fix direction:** distinguish cancellation/normal closure from recoverable
subscriber lag and terminal errors. After lag, reconcile durable connection and
audio snapshots, then resume monitoring under a bounded policy. Merely
continuing event reads is insufficient when the close itself was skipped.
Log/count lag and terminal monitor exits without credentials; propagate a
terminal event or cleanup when recovery cannot be established.

**Acceptance:** overflow a real small Oto event ring while advancing readiness,
source replacement and final close. The server must recover current state or
deliver one terminal close. Cover a dropped final event, old generations,
repeated lag, cancellation and shutdown without a retry busy loop.

### D3 — Selected Opus formats can be valid but unusable by the playback pipeline

References: Mantle `crates/mantle-media/src/youtube.rs:4432`;
`crates/mantle-media/src/youtube_playback.rs:733`, `:871`, `:940`;
`crates/mantle-media/src/lib.rs:848`.

The format selector accepts one-channel WebM Opus, but playback initialization
requires two channels. The passthrough router can classify a non-20 ms packet
for transcoding; its caller returns `AudioPipeline` when it is not delivered.
The processing path sizes the decoder for 960 samples and requires exactly
1,920 interleaved samples. It therefore cannot assemble 10 ms packets or split
40 ms packets. `MediaSession::read_pcm` intentionally rejects Opus, so simply
routing these objects into the existing generic PCM transcoder is not a fix.

**Reproduction:** generate four one-second, 48 kHz WebM/libopus fixtures using
one FFmpeg thread. FFmpeg independently decodes all four without errors.

| Input | Bypass | Identity processing |
| --- | --- | --- |
| Mono, 20 ms | Initialization: `IncompatibleFormat` | Same initialization failure |
| Stereo, 10 ms | First frame: `AudioPipeline` | First frame: `IncompatibleFormat` |
| Stereo, 20 ms | Successful playback to EOF | Successful playback to EOF |
| Stereo, 40 ms | First frame: `AudioPipeline` | First frame: `AudioPipeline` |

**Impact:** selecting a supported-looking Opus representation can fail a song
or playlist item. These are valid media variants, not malformed packets. No
production YouTube object with these variants was captured, so prevalence and
historical relevance are unknown. Normal tested stereo/20 ms sources pass.

**Fix direction:** retain exact bypass for compatible packets; add a bounded
Opus decode/channel-map/PCM-assembly path for valid alternatives. Size decoder
storage for the documented bounded Opus packet duration, normalize mono to
stereo, and emit only 960-sample stereo output frames. Until that exists, format
selection must not advertise a representation the pipeline cannot play.

**Acceptance:** cover 10/20/40 ms packets and mono, including packet-duration
changes, filters, EOF partial blocks, cancellation, seek and exact source-clock
accounting. Compatible bypass must retain bytes and steady-state allocation
bounds. Oto's one-20-ms-frame contract must stay intact.

### D4 — Bypass-to-processing resets Opus history without pre-roll

References: Mantle `crates/mantle-media/src/youtube_playback.rs:898`, `:941`.

Bypassed packets mark the decoder stale. When processing begins, the decoder
and encoder are reset and the next packet is decoded without earlier compressed
audio. That prevents old processing state from leaking across the switch, but
Opus prediction/overlap history has not been warmed from the packets that were
actually heard. The previous transition regression checked packet order and
clocks; it did not compare decoded samples at the switch.

**Reproduction:** bypass 50 packets of the existing stereo tone fixture, enable
an identity filter, and compare the pipeline's decoded input against an
independently continuous decoder of the same original packets. No gain change
is requested. These measurements are **before re-encoding**, not a browser
receiver recording.

| 20 ms block after switch | Continuous RMS | Cold pipeline RMS | RMS difference |
| --- | ---: | ---: | ---: |
| 1 | 0.10687990 | 0.03166791 | 0.08020892 |
| 2 | 0.10699043 | 0.06242594 | 0.04711920 |
| 3 | 0.10367289 | 0.08192474 | 0.02408129 |
| 4 | 0.10472282 | 0.09526229 | 0.01062167 |
| 5 | 0.10576458 | 0.10121735 | 0.00500286 |

The first block loses **70.37% RMS amplitude (−10.57 dB)**. The deviation
declines across subsequent blocks. This demonstrates a transition transient,
not clipping, packet concealment, missing media time or a measured listening
test. It applies when crossing from passthrough into processing, for example
from normal volume into attenuation. Continuously processed volume-70 playback
does not take this bypass transition on every frame.

**Fix direction:** retain a bounded compressed pre-roll sufficient to warm the
decoder when entering processing, or maintain decoder continuity if a measured
CPU/resource comparison supports it. Suppress pre-roll output and keep packet
order, source position and output time exact. Validate outgoing decoder
continuity at both directions of the switch; do not hide the transient by
dropping samples or inserting silence.

**Acceptance:** compare continuous PCM and decoded outgoing audio at repeated
bypass/processing switches using tone, transients and music. Include volume
100→70→100, seek, replacement and EOF; bound memory/allocation/CPU cost and
perform a receiver check before claiming an audible improvement.

### D5 — One bad result aborts a whole search or mix

References: Mantle `crates/mantle-media/src/youtube.rs:4468`, `:4516`, `:4558`,
`:4600`, `:4651`.

Search and mix loops propagate each track parser's error with `?`. A renderer
with an invalid duration/required field causes already parsed good results and
later good results to be discarded. Explicit unavailable/no-duration renderers
are already skipped. Music search uses the same all-or-nothing error pattern.
Raydio's Music→YouTube fallback helps only when the other response is usable.

**Reproduction:** two ordinary video renderers produce two tracks. Put a third
renderer with an unsupported duration string between them: the whole search
returns `InvalidResponse`. Mark that same bad entry unavailable: it is skipped
and both good tracks survive. The response is synthetic; no current YouTube
response with that unsupported duration was captured.

**Impact:** isolated renderer/schema irregularities can empty autocomplete or
fail `/play` despite good candidates in the response. Mix loading shares the
parser and can lose otherwise usable entries. This does not establish the cause
of the earlier `akcent`/`chop suey` production errors.

**Fix direction:** separate response corruption and global resource-limit
failures from item-local unusable metadata. Skip only the latter, preserving
ordering and reporting bounded omission counts. Keep invalid JSON, dangerous
targets, oversized strings/collections and source authentication failures
explicit; do not turn every error into an empty successful search.

**Acceptance:** good/bad/good fixtures for ordinary and Music search plus mixes;
all-bad responses; malformed JSON and resource-limit errors; correct fallback
and partial-result reporting. Good entries must retain their exact identities.

### D6 — Some YouTube Mix URLs lose their required seed

References: Raydio `src/urls.rs:20`; Mantle
`crates/mantle-media/src/youtube.rs:704`, `:746`, `:825`.

Raydio canonicalizes every URL containing a valid `list` into `/playlist?list=…`,
discarding `v`. Mantle supports a watch URL with an explicit video seed for
an `RD…` mix. Its playlist-only route can infer the seed only when the suffix
after `RD` is exactly a valid eleven-character video ID.

**Reproduction:** a watch URL with `v=dQw4w9WgXcQ` and
`list=RDMMdQw4w9WgXcQ` routes directly to `Mix`. After Raydio normalization,
the same request routes to `NoTrack`. A synthetic `RDEMfixtureMix` has the same
route-level result. Ordinary `RDdQw4w9WgXcQ` is a positive control and still
works. This establishes information loss without claiming the synthetic list
exists or fetching a personalized mix from YouTube.

**Impact:** supported seeded mix requests can become guaranteed no-match
requests before any source networking occurs. A cookie, proxy or retry cannot
repair the lost seed.

**Fix direction:** preserve a validated explicit seed when canonicalizing a
mix, while retaining full-playlist behavior. Define equivalent short/music
watch-link handling and keep untrusted URL components excluded.

**Acceptance:** ordinary RD, RDMM and explicit-seed personalized mix routes;
regular PL playlists, short links, invalid IDs and missing seeds. Check the
final identifier actually delivered to Mantle, not only the input classifier.

### R1 — Source-failure notification registration has a race

References: Crust `crates/crust-oto-adapter/src/lib.rs:676`, `:682`, `:939`.

`next_event` creates an async block which will call `shared.changed.notified()`
when first polled. It checks `take_failure()` before polling that block.
`BridgeShared::fail` stores durable failure, then calls `notify_waiters()`.
A producer on another runtime thread can publish between the check and the
future's actual registration. `notify_waiters()` does not retain a permit for a
future constructed afterward.

**Component reproduction:** execute exactly that interleaving. The failure is
retained but the deferred wait polls Pending. A later notification wakes it.
The positive control constructs `Notified` before the check and receives the
same early notification immediately. No sleeps or thread-load assumption is
required to reproduce this primitive interleaving.

**Limit:** this is not a full connected-player failure reproduction. Oto's own
source-ended/audio-state events can provide an independent wake, and Mantle has
its own terminal-event path. Their masking behavior needs to be tested,
particularly with retained pause and no subsequent gateway event. Do not claim
this race caused a bot to remain silent indefinitely.

**Fix direction:** construct/register the notification before inspecting the
durable predicate and retain register/recheck semantics. Test the actual adapter
event call with the producer publication forced into this window, including
paused audio and cancellation, before treating the integration issue as closed.

## Repair status

The findings below describe the audited pre-fix revisions. All seven now have
implementation fixes and regression evidence; see
[the repair report](AUDIO-NETWORK-SEARCH-FIXES-2026-10-04.md) for current status,
processing cost, dependency pins and live qualification limits.

## What this says about gaps, loss, discards and concealment

D1 can add real delay between songs. D2 can prevent observed voice recovery.
D3 can fail source playback. D4 changes audio samples even though frame clocks
and network delivery remain intact. These are different failure classes and
need different regressions.

The audit did **not** reproduce sender-created network packet loss, a new
mid-track clipping fault, or receiver-discard/concealment on a live connection.
UDP submission success does not prove delivery through Discord to the listener.
The reviewed sender uses bounded retry of the same encrypted datagram rather
than introducing a new nonce/sequence for each retry. Deadline rebasing avoids
catch-up bursts; this is not itself evidence of a missing RTP packet.

Passing diagnostic controls retain signed loss corrections, distinguish PCM
quiet from empty input/nonfinite/near-full-scale samples, preserve incident
history and reject receiver identity/counter/coverage failures. Boundary quiet
remains in the report and is only a **candidate** source tail when a natural
finish/start pair and duration agree. Overlapping transport/receiver anomalies
and extended boundary quiet require review. Existing 120 ms browser-buffer
measurements must continue to be identified as such; they do not qualify an
ordinary Discord client. No new network-quality improvement is claimed here.

One unrelated-guild blocking suspicion was rejected: the actual executor has
per-guild in-flight scheduling, and its held-load isolation regression passes.
The previous progress-edit decoupling and source-drain/terminal delivery
controls also pass. These are useful controls, not additional faults.

## Verification and retained evidence

Evidence: [audio-network-search-audit-20261004](audio-network-search-audit-20261004/).

- Seven characterization tests pass by asserting the observed faulty behavior
  or race. **Passing these probes means reproduced, not fixed.**
- Restored Raydio suite: 69 passed.
- Restored Mantle audio/media suites: 284 passed, eight existing exclusions.
- Crust voice suite: nine existing tests plus D2 characterization pass.
- Restored Oto adapter suite: 16 passed, one existing manual exclusion.
- Restored cross-guild isolation control: one passed.
- Diagnostic Python suite: 57 passed. Seven Bun diagnostic programs passed.
- Four generated media fixtures independently decode with FFmpeg, with format
  probes, generation commands and SHA-256 hashes retained.

Existing live/environment/manual exclusions are not hidden successes.
No new live receiver/endurance test ran. Audited source files were restored
**byte-for-byte** after characterization; originals/restoration hashes are in
`source-restoration.json`. Replay patches, command logs and the verification
summary remain reviewable. No dependency pin, runtime setting, codec, source
buffer, service deployment or production code was changed by this audit.

Recommended fix order: D1 and D2 first; D4 with decoded-output evidence; D3's
bounded compatibility path; D5/D6 parser and URL resilience; then close R1's
integration evidence gap. Measure each audio change against a current baseline,
then run a short independent receiver check before another endurance attempt.

## Local shutdown dependency

At inspection this computer was running both
`raydio-youtube-companion.service` and `raydio-youtube-tunnel.service`.
Oracle Raydio currently depends on those local source services. The explicitly
requested local shutdown will stop them. Cached/prepared playback may continue
on Oracle, but new YouTube source operations can fail while they are offline.
This is an operational dependency, not a fault demonstrated by this audit.

The shutdown is to be scheduled once, only after the audit is saved and checked;
the final response reports its actual scheduled local time.
