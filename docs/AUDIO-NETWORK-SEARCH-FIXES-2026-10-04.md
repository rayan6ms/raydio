# Audio, voice-event and search audit repairs — October 4, 2026

**Rollout status: withdrawn pending qualification.** The previous runtime is
restored on Oracle and `main`. The implementation below is preserved on
`candidate/audio-audit-20261004`; the earlier acceptance statement is superseded
by [the repeated comparison and rollback report](AUDIO-AUDIT-REGRESSION-RETEST-2026-10-04.md).
The seven audit faults remain pending in the restored production build.

All seven findings from [the original audit](AUDIO-NETWORK-SEARCH-AUDIT-2026-10-04.md)
have implementation fixes and regression evidence. These are corrections to
reproduced faults; they do not establish that historical packet loss or receiver
concealment was caused by those faults.

## Corrections and acceptance evidence

| Finding | Correction | Regression result |
| --- | --- | --- |
| D1: Discord responses block the guild actor | Owned response tasks and an ordered ACK queue, each bounded to 32. The actor continues handling media events while Discord responds. Panel updates serialize outside the actor, include lock waits in their deadline, and reject obsolete epochs/intents. Shutdown drains delivered responses for bounded cleanup. | Held help, queue, nowplaying and enqueue replies do not block natural EOF/repeat. A held ACK also permits EOF; subsequent volume commands retain admission order. Existing progress/control ordering and late-panel deletion tests pass. |
| D2: Subscriber lag loses voice monitoring | The Oto adapter reconciles durable readiness/recovery/retained close metadata after lag. Generic backend overload uses a cancellable snapshot timeout and 25 ms backoff, limited to eight retries; unrecoverable streams emit a close. | Actual Oto ring overflow with capacity two across four generations recovers readiness and a retained close. A server monitor still observes a subsequent 4014 close after injected overload. |
| D3: Valid Opus geometries fail | Mono/stereo 48 kHz Opus supports a validated 120 ms decoding ceiling. Variable-duration PCM is split/assembled into canonical 20 ms stereo frames; mono samples duplicate into both channels. Only the final partial frame pads. | Mono/20 ms and stereo/10, 20 and 40 ms fixtures retain every decoded input sample and produce the expected full frame count. Compatible packets retain exact original bytes/timestamps. EOF and existing seek/filter regressions pass. |
| D4: Processing begins with a cold decoder | Every original Opus packet advances native decoder history, including passthrough packets. Processing starts from the continuously decoded samples rather than resetting prediction/overlap history. | Five post-switch PCM blocks match the continuous reference exactly, with RMS difference zero. The reproduced first-block 70.37% amplitude loss is removed. This is pre-encoder evidence, not a claim about all receiver transients. |
| D5: One bad search item rejects good neighbors | Item-local ID/title/duration problems skip that item in search, Music and mixes; malformed optional author uses the existing fallback. Invalid JSON, oversized metadata and collection bounds remain errors. Credential-free debug counts expose retained/omitted items. | Good/bad/good, all-bad, invalid JSON, oversized metadata, collection-limit and selected-mix-index tests pass. Optional author fallback preserves the oversized-string failure. |
| D6: Mix URL normalization loses its seed | Valid explicit eleven-character seeds survive normalization of watch/music/short/shorts/live/embed RD mix links. Ordinary playlists retain their canonical form. | Tests check the actual Mantle `Mix` route for RD, RDMM and an explicit-seed synthetic mix; malformed seeds cannot enter that route. The synthetic fixture is a route test, not a claim that the playlist exists. |
| R1: Source notification registration races | Construct the Notify waiter before checking the durable failure predicate. | The exact primitive interleaving now wakes immediately. An actual attached paused adapter delivers `SourceFailed` without subsequent gateway activity, sends no frames and respects cancellation. |

The integrated dependency revisions are Mantle
`87c2eaf08bace355f7696cec4676eea8885fab9a` and Crust
`e460724bdf72256e3be4f19f80a67832a4cfa85b`. Oto remains pinned to
`62d2fc87e5dc239695a8b86a7372a4edc1caa933`; its local experiments are not included.

## Allocation and processing cost

The warmed complete playback path retains exactly the existing demux envelope:
128 allocations / 41,216 bytes for 64 measured frames after warmup (two
allocations / 644 bytes per frame). Warming the decoder introduces none.
This is the existing demux allocation bound, not a zero-allocation demux claim.

