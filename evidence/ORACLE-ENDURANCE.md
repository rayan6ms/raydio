# Oracle continuous receiver qualification

The current setup is **not yet qualified for six hours**. Short clean receiver
windows in `ORACLE-RELIABILITY.md` do not establish continuous reliability.

## First attempt: terminal failure

On 2026-09-06, Testbot ran release v0.2.1 on the existing Always Free Micro VM,
with two Tokio workers and volume 70, looping `dQw4w9WgXcQ` in test / General.
The controlled browser was a muted listener. Observation started at
18:04:39.529 UTC, after the track had already been playing for about three
minutes. The bot stopped voice at 18:05:00.020 UTC:

```text
audio sender stopped after a terminal failure
failure=Some(FrameSourceContract) source_overruns=1 send_failures=0 skipped_deadlines=3
```

The browser peer remained connected, Discord displayed a voice-closed message,
and the bot process stayed alive. This was a terminal sender failure. There
were no new SSH sessions, builds, packet traces, or scheduler probes during
the measured interval. See `endurance-terminal-source-failure.json`.

## Candidate repair and evidence

Crust 173fe86 replaces its Tokio mpsc `try_recv` call with `poll_recv`. Tokio
1.53.1 `try_recv` can park when a producer is publishing; `poll_recv` yields and
registers/rechecks the latest waker. The bridge keeps its one-frame capacity
and removes a redundant AtomicWaker. Its 13 tests cover lifecycle/error ordering,
cancellation, cooperative budget exhaustion, and 4,096 concurrent ordered frames.
The cooperative-yield regression fails on the former implementation. This does
not reproduce the internal Tokio publication parking race deterministically.

Oto 3b770a9 retains the last overrun's elapsed and Linux thread CPU durations
in its durable snapshot and Crust's terminal warning. It adds no timing calls
or per-frame logging and retains the 2 ms CPU kill gate. All 79 Oto tests and
both crates' Clippy checks pass. The DAVE test retained 500 frames/packets and
zero allocations in 10 seconds. The bridge benchmark retained the same
allocation count and thread count; memory and CPU variations do not establish
an improvement. Raw results are in `bridge-{before,after}-poll-recv.json` and
`oto-overrun-telemetry-dave.json`.

The possible parking path is a proven contract problem. Its causal role in
the Oracle CPU-time rejection remains unproved until live diagnosis.

## Measurement rules

- Use the existing single free VM and the real Discord receiver. No second
  instance, paid plan, audio-bitrate reduction, or overlapping active bot stream.
- Start the exact candidate binary and a low-priority minute resource sampler
  before measurement. Avoid new SSH sessions, deployments, builds, packet
  traces, or kernel probes during measured playback. Normal host maintenance
  stays enabled; the sampler's own cost remains part of the test conditions.
- `benchmarks/browser_endurance.js` gathers one-second WebRTC counters and
  audio-thread PCM aggregates without recording or duplicating audible audio.
  Prime the analysis graph before measurement: the earlier meter's initial
  20 ms quiet buffer was reproduced and removed from measured startup.
- Retain positive loss deltas even if late packets later cancel net loss.
  Record concealment, silent samples, near-full-scale/nonfinite samples,
  speaking transitions, peer changes, and missing measurement intervals.
- Retain track endings/restarts and their quiet intervals for review. A track
  boundary is not a blanket exemption from the continuity requirement.
- Capture browser checkpoints locally. A replaced or lost receiver invalidates
  continuous receiver coverage; do not combine shorter windows into a six-hour
  pass. Successful measurement completion is not automatically a quality pass.

## Second attempt and targeted diagnosis

The `poll_recv` candidate d307ca7 passed all 49 Raydio tests and native CI
34051708409 on x86-64 and ARM64, but failed live. Its local-built Oracle binary
SHA256 was `82df0a853837e725b549c2b722c056efc7529b909fe95ef32314097f4500526c`.
At 18:36:01.858875 UTC it terminated with 2,065 us elapsed, 2,036 us thread CPU,
zero send failures and 16 skipped deadlines. The receiver had 235 seconds of
coverage, zero net/positive packet loss, and no clipping, but a 340.5 ms
concealment burst and about 1.1 seconds of boundary silence. That is a failure,
not an endurance pass. `endurance-poll-recv-terminal-failure.json` retains it.

