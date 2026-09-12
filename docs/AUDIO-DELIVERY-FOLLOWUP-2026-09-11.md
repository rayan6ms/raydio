# Further delivery improvements — September 11, 2026

There is a concrete reason to investigate sender scheduling and recovery after
stalls. The retained data associate sender gaps with increased Oracle CPU steal
time, and the largest recorded receiver incident coincides with sender gaps.
Other receiver incidents occur with steady sender counters, so this cannot
explain all concealment or locate every lost packet. No new fix or live
improvement is claimed by this analysis.

## New findings from the retained run

The sender's 359 comparable minute intervals contain 220 successful-send gaps
of at least 40 ms, concentrated in 64 minutes. The maximum was 81.502 ms;
none reached 100 ms. These measure sender spacing, not audible interruption.

| Mean resource measurement | 64 minutes with gaps | 295 minutes without gaps |
|---|---:|---:|
| Oracle CPU steal | 0.605% | 0.296% |
| Guest CPU pressure | 0.478% | 0.393% |
| Bot CPU, one core | 3.977% | 3.921% |

CPU steal records time when the hypervisor did not provide the VM's requested
CPU time. Its association with gap count is consistent with host scheduling
contributing to stalls. The bot's roughly 4% average CPU usage does not protect
it from brief scheduling delays. Raising guest process priority cannot make
Oracle provide CPU time while the VM is descheduled.

Resource and sender checkpoints are offset. The table weights each resource
interval by its overlap with a sender interval, assuming uniform counter
increments inside the resource interval. The descriptive Pearson correlation
between steal percentage and gap count is 0.661. Pairing by nearest interval
midpoint instead gives 0.557 and mean steal of 0.576% versus 0.302%. The
association survives this alignment change; neither method resolves individual
stalls or proves causality. Adjacent minute observations are not necessarily
independent, and no significance claim is made.

The minute ending **12:28:46 UTC** contains nine sender gaps, no unavailable
source frames, approximately 1.354% overlap-weighted steal, and **2.309 seconds
of receiver concealment** with 48 positive loss deltas. Positive loss deltas
include gaps later corrected by reordered/late packets; they are not permanent
loss totals. By contrast, the minute ending **12:32:46 UTC** contains 427.625 ms
of concealment while the sender emits 3,000 frames with zero new ≥40 ms gaps,
skipped deadlines, or unavailable frames. A sender-only explanation is incomplete.
These are minute coincidences using receiver polling endpoints, without a new
measurement of cross-host clock error or exact packet arrival times.

The valid **65 minutes 55 seconds** of receiver recording can also be grouped
by loss/discard counter changes in the same polling interval:

| Poll group | Concealed audio | Silent concealment |
|---|---:|---:|
| Positive loss delta | 1,652.521 ms | 270.563 ms |
| Discards, no positive loss delta | 2,141.333 ms | 0 ms |
| Neither positive loss nor discards | 3,649.042 ms | 276.063 ms |

Thus **77.8% of concealed samples occurred in polls without a positive loss
delta**. This supports investigating timing, late delivery, and decoder recovery
alongside raw loss. It does not attribute that percentage to a particular cause:
counter reporting, corrections, and decoder effects can occur in different polls.
Concealment is replacement audio and is not synonymous with silence.

The receiver recorded 15 net lost packets and 103 discards in this valid window.
The later snapshot has more favorable cumulative counters but lacks continuous
receiver/PCM coverage. It remains separate, as explained in the
[rerun report](AUDIO-RERUN-RESULTS-2026-09-11.md).

## Prioritized experiments

1. **Locate remaining sender delay before changing scheduling.** Validate the
   existing bounded send-trace consumer's overhead on Oracle, then use it in a
   short diagnostic run with synchronized receiver recording. Measure deadline
   wakeup, source polling, DAVE encryption wait, and UDP completion separately
   using bounded in-memory timing records if the existing trace cannot separate
   them. Distinguish time waiting for CPU from time executing bot work. Keep
   expensive logging and builds outside the acceptance run.

2. **Compare scheduling and stall recovery while preserving the audio.** The
   current Oto pacer sends one frame after a stall and schedules the next frame
   a full 20 ms after completion. This prevents catch-up bursts but does not
   recover the resulting media backlog. Test whether a carefully bounded return
   to the original cadence reduces receiver buffer depletion and concealment;
   retain original frames, sequence order, and media timestamps. Do not send an
   unbounded backlog or drop frames to improve timing counters. A smaller gap
   counter alone is insufficient: this experiment could also worsen delivery.
   If delay attribution instead identifies task handoffs or local competition,
   target those first. A guest priority adjustment is useful only for demonstrated
   guest contention and cannot solve hypervisor steal.

3. **Separate delivery-path effects from sender effects.** If loss/discards
   persist with steady sends, compare the same Oracle sender using a stable
   second listener connection, or perform alternating tests of available Discord
   voice-region routes. Preserve the main reference route and record each change.
   A second listener adds a participant and possibly DAVE transitions, so treat
   this as a separate diagnostic, not part of the uninterrupted acceptance run.
   One browser receiver cannot determine whether Oracle egress, Discord, or the
   listener's Starlink path caused a missing/late packet.