The bounded explicit **debug-profile** probe measured these five-trial medians
on the same fixture, including opening eight sessions per trial:

| Path | Before | After | Difference |
| --- | ---: | ---: | ---: |
| Compatible passthrough | 5.075 µs/frame | 63.219 µs/frame | +58.144 µs/frame |
| Identity processing | 352.181 µs/frame | 362.700 µs/frame | +10.519 µs/frame |

The passthrough difference is about 0.291% of one core at 50 frames/s in this
probe. It buys correct processing transitions while preserving exact bypass
packets. It is not a release-profile CPU promise or a memory reduction claim.
The added manual benchmark exclusion was explicitly executed; existing
environment/live/manual exclusions remain documented rather than counted as passes.

## Verification

Evidence and command logs are in [deep-audit-fixes-20261004](deep-audit-fixes-20261004/).

- Mantle full audio/media suite: 288 passed, nine exclusions, followed by the
  additional optional-author and whole-playback allocation regressions. Those
  focused suites pass (three parser and four allocation tests).
- Crust full workspace/all-target suite: 183 passed, four existing manual exclusions.
- Raydio all-target suite with the new pinned dependencies: 74 passed.
- Relevant all-target warnings-denied Clippy checks pass for all three repositories.
- Mantle audit, deny and vet pass; Crust deny passes. Raydio formatting passes.
  Ordinary Raydio audit reports no vulnerabilities. Its optional strict
  warnings-denied scan flags the pre-existing `proc-macro-error2` 2.0.1
  unmaintained warning (RUSTSEC-2026-0173); the crate is absent from the current
  Linux target dependency tree. No exemption or unrelated dependency upgrade
  is introduced. Native release/package checks are recorded with deployment evidence.
- Diagnostic controls: 58 Python tests and eight Bun programs pass, including
  a regression for forwarding the selected bot identity to the recorder.

## Live qualification protocol

Use Raydio only on Oracle, Testbot inactive, and test → General/#chat only.
Submit the same `4moWSMi1L_4` URL through Discord and enable Loop. Keep volume
70, ordinary browser buffering (no target override), source prefix, encoder,
worker, transport, route and service settings unchanged. Collect five minutes
of receiver counters, PCM aggregates, speaking/track phase, incident windows,
Oracle sender diagnostics and host resources. Persist independently of agent
turns. Do not touch controls during either measured interval.

The baseline completed 300.025 seconds with complete receiver/PCM/event/phase
coverage. It received 15,000 packets, net loss zero (+14/-14 corrections), four
discards and 509.875 ms concealment. Interior sender checkpoints record one
gap over 40 ms, two skipped deadlines, and zero source unavailable/overrun/send
failures. Median process PSS was 19.516 MiB. No off-boundary PCM quiet interval
reached 100 ms; the ~2.258 s loop quiet remains a source-boundary candidate.

The baseline overlaps local compilation and its independent local host sampler
starts about 70 seconds after receiver recording. The receiver report itself
was retained and later persisted completely, without missing archived events.
These limitations prevent a strong causal before/after network-quality claim.
The final candidate check must start persistence and host sampling before its
recording and run without builds, source probes or control changes.

The summary now accepts an explicit host-coverage slack, preserving the old
90 s minute-sampling default. Both 1 Hz observations use 3 s instead, so the
baseline's missing ~70 s receiver-host head is explicitly flagged incomplete.
Regression coverage checks complete 1 Hz samples, a missing head and an internal
gap. Receiver checkpoint cadence retains its separate minute-sampling policy.
Actor shutdown also aborts pending HTTP tasks before draining completed results;
a held-response regression finishes shutdown within one second, respecting the
existing five-second actor shutdown budget rather than waiting the HTTP deadline.

The source quiet reference is the independently decoded exact video saved on
October 2 (4,167,934 bytes, SHA-256
`a31c27999d21b6402368699057c277597e906ca88e4ab68ab3cf6322df685097`,
head 265.188 ms / tail 1931.792 ms). It is reused, not represented as a fresh
October 4 fetch. Boundaries require a logged natural finish/start pair, duration
agreement and no overlapping anomaly; extended or anomalous quiet remains
flagged for review. Neither a successful UDP send nor one short receiver
observation guarantees future delivery or proves a downstream loss fix.

## Release and final live check