A separate two-minute single-thread C clock/copy probe on the stopped-testbot
VM performed 763,392 tiny copies with no 2 ms overrun, 573,260 ns maximum wall
duration, and about 1.06 seconds CPU time. It did not reproduce the failure;
it is not playback evidence (`source-clock-copy-probe*`).

A temporary three-stage wall-timing patch then reproduced the terminal stop at
18:56:53.412951 UTC: 2,205 us wall and 2,210 us CPU. Receive took 2,485 ns, copy
1,062 ns, and `Notify::notify_one` took **2,191,168 ns**. It isolates this
occurrence to producer notification. That call includes both the internal
waiter mutex and the Tokio task wake; the trace does not distinguish those two.
See `source-stage-terminal-oracle.txt`, `source-stage-diagnostic.patch`, and
`endurance-stage-diagnostic-failure.json`. The diagnostic build is expressly
excluded from quality qualification. It had one positive/negative loss pair,
mid-song concealment/silence, and repeated 1.1–1.3 s boundary silence.

The next candidate replaces the consumption Notify with a single atomic permit
and AtomicWaker register/recheck. The stage instrumentation is removed. This
eliminates the waiter-list lock while preserving early consumption and the
latest waker, but still needs a live test because waking the Tokio task can
itself have scheduling cost. The CPU gate is unchanged. All 14 bridge tests pass.

## Atomic handoff and buffer experiment

Raydio 8627be9 (Crust 7f1f444) passed native CI 34053501317 on both architectures.
Its locally built Oracle binary SHA256 was
`33a451b80b9dd84c8ee1a0f7fb09f687f1c93f7638ce63115fa68d446154f28f`.
The fresh receiver stayed connected for 438.695 seconds until manually stopped.
There was no terminal sender warning. It nevertheless recorded one 605.292 ms
mid-song quiet interval, 1,403.521 ms total concealment, 883.625 ms silent
concealment, no positive/net packet loss, and no clipping. Two track restarts
also had 1.17–1.32 s boundary silence. The second boundary's panel position was
stale at 205 seconds: panel-derived phases are approximate and need review.
`endurance-atomic-consumed-diagnostic.json` contains the finalized stopped report.

A subsequent Crust 4bf2445 experiment enlarged finite-source prefetch from 320 ms
to 1.28 s. Its 19 adapter tests and Clippy passed, but the fresh 86.197-second
receiver run still recorded 751.104 ms mid-song silence, 975.833 ms concealment,
and four lost packets. This is no proved improvement (`endurance-buffer64-diagnostic.json`).
Increasing the encoded buffer also delays audible filters/volume, so the
experiment is reverted. There is no evidence yet to attribute these receiver
gaps to source reads, VM scheduling, Discord, or the receiving computer.

The post-capture /diagnostics window reported 3,000 sent, zero unavailable and
zero missed deadlines, but was too late to cover the gap. The next candidate
retains lifetime sender counters in one audio-shutdown log. This adds no
per-frame work and allows receiver events to be checked against source
starvation and missed pacing deadlines over the entire run.

## Remaining callback isolation

The atomic-wakeup candidate 8097bb9 passed native CI 34055389129, but terminated
at 19:44:36.028250 UTC, after 242.409 seconds of receiver coverage. Its overrun
was 5,907 us wall / 5,913 us thread CPU, with zero skipped deadlines and send
failures. The shutdown summary did not run on this failure path; the terminal
warning now includes the other sender counters too. The longer atomic handoff
run therefore did not prove the fatal issue fixed. See
`endurance-lifetime-summary-failure.json` and `source-atomic-terminal-oracle.txt`.

