# Five-minute Oracle validation after the EOF fix

The patched Testbot completed 300 seconds from **2026-09-10 01:00:57.115 UTC to
01:05:57.116 UTC** (September 9, 22:00:57–22:05:57 São Paulo) in test/General,
playing Rick Astley at volume 70 with Loop ON. The capture included one natural
restart. This is a successful short playback/loop regression, with residual
delivery concealment; it is **not** a perfect-audio or six-hour qualification.

| Measurement | Result |
|---|---:|
| Receiver / PCM coverage | 300.000 / 300.011 s |
| Received packets | 15,000 |
| Positive / net packet loss | 0 / 0 |
| Discarded packets / NACKs | 7 / 19 |
| Concealment | 273.083 ms total; 54.617 ms/min |
| Silent concealment | 0 ms |
| PCM clipping / nonfinite samples / empty frames | 0 / 0 / 0 |
| Quiet intervals ≥100 ms requiring review | 0 |
| Longest quiet interval | 976.25 ms, matching the ordinary song tail |
| Receiver connection transitions | 0 |
| Stale polls / missing PCM reports / dropped event windows | 0 / 0 / 0 |
| Checkpoint saves / errors | 7 / 0 |
| Bot PSS (five samples) | 15.872–16.056 MiB; median 15.872 MiB |
| Bot CPU (resource sample span) | 3.754% of one core |
| Bot restarts | 0 |

## What the loop establishes

Crust delivered generation 1's natural finish at 01:03:50.693147 UTC and Raydio
logged generation 2's start at 01:03:50.695194 UTC: **2.047 ms between event logs**.
This is control-event timing, not an end-to-end acoustic gap measurement. Neither
the watchdog warning nor the missing-generation warning appeared.

The receiver saw the familiar 21.958 ms quiet blip and 976.25 ms tail. Speaking
turned off and back on only around that source ending. The tail's timing and
duration agree with the independently measured ~938.458 ms source-tail reference
and earlier ordinary ~976 ms receiver tails. No audio was trimmed or re-encoded
differently by this fix. The meter retains every qualifying quiet interval and
does not automatically discard a long silence just because it ends at a restart.

The earlier six-hour recording included a **15,623.75 ms extended tail**. The
deterministic regression reproduces loss of terminal generation before the fix
and preserves it afterward. This provides direct evidence that the race is fixed;
the ordinary short live loop provides deployment validation. A rare historical
incident and one ordinary loop do not establish a recurrence-rate improvement or
prove that the historical event had this cause beyond doubt.

## Sender, host and receiver limits

The sender checkpoints from 01:01:17.934782 to 01:05:17.934467 span four minutes:
12,000 frames, with zero increases in unavailable/silence frames, skipped
deadlines, send failures, or source overruns. All checkpoints, including the
post-window one, report zero cumulative unavailable frames, send failures and
source overruns. The skipped-deadline counter was already 3 at the first
checkpoint and stayed 3; its 39.984 ms maximum lateness is cumulative and cannot
be dated to startup versus the first 21 seconds of this receiver window. Do not
claim zero missed deadlines over the entire five minutes from these samples.

Oracle resource samples show no UDP errors, interface errors/drops, OOM, or
cgroup memory-pressure events; the kernel interval has no entries. Five local
host samples show unchanged interface error/drop counters and no UDP errors.
These minute-resolution observations cannot exclude shorter host disturbances.
PSS/CPU are descriptive; comparing this short run with a warm six-hour run does
not establish a memory or CPU improvement from an event-metadata fix.

The browser recorded five main-thread long tasks of 55–62 ms (293 ms total).
None overlaps a recorded receiver concealment/discard window. There were no
missing audio reports, stale polls, empty PCM frames, or non-tail quiet events.
That supports complete observation, but does not prove zero diagnostic overhead
or locate the remaining network/jitter-buffer cause. The 273 ms of concealment
is synthesized replacement audio, not 273 ms of silence, and its audibility is
not established by aggregate PCM counters. No new perceptual listening claim is
made. A single receiver cannot isolate the failing network hop.

The previous separate **14.826-second ICE disconnect** was not reproduced here
and remains outside the demonstrated fix. This test cannot rule out recurrence.

## Provenance and safeguards

- Raydio candidate: `9eb883bdad6f5ba52d2024ce994bdde9144d78dd`.
- Crust: `dba892f8e12dca582db6848acae9f37b8a1ffc5e`.
- Binary: `a665618b5a2c860555fdf3c2bbe7ecfdbd45e84bf5a67c4eb205a09cbc4127b7`,
  18,596,784 bytes; local and Oracle backend checks passed.
- Crust tests: 154 passed, four manual benchmarks ignored; Raydio: 49 passed.
  Formatting and strict lint checks passed. Both architectures passed
  [CI run 34422386391](https://github.com/rayan6ms/raydio/actions/runs/34422386391).
- Oracle Testbot PID 8167 remained the only bot process; production Raydio was
  inactive/disabled. No bot restart, control, local build or administrative SSH
  occurred during the measured interval. The user submitted play; Loop was
  enabled before the interval and automatic start waited for stable playback.
- Independent minute samplers ran on Oracle and the receiver host. Persistence
  verification matched the actual running report and verified remaining lifetime.
  Browser instrumentation was installed before joining voice. No packet tracing,
  audio recording, or high-frequency host probe was used.
- After collection, temporary samplers and the sleep inhibitor were stopped,
  and Oracle maintenance timers were restored. Testbot was left running with
  playback; production Raydio remains disabled.

Raw aggregate receiver, sender, resource, checkpoint and kernel evidence is
retained beside this report. `collection-sha256.json` records the collected-file
hashes; `run.json` records deployment and preflight metadata.