The release is deployed on the existing Oracle instance at revision
`d2d3fad01346c526546c7e54ed122a58f944ad70`. The verified binary SHA-256 is
`58c5a023653eb6dfe926846edd5d92b1102f7f6173a3bde0aeb85550759f64cc`.
The binary is 18,661,496 bytes and the deployment archive 7,587,914 bytes.
The package/backend checks and update command passed. Raydio is the sole bot
process, PID 40011, with zero service restarts; Testbot is inactive. Subsequent
documentation and browser-helper changes do not change this runtime binary.

Controlled Discord UI checks submitted `/play chop suey` to Raydio and observed
ten autocomplete suggestions, including System Of A Down. The plain-term
request produced a fresh **Chop Suey!** panel and advancing playback. Leaving
removed that panel. A new request for the exact comparison URL produced a
fresh **Stay With Me** panel at volume 70; Loop was explicitly enabled. These
checks used test only. THE CLUB received no test commands.

The candidate recorded **300.025 seconds**, from 13:42:19.213 through
13:47:19.290 UTC. Receiver, PCM, speaking, track-phase and event coverage are
complete. Both 1 Hz host samplers cover the complete interval under the declared
3 s slack. Seven checkpoint saves succeeded, with no persistence errors or
dropped incident windows. Browser buffering stayed unchanged. No builds,
source probes, packet captures or player controls occurred during this interval.

| Five-minute measurement | Baseline | Fixed release |
| --- | ---: | ---: |
| Received packets | 15,000 | 14,982 |
| Net RTP loss | 0 | 0 |
| Positive / negative loss-counter deltas | +14 / −14 | 0 / 0 |
| Discarded packets | 4 | 5 |
| Concealed audio | 509.875 ms | 1,343.313 ms |
| Silent concealed audio | 53.458 ms | 114.750 ms |
| Sender gaps >40 ms, interior checkpoint interval | 1 | 8 |
| Sender gaps >100 ms / >1 s, same interval | 0 / 0 | 0 / 0 |
| Skipped sender deadlines, same interval | 2 | 16 |
| Source unavailable / overrun / send failures | 0 / 0 / 0 | 0 / 0 / 0 |
| Median bot PSS | 19.516 MiB | 20.374 MiB |
| Average bot CPU, one core | 3.751% | 3.708% |
| Oracle host CPU steal | 0.224% | 0.415% |

There were no voice disconnects or terminal sender errors. PCM contained no
clipping, non-finite samples or empty frames. The longest off-boundary quiet
interval was **83.021 ms**, compared with 31.417 ms in the baseline. No
off-boundary quiet reached 100 ms. Both runs contained a 2,258.063 ms quiet
interval at a natural loop boundary, compatible with the retained source
head/tail reference. It remains a source-tail candidate, not a proven fresh
waveform match. The candidate's logged finish-to-start handoff was 1.448 ms.

**This live check is not a measured improvement in overall concealment or
sender timing.** Concealment increased by 833.438 ms and median PSS by about
0.858 MiB. The small CPU difference is not a demonstrated optimization. The
fixes remove their reproduced fault conditions, but the short observations have
different host contention and the baseline has incomplete local host coverage.
They do not isolate a release regression or establish its absence.

[The retained timing analysis](deep-audit-fixes-20261004/live-timing-analysis.json)
correlates two observable last-gap timestamps, 13:43:58.491 and 13:45:05.391 UTC,
with Oracle steal intervals of 15.976% and 32.212%. The largest logged sender
gap was 59.932 ms. This supports host scheduling pressure as a contributor;
only the last gap in each checkpoint is retained, so it does not identify the
cause of every gap. Receiver concealment also occurred before any sender gaps
and after their counts stopped increasing. No browser main-thread long task
was observed. Zero net RTP loss does not mean zero source-time omissions or
perfect receiver playout.

The seven repairs are accepted on their targeted regression evidence and the
successful functional live check. Overall audio-quality improvement remains
unproven; a matched repeated baseline/candidate comparison is required before
making that claim. No further transport or worker adjustment is justified by
this single window. The measured recording and test playback have ended; its
named collectors are stopped and production Raydio remains active.

The browser setup helper now clears Slate's actual draft through a paced public
cut event, selects the chosen bot's `/play` option, and fills the parsed request
field. It never submits an unparsed full-command paste. Missing or ambiguous
options fail within a bounded wait, and concurrent preparation or premature
submission is rejected. The amended regression and all eight Bun programs
pass. A final controlled UI preparation also succeeded without submitting an
extra playback command.