Crust 7383101 replaces the remaining Tokio channel (whose bounded semaphore
release takes a mutex) with a capacity-one `rtrb` ring. Normal callbacks now copy
the frame and store the consumed atomic; they do not wake a Tokio producer task.
Empty-source readiness uses register/recheck and the producer's completion guard
wakes on normal end, failure, shutdown, and abort-before-first-poll. While one
frame is staged, the producer checks consumption after 1 ms sleeps. It still
awaits source readiness and cancellation, and does not pull additional frames
before consumption. The source CPU kill gate and 16-frame media buffer remain.

All 14 existing bridge tests plus the new abort-before-start regression and
Clippy pass. In the ten-sender release benchmark, warmed PSS fell from 3,694 to
2,696 KiB, with unchanged 1,491 allocations / 1,500 frames and no new threads.
CPU increased from roughly 1% to 3.33% of one core due to producer timers. This
is an isolated benchmark, not whole-bot memory or latency improvement. The
ring candidate still requires live Oracle validation.

The final live result is pending. No finite test guarantees future network
behavior or proves every audible source defect absent.

## First ring candidate receiver test

Raydio 7bd74dc passed native CI 34056426179 on both architectures. The local
release binary completed and was deployed only to the temporary Testbot service
on the existing Oracle VM, SHA256
`a713cdf00df56e7561ef58982d9d8be36e4cca32874e462a74ad8509753070a6`.
No SSH sessions, builds, controls, packet probes, or VM resource sampler ran
during the 241.369-second measured window starting 21:09:24.590 UTC.

The ring did not terminate in this short window, but receiver quality failed:
715.438 ms and 138.479 ms mid-song quiet intervals with speaking interruptions,
1,323.750 ms boundary quiet, no positive/net packet loss, no near-full-scale or
nonfinite PCM, and no missing meter reports. Small concealment events also recur
at approximately 15-second intervals. The complete stopped report is
`endurance-ring-diagnostic.json`. This is not a pass or a proved improvement.

After measurement the service was stopped. Its normal shutdown summary was
missing because Raydio's `warn,raydio=...` filter suppressed the adapter's
info-level counters. The adapter has exactly two log sites, both bounded
credential-free lifecycle logs. The application now enables that module at its
configured log level; HTTP/media debug logs remain suppressed. A new run is
required to classify the gaps with complete sender counters. No counters can
be reconstructed for the discarded process.

## Counter, source, and receiver isolation

Raydio b446bd6 enables the adapter's lifecycle summaries; local tests (49),
formatting and Clippy passed. Its binary SHA256 is
`1400ac10799beab484f01fd56641a1fb1d26ca4ec28b9434751bce3746d1ab67`.
A 214.308-second repeat reproduced 588.25 ms quiet around song position 184 s.
Shutdown counters: 11,495 music frames, 11 silence/unavailable opportunities,
four skipped deadlines, max lateness 38.355 ms, no source overrun or send failure.
The counts include the track boundary and administrative stop. First idle PSS
was 12,431 KiB; playback samples 16,384–17,180 KiB, about 5.55–5.73% of one CPU
in fully active minute samples. No memory improvement is claimed.
See `endurance-ring-counters-diagnostic.json`, `ring-counters-oracle.txt`,
and `ring-oracle-resources.json`.

An independent system libopus 1.6 decode of the locally fetched source output
at volume 70 found 10,653 valid 20 ms frames, no mid-song silence >=20 ms,
no near-full-scale/nonfinite samples, and 938.438 ms quiet at the source tail.
The encoded output stays under ignored target/, with its hash in
`source-independent-decoder.json`. This narrows boundary silence but does not
prove that Oracle fetched the same rendition.

A subsequent explicitly diagnostic header-only sender trace reproduced
461.104 ms received silence. In the +/-2-second event window the VM sent 200
packets, maximum spacing 26.676 ms, maximum syscall duration 0.205 ms, no send
errors, sequence gaps, or timestamp discontinuities. Across the aligned
170.326-second capture, max spacing was 39.273 ms and zero gaps exceeded 40 ms.
Longer gaps after capture coincided with administrative shutdown and are
excluded. The sender had zero source overruns; all five unavailable/silence
frames belonged to shutdown. Discord's logs retained zero failed DAVE audio
decryptions throughout. See `ring-sender-receiver-correlation.json`,
`ring-discord-decryption.json`, and `endurance-ring-traced-diagnostic.json`.
This occurrence is beyond the outgoing send calls; it does not distinguish
Oracle network, Discord forwarding, receiving network, or receiver scheduling.

