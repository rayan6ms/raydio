# Six-hour observation completed; audio continuity did not pass

The receiver retained 21,600.0001 seconds and 21,600.0107 seconds of PCM coverage,
from 2026-09-09 08:34:57.932Z to 14:34:57.933Z (05:34–11:34 São Paulo).
The report was recovered intact from the still-open browser after the run.
Testbot PID 5601 remained connected/sending, with zero process restarts and no
terminal DAVE failure. Production Raydio remained stopped and disabled.
This does not prove the earlier DAVE failure fixed or identify why it did not recur.

## Observations

| Measurement | Result |
|---|---:|
| Receiver packets | 1,078,736 |
| Net lost packets | 79 (0.0073% of received + net lost) |
| Positive loss / subsequent recovery | 229 / 150 |
| Discarded packets / NACKs | 696 / 1,289 |
| Concealed audio | 46.274 seconds |
| Silent concealment | 19.119 seconds |
| PCM clipping / nonfinite / missing frames | 0 / 0 / 0 |
| Stale polls / missing PCM reports | 0 / 0 |
| Longest quiet interval | 14.184 seconds |
| Quiet intervals >=100ms outside ±2s of a backend repeat | 9 |
| Oracle PSS | 15.40–16.75 MiB |
| Oracle CPU | 3.98% of one core |
| Host CPU steal | 0.317% |
| Oracle UDP/interface error increments, OOM/limit events | 0 |

A low aggregate packet-loss percentage does not make concentrated interruptions
acceptable. No clipping in this sample also does not establish perfect perceptual
quality. All raw events and minute totals remain in results/receiver.json.

The first/last five memory samples had median PSS 16,150 / 17,154 KiB, an increase
of 1,004 KiB. This finite warmup/playback observation cannot establish a leak.
Sender checkpoints inside the window span 08:35:23 to 14:34:23 (359 minutes):
1,076,555 audio frames, three additional unavailable/silence frames, 203 additional
skipped deadlines, no send failures or source CPU overruns. Lifetime maximum
observed deadline lateness was 60.259ms. These are not exact receiver-window totals,
and a maximum late deadline is not a measured listener silence duration.

## Causal evidence

At approximately 12:08:13–12:08:27Z, the receiver experienced 14.184s of silence.
Packets stopped, ICE/peer state became disconnected and then reconnected; the
recorded disconnected-state interval was about 9.74s (the detection came later
than the beginning of packet starvation). Local Tailscale logs at 12:08:22Z report
router/NAT NetworkFailure and a changed public UDP mapping. Oracle checkpoints
bracketing this event continued at 3,000 frames/minute, Connected/Sending, with no
additional unavailable frames, skipped deadlines, send failures or overruns.
This strongly implicates the receiver-side network path. It does not identify
which router/ISP/Discord hop failed, nor show that Tailscale caused it.

The 1.131s gap around 12:18:58Z includes a near-empty receiver interval followed
by 93 packets, 68 positive lost packets and 44 recovered packets. The 1.015s gap
around 12:48:41Z includes 59 lost packets. Oracle sent 3,000 frames in the respective
bracketing minutes with unchanged underrun/skipped/error counts. Those are delivery
failures after the sender, but this single receiver cannot locate them precisely.
Other off-repeat quiet events were 123, 126, 330, 466, 543 and 592ms. Several are
large enough to be disruptive and are not dismissed as low average jitter.

202 quiet events align within ±2 seconds of actual logged backend repeats:
101 short ~22ms source-tail intervals and 101 longer tail intervals, mostly
976.25ms. Alignment is temporal evidence, not a new source-waveform comparison.
The visible Discord position lagged the sender by several seconds at times;
its heuristic 'middle' label alone incorrectly labels many recurring tails.
See results/quiet-classification.json; every quiet event is retained.

The previous valid 93-minute sample averaged ~64.2ms concealment/minute. This
run averaged 128.54ms/minute, or 87.24ms/minute when separately excluding the
entire outage minute (359 remaining minutes; 4.930s silent concealment remains).
Both totals are disclosed: excluding an outage is not a clean-session pass.
Different windows/network conditions preclude a causal before/after comparison.
Removing production has not demonstrated an audio or memory improvement.

## Diagnostic defects found and corrected

The prior turn incorrectly claimed working automatic checkpoints. After failed
preflights, browser_checkpoint.js cleared its timer. The subsequent real run used
that stopped timer and was not attached to the optional final-save promise. Only
failed preflight reports were on disk until manual recovery at 14:49:55Z. The full
browser report survived, but interval local-host counters were never collected.
Oracle's independent minute sampler worked throughout. No missing history is
invented or reconstructed as measured data.

The checkpoint collector now stays armed for its bounded seven-hour lifetime,
recognizes a replacement report, deduplicates unchanged completed reports and
retries failed saves. A regression covers failed preflight -> real run -> failed
write/retry -> completed final save without a manual promise hook, plus cleanup.
Receiver coverage now explicitly reports uninterruptedConnection=false after a
transient disconnect or incomplete event history; completed means observation
completion only. Both diagnostic harness suites pass.

All 1,943 events survived; 40 older before/after diagnostic windows were dropped
by the 128-window bound. The major network incident windows remain available.
The local journal was collected independently; no suspend event appeared in the
queried service history. It is not a substitute for the missing local samples.

## Next steps based on this evidence

1. Keep Oracle and current codec/bitrate settings. Resource pressure and source
   starvation do not explain the major incidents. No speculative encryption or
   bitrate change is justified by this run.
2. Use a second receiver on an independent network concurrently with this one,
   with both checkpoint preflights verified against the actual running report.
   Simultaneous gaps implicate the shared sender/Discord path; receiver-specific
   gaps implicate its downstream route. First perform a shorter diagnostic window.
3. If shared gaps recur, obtain bounded sender egress-timing evidence in a separate
   diagnostic run. Current minute counters exclude long sender stoppages but do
   not prove every packet's send time. Do not introduce a packet interposer into
   a qualification run or treat it as measurement-neutral.
4. Continue retaining typed DAVE context. The original terminal failure did not
   recur, so there is still no reproduced DAVE bug to claim fixed.

After retrieval, temporary samplers/snapshot timers and local sleep inhibition
were stopped; Oracle maintenance timers were restored. Testbot stays online and
playing for user review. Production Raydio remains disabled. No new six-hour test
was started automatically during this results review.