4. **Qualify only a measured improvement.** Use alternating short baseline and
   candidate trials with the same source, volume, route, codec, and receiver.
   Compare gaps per hour, net loss and positive/negative corrections, discards,
   concealed/silent samples, and off-boundary PCM interruptions, as well as CPU
   and PSS. Five minutes can catch functional failure but is too short to judge
   these rare events reliably. After a candidate succeeds, run six hours with
   the repaired UI-independent receiver observer and verified persistent saves.
   Song tails remain classified separately; overlapping transport anomalies must
   stay visible. Full receiver coverage is mandatory for a six-hour quality claim.

Keep the current bitrate, stereo, music encoding mode, and 5% loss hint for the
first timing experiments. The existing hint reduced simulated loss-induced
waveform error, not actual network loss. A 10% hint showed little extra benefit;
forced FEC substantially degraded the tested music encoding and increased CPU.
There were no local socket-buffer errors to justify increasing buffers. Neither
larger buffers nor stronger loss protection should be applied without evidence
and an audio-quality comparison.

## Reproduction and scope

Run `uv run --no-project python evidence/transport-improvements-20260911/analyze_delivery_followup.py`
from the Rust repository. The analysis checks that grouped receiver loss,
discards, and concealment reconcile with the retained cumulative deltas and
that minute sender gaps reconcile with the run summary. It records input hashes
and preserves missing receiver intervals as null, never as error-free minutes.

Output: [delivery-followup-20260911.json](../evidence/transport-improvements-20260911/delivery-followup-20260911.json).
This is offline evidence analysis; no bot binary, deployment, codec setting,
or service state was changed, and no new endurance run was started.

## Timing-stage experiment result

The opt-in trace now records timer wake lateness, source polling, DAVE queue and
owner work, transport crypto, and UDP submission wait for each successful packet.
The 30-second complete Oto/DAVE/UDP benchmark produced 1,501 frames and 1,501
local UDP packets with **zero allocations, reallocations, or bytes allocated**
in its measurement region. The trace ring had no overflow. This validates that
the added diagnostics do not allocate per frame in the measured path.

In an Oracle comparison with the existing sender policy, the largest gaps were
usually wakeup delays; source polling remained at a 1–2 microsecond median and
DAVE work remained tens of microseconds. This points away from ordinary source polling/encryption cost as the dominant
cause in this trace. It does not distinguish hypervisor scheduling from guest
or application scheduling, nor exclude occasional costly work.

A prototype that enforced 18 ms minimum spacing and bounded recovery debt removed
all sub-18 ms send intervals (baseline had 118 in the aligned ten-minute trace),
but it produced **60 ≥40 ms gaps versus 26** in the same traced comparison and
did not establish lower concealment. Its receiver result was directionally mixed
(1.236 s concealment, 0 discards, 21.8 ms silent concealment versus the traced
baseline's 1.487 s, 9 discards, 0 ms silent concealment). A later untraced trial
was invalidated by the experiment operator stopping Testbot at 207 seconds;
the consequent disappearance of receiver stats was expected. Because long-gap rate
and silent concealment were not consistently better, this pacing policy is **not
promoted**. The repository keeps the proven direct timer and exposes stage
timing only when the existing opt-in trace is enabled.

The follow-up trace-disabled comparison tested a narrower 10 ms minimum-spacing
policy against the original pacer under the same source, volume, route, and
receiver. Both recordings had complete PCM, polling, event, and connection
coverage, zero net lost packets, and zero silent concealment. The original pacer
produced 6 sender gaps ≥40 ms and 390.3 ms of concealment (39.0 ms/min); the
10 ms policy produced 16 such gaps and 791.5 ms (79.1 ms/min). Median PSS was
16.60 versus 16.26 MiB and bot CPU 3.86% versus 3.82% of one core. The small
resource difference does not justify the worse delivery metrics, so the 10 ms
policy was reverted. These are controlled ten-minute observations, not a
six-hour claim.

The Oracle production `raydio.service` remained disabled; these experiments use
Testbot only. Maintenance protection is bounded and has an automatic restoration
timer. No default codec, bitrate, FEC, or buffer setting changed. The stage timing
and trace-schema changes are committed in Oto `4f68e8c7` and Crust
`24a9fa6d`. Raydio is pinned to those revisions. The narrower minimum-spacing
experiment was completed and rejected by the matched receiver comparison below.

Two incomplete attempts are excluded: a command submitted while Testbot was
offline never established playback, and the experiment operator explicitly
stopped a later run at 207 seconds. The resulting disappearance of receiver
stats was caused by that administrative stop. Neither is evidence of a Discord
or bot playback defect. An incomplete binary upload was also mistakenly checked
before transfer completion; it was never started as the bot. The complete file
subsequently passed its exact hash and backend checks.