Removing the analysis AudioContext/PCM tap did not eliminate interruptions.
A 179.337-second stats-only run reported 3,447.5 ms silent concealment and
speaking interruptions, no reported loss, no source overruns or send failures.
Shutdown had ten unavailable/silence frames (five more than administrative
stop), nine skipped deadlines, max lateness 48.601 ms. This is a distinct source
starvation episode to diagnose, not proof that every earlier downstream gap
was source starvation. The optional `pcm:false` harness mode explicitly marks
PCM unmeasured. See `endurance-without-pcm-tap.json`.

## Source-only follow-up

The complete paced source diagnostic on Oracle reproduced a **3,943.614 ms**
frame request at frame 10,092, without Discord/Oto involved. Other requests
waited 448.806, 180.397, 85.297, and 152.464 ms. All 10,653 produced packets
independently decode as 20 ms audio with no mid-song quiet interval, clipping,
or nonfinite PCM. The tail is 938.458 ms quiet, consistent with local output.

Two repeats with a slow-socket-read interposer did not reproduce the multi-second
wait: max frame request 38.747/40.983 ms, observed socket reads up to 153.413/
121.426 ms. The interposer retains no content, URLs, addresses, or credentials,
and is confined to the bounded source-only executable. These repeats are
variation, not an implemented repair. `source-oracle-paced-audit.json` and
`source-oracle-independent-decoder.json` retain both findings.

A separate compressed HTTP input experiment (`examples/http_staging.rs`) on
Oracle reduced max read time from **244.864 ms to 0.957 ms**, and reads above
20 ms from **6 to 0**. Startup increased from **602.621 ms to 2285.692 ms** for
3,433,755 compressed bytes (3.27 MiB). Both runs produced all 10,653 frames.
See `http-staging-comparison.json`. This is a source-only prototype result,
not evidence of repaired Discord delivery or a reduction in total memory.

## Bounded staging integration (qualification pending)

Mantle now supports opt-in anonymous-file staging through the existing HTTP
validation, routing, cancellation and timeout policies. Raydio enables a
16 MiB per-object ceiling. Larger objects and live media continue streaming.
A 64 KiB temporary copy buffer is released before playback. File cache consumes
reclaimable host memory, so PSS alone cannot represent the storage cost.

Crust retains one completed compressed input per player and opens fresh media
state on same-track replay. Post-EOF seeking was unsuitable: WebM demuxer seek
can fail after EOF, and the PCM transcoder releases its consumed session.
Reopening the retained file avoids both conditions and releases processing
buffers while idle. Exact Opus/AAC replay tests stop both source servers before
replay and cancel the original request; new playback must still succeed with
fresh cancellation. Stop, replacement, shutdown and player cleanup release the
cache. No new per-frame lock, dependency or change to Oto's CPU gate is added.

The integrated source diagnostic supports `--staged --repeat`, verifies ordered
sequences, records startup and frame-read times, and cancels the first play
request before replay. Live receiver and six-hour qualification remain pending.

### Integrated Oracle source result (134e496)

The sequential same-executable source comparison did not reproduce the previous
network stalls. Streaming: startup 400.380 ms, max frame wait 13.558 ms, no waits
above 20 ms. Staged first play: startup 386.783 ms, max 29.192 ms at frame 1,
no later waits above 20 ms. Staged repeat: startup 0.367 ms, max frame wait
12.636 ms, no waits above 20 ms. Every play delivered 10,653 frames in 213.06 s.
The new run therefore validates replay and source isolation but does not prove
an improved worst-case frame wait relative to its own streaming baseline.

All three encoded outputs are byte-identical, SHA256
`29f1ac2bad421ed974c8276c15943cc6a47cbde931276c8d35f51c874532431b`.
Independent system libopus 1.6 decoding reports no malformed frame durations,
clipping, nonfinite PCM, or mid-song silence. The only quiet interval is the
same 938.458 ms source tail. Source-only max RSS was 8,532 KiB streaming versus
8,028 KiB for two staged plays; these are not whole-bot PSS or total file-cache
costs and are not used to claim a bot-memory improvement. Evidence:
`integrated-source-staging.json`.

Native CI 34079713433 passed tests, Clippy, deployment lifecycle checks and
package smoke checks on x86-64 and ARM64. The x86-64 candidate archive is
7,432,890 bytes. Candidate receiver binary SHA256:
`47e954f1c1daa13ae9963bfc1d02ca344c799b74d015b2720e517deade983490`.
The archive is installed for temporary Testbot only; production remains v0.2.1.

### Receiver attempt failed: source CPU guard

The exact native candidate ran 320.5195 measured seconds before its terminal
FrameSourceContract failure at 03:52:17.708 UTC. Oto measured 3,327 us wall and
3,330 us thread CPU for a callback. Sender lifetime: 19,419 audio packets,
zero unavailable/silence frames, zero send failures, seven skipped deadlines,
max lateness 38,699 us, one source overrun. The ring callback is therefore not
qualified; staging fixed no terminal-source CPU guard condition. No gate is
weakened. This is a failed attempt, not partial six-hour credit.

Before termination the receiver had zero net loss (one late/recovered packet),
273.688 ms total non-silent concealment, zero silent concealment, clipping,
nonfinite or empty PCM. The first repeat's 976.250 ms quiet interval is near the
938.458 ms source tail. The disconnect ended continuous receiver coverage and
added 241.875 ms quiet at the failed capture's end. No SSH/build/trace ran during
coverage. See `endurance-staging-terminal-failure.json` and
`staging-sender-terminal.txt`.

Minute resource samples are in `staging-oracle-resources.json`. Candidate idle
pre-play PSS was 12,124–12,144 KiB versus 12,350–12,358 KiB before (about 0.20 MiB
less, a small observational difference). Warm playback PSS was 16,067–16,075 KiB
plus 3,436,544 bytes of reclaimable cgroup file cache; steady CPU approximately
5.5% of one core. No cgroup memory-pressure/OOM events occurred. After the
failure, file cache fell to zero as the player's anonymous input was released.

### Callback isolation follow-up (not yet qualified)

Oto's source wake path was profiled locally. Before the change, a deliberately
slow 5 ms scheduler invoked synchronously by a source waker consumed 5,011 us
of source-wake CPU; after deferral, the same wake consumed 10 us and delivery
occurred after polling. The complete 10-second encrypted DAVE path remained
zero-allocation (501 frames/packets); max lateness was 1.538 ms before and
1.326 ms after. All 81 Oto tests, including a 1,000-iteration poll-exit race,
pass. This provides a bounded callback hypothesis and regression evidence, but
not a live Oracle causality proof. `oto-deferred-source-wake.json` records the
comparison. A fresh full receiver run is still required.

### Corrected deferred-wake candidate started

After publishing Oto 3d651c6 and updating Raydio's Crust pin to 32dd0fd's
follow-up b5fdc90 integration, the corrected native executable (SHA256
`bb7467d99a570e104e9d9e06934a4ab53cfb0c085a4f6ecf04498e7aef5d0f57`) started on
Oracle at 04:27 UTC. The controlled Discord receiver is connected in General,
muted, with loop enabled and volume 70%. Initial six-second receiver counters:
300 packets, 0 loss, 0 concealment, 0 silent concealment, 0 clipping/nonfinite/
empty frames, and 0 PCM quiet events. This is only startup evidence; the
six-hour qualification was started; its subsequent failure is recorded below.


### Corrected deferred-wake attempt failed (recovered September 7)

The candidate terminated audio at **04:37:04.540940 UTC** with
`FrameSourceContract`: 7,036 us wall and 7,042 us measured thread CPU.
It sent 28,316 audio frames with zero unavailable/silence frames and zero send
failures, but 14 skipped deadlines and 69,586 us maximum lateness. Deferring
source wakes did not eliminate this terminal failure. The callback operation
responsible for this occurrence remains unlocalized; do not infer it from the
previous notifier reproduction.

The service remained up until its seven-hour systemd runtime limit at 11:27 UTC.
That service uptime is **not** continuous playback. The controlled browser tab
was replaced before its report could be recovered; the new signed-in tab has no
prior meter data. There is no six-hour receiver result.

The corrected resource sampler never started collecting: the launch omitted its
mandatory `--output` argument and argparse exited with status 2 at 04:28:36 UTC.
Consequently this run has no playback PSS/RSS/file-cache series. Its systemd
memory peak is incomplete accounting, not a replacement for those samples.
Future launches must supply the output path and verify a valid first sample
before playback starts. See `deferred-wake-oracle-failure.json` and
`deferred-wake-oracle-terminal.txt`.

Production remains on its existing Rust v0.2.1 release; this unqualified
candidate has not been promoted. The next run must start from zero after the
failure is diagnosed and corrected.

### Fifteen-minute callback timing diagnostic

The existing temporary ring-stage timing patch was applied to Crust b5fdc90
and built against the corrected Oto pin. Diagnostic executable SHA256:
`57dcc64429d5b19a6c8f5b2cc1950a56bfdb7b0f8b396afad0bddb4cee596f9f`.
The patch was reverted from the worktree after preserving the executable.
No permanent audio-path change was made. This instrumentation can alter timing;
its 15-minute completion does not qualify the uninstrumented candidate.

From 12:33:55 UTC the receiver observed approximately 900 seconds and four
repeats, 44,977 packets, three net lost packets (four positive, one recovered),
1,265.521 ms non-silent concealment, zero silent concealment, clipping,
nonfinite/empty PCM, or missing PCM reports. Quiet events >=20 ms occurred near
track endings; the longest was 1,018.75 ms, versus 938.458 ms source-tail quiet.
Small concealment events recur roughly every 15 seconds; cause remains open.

After receiver completion, normal administrative shutdown logged 46,474 audio
frames, eight unavailable/silence frames, 19 skipped deadlines, 52,728 us max
lateness, zero send failures and zero source overruns. These lifetime counters
include playback outside the receiver window and the shutdown silence drain.
No terminal callback was available to localize in this attempt.

The correctly launched sampler produced 19 rows. At elapsed 300–1,020 seconds,
PSS was 16,303–16,611 KiB (median 16,611), RSS 18,860–19,168 KiB, cgroup file
cache 4,452,352 bytes, and CPU about 5.55% of one core. No memory pressure/OOM
events occurred. This is diagnostic-build accounting, not a new memory win.
See `deferred-stage-diagnostic-summary.json` and its raw receiver, sender and
resource reports. A paired exact-candidate run follows to check whether the
instrumented result is representative.

### Exact candidate repetition completed but receiver quality failed

The unchanged `bb7467...f57` candidate completed another 900-second receiver
window with four repeats: 44,986 packets, zero positive/net loss, 1,103.771 ms
concealment including **25.375 ms silent concealment**. At measured 689.82 s,
the PCM meter observed **25.396 ms mid-song quiet**. The corresponding receiver
poll reported 215.688 ms total concealment, 50 packets, and zero packet loss.
There was no clipping, nonfinite/empty PCM, or missing PCM report. Successful
packet counts therefore remain insufficient evidence of uninterrupted audio.

Administrative shutdown logged 48,338 sent, nine unavailable/silence frames,
17 skipped deadlines, 54,804 us maximum lateness, and zero source overruns or
send failures. The prior terminal source failure did not recur in either
15-minute run; neither run proves its cause fixed. Warm PSS was 16,220–16,520
KiB (median 16,520), with 3,436,544 bytes cgroup file cache and about 5.59% CPU.
These are observed costs, not a newly implemented memory improvement.
See `exact-comparison-summary.json` and the raw receiver/sender/resource files.

Receiver main-thread long tasks and visibility transitions were not recorded
in those runs. An optional event-driven `scheduling:true` meter mode now records
these for a separate diagnostic, without adding a timer or altering WebRTC
buffering. This is intended to distinguish receiving-browser interference from
sender/network symptoms; correlation alone will not establish causality.

### Receiver scheduling diagnostic completed

A third 900-second run used the unchanged `bb7467...f57` candidate while the
browser meter observed main-thread long tasks and visibility changes. It
recorded zero long tasks (the API reports tasks >=50 ms), no visibility
transitions, and no missing PCM reports. This excludes recorded main-thread
long tasks for this run; it does not exclude receiver audio/network-thread
scheduling, local OS delays, or other browser/host effects, and cannot establish
the cause of an event in a different run.

The receiver counted 44,991 packets and zero **net** loss, but 37 positive loss
increments were subsequently recovered. During the interruption after the
fourth repeat it counted only 14 packets and +36 lost in one window, then 86
packets and -36 lost in the next. Recovery of the counters does not undo audio
already concealed while those packets were unavailable.

At measured 843.724 s the PCM report retained **596.667 ms unexpected quiet**
after playback resumed at the track head, separate from source-tail silence.
The speaking indicator went off for **617.8 ms**. Total concealment was
939.792 ms, comprising 596.479 ms silent and 343.313 ms non-silent concealment.
There was no clipping, nonfinite/empty PCM, or >=20 ms middle-phase quiet in
this run. The source of the delayed packet batch remains unlocalized.

Sender shutdown reported 47,404 frames, seven unavailable/silence frames,
13 skipped deadlines, 66,903 us maximum lateness, zero source overruns and zero
send failures. These lifetime maxima do not locate an individual receiver
event. Warm PSS was 16,456–16,760 KiB (16.07–16.37 MiB), with 3,436,544 bytes
cgroup file cache, about 5.52% CPU and no cgroup pressure/OOM events.
See `receiver-scheduling-diagnostic.json`, `receiver-scheduling-sender.txt`, and
`receiver-scheduling-resources.json`. This is a failed quality observation,
not six-hour qualification or proof of a specific responsible component.

### Speaking-indicator confirmation for the shorter gap

In the earlier exact-candidate run, the **25.396 ms mid-song quiet** event
coincided with speaking false at 689,727.4 ms and speaking true at 689,791.3 ms:
a **63.9 ms indicator interruption**. The nearby receiver window recorded
215.688 ms total concealment, including 25.375 ms silent concealment. These
are different measurements; neither the indicator duration nor total
concealment should be substituted for the measured quiet duration. Audible
severity was not assessed by a human during this run. The received gap and
indicator interruption are sufficient to fail the requested uninterrupted
playback criterion.

### Outgoing-header correlation reproduced a sender pacing stall

The exact candidate was observed with the bounded `udp_send_trace.c` interposer
from 17:32 UTC. Observation was deliberately stopped at **809.573 seconds** after
a non-tail speaking-indicator interruption, rather than counted as a completed
900-second qualification. The receiver counted 40,446 packets, zero net loss
(one positive and one recovered), 947.604 ms non-silent concealment, zero silent
concealment and no >=20 ms non-tail quiet. Clipping, nonfinite/empty PCM,
long tasks and missing PCM reports were all zero. The indicator went false at
759,077.2 ms and true at 759,098.1 ms: **20.9 ms**. This indicator event is not
evidence of a 20.9 ms silent PCM interval.

Within the same measured interval, the outgoing trace counted 40,446 packets,
zero send failures, zero sequence/timestamp discontinuities, and **13 send gaps
above 40 ms**. The largest was **159.436 ms**, ending at 758,987.227 ms, just before
the indicator event. Two nearby gaps were about 80 ms. The earlier receiver
concealment burst at 454 s also coincided with several 60–79 ms send gaps.
Smaller periodic concealment events often had normal outgoing timing within
their surrounding windows, so these observations do not establish a single
cause for every receiver symptom.

Unlike an older receiver-only delayed batch, this run localizes some timing
failure to the send side. It does not yet distinguish application work, guest
scheduling, VM descheduling, or diagnostic overhead. Send completion also does
not prove downstream arrival. Oracle's existing `sar` report showed 0.85% steal
averaged across the two vCPUs during 17:30–17:40, too coarse to attribute events.
An independent low-priority sleeping-timer probe follows to measure that
hypothesis without changing the candidate or increasing audio buffering.

Warm PSS was 16,222–16,246 KiB, CPU 5.67% of one core. Cgroup file cache reached
5,459,968 bytes including the growing diagnostic trace. These are diagnostic
costs, not another memory improvement. Normal shutdown reported 42,374 audio
frames, six unavailable/silence frames, 29 skipped deadlines, zero source
overruns/send failures and 128,613 us max lateness; lifetime counters include
time outside the measured interval. Production remains unchanged.

See `delivery-trace-{receiver,correlation,clock,resources,summary}.json`,
`delivery-trace-sender.txt`, and compressed header-only trace
`delivery-trace-headers.csv.gz`. `benchmarks/correlate_delivery.py` regenerates
correlations after decompressing the trace. Its windows include the preceding
packet to retain gaps crossing the left boundary and exclude post-measurement
administrative shutdown.

### Independent vCPU timers support VM descheduling attribution

The same candidate then completed a **1,100-second** receiver window beginning
17:52:40.998 UTC, with outgoing header tracing plus a separate fixed-buffer
sleeping-timer probe. Each of two timers was pinned to a different vCPU at nice
10; the probe also read per-vCPU steal counters once per second. Its full
1,200-second lifetime used 3.002 CPU seconds (0.250% of one core), had no timer
errors or truncated events, and included the complete receiver interval.

The receiver counted 54,987 packets, zero net loss (two positive and two
recovered), 676.104 ms non-silent concealment, zero silent concealment, zero
non-tail >=20 ms quiet or speaking-off events, and zero clipping/nonfinite/empty
PCM, missing reports or recorded long tasks. This is a finite diagnostic
completion, not a code improvement or six-hour pass.

Outgoing timing had seven gaps above 40 ms, maximum **60.338 ms**, and no
sequence/timestamp discontinuities or send failures. Four roughly 60 ms gaps
around measured 1,067.2–1,067.5 s coincided with independent timer delays on
**both** vCPUs (about **37 ms**). Their containing one-second CPU samples
recorded increments up to **19 and 18 steal ticks**, respectively. The receiver
then concealed **124.208 ms** in the corresponding one-second window. Another
59.082 ms send gap at 167.209 s overlapped 36.8 ms wake delays on both vCPUs.
This supports whole-VM descheduling as a cause of these clusters, beyond
application-only scheduling. Timer/steal granularity and instrumentation still
limit attribution; two other >40 ms gaps did not overlap retained >=10 ms probe
delays. No claim is made that every recorded symptom has the same cause.

Warm PSS was 16,480–16,707 KiB, CPU 5.55% of one core, with growing trace file
cache included in 6,385,664 bytes of cgroup file accounting. Candidate service
RuntimeMaxSec stopped it normally after the receiver finished; systemd's
`timeout` result describes that administrative bound. Sender shutdown had
59,237 audio frames, five unavailable/silence frames, ten skipped deadlines,
zero source overruns/send failures and 46,966 us max lateness. The unresolved
2 ms source-CPU failure did not recur; this does not prove it fixed.

See `scheduler-delivery-{receiver,correlation,clock,resources,summary}.json`,
`scheduler-delivery-sender.txt`, `scheduler-probe.csv`, and
`scheduler-delivery-headers.csv.gz`. The correlation tool accepts the probe
with `--scheduler`. A read-only A1 capacity check at 18:13:41 UTC still returned
`OUT_OF_HOST_CAPACITY` for 1 OCPU / 1 GiB in São Paulo. No paid resources or
additional instance were created.
