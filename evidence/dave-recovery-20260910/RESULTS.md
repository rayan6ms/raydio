# DAVE epoch recovery — 2026-09-10

The previous Oracle attempt stopped at 05:56:38 UTC with
`DaveTransition / InvalidState`, active version 0, no pending transition, and
readiness false. The user confirmed that their Starlink dish rebooted for an
update, explaining the earlier receiver network interruption. That does not
excuse the subsequent permanent bot playback failure.

## Reproduced cause

Oto checked the gateway's Connected phase before polling/sending a frame. The
separate DAVE owner could then process Prepare Epoch (epoch 1) or invalid-commit
recovery, clearing the encryption context. The gateway publishes its phase after
awaiting the control and outbound messages. A queued audio encryption request
therefore could reach an unready owner despite having passed the earlier check.
All encryption errors, including temporary not-readiness, were classified fatal.
Crust reported a closed voice connection, and Raydio cleaned up the session.

`reproduction-before.txt` captures a failing deterministic test against Oto
831d5e2. A real DAVE fixture is ready, the sender begins its Speaking handshake,
then Prepare Epoch resets the owner before media encryption. The sender fails
with exactly the live error/context. The fixed test remains nonfailed, sends no
plaintext, and accepts Stop within the test's 100 ms deadline.

This proves a code defect with the observed failure mechanism. The historical
log lacks the triggering opcode, so it cannot distinguish Prepare Epoch from
invalid-commit recovery for that particular live occurrence. The initial receiver
outage preceded this bot failure and is not attributed to the race.

## Implementation

- Oto 352fa9a: the encryption owner returns a distinct temporary NotReady outcome
  in the same serialized turn as the readiness decision. Actual crypto/backend,
  malformed protocol, downgrade, queue and owner failures remain errors.
- The sender observes the DAVE readiness watch as well as connection state. It
  pauses pacing and resumes on readiness without relying on an intermediate
  gateway phase being delivered. There is no periodic retry worker or spin loop.
- The one unsent frame stays in the existing frame buffer. No extra audio queue
  or re-encoding is added. Stop and replacement invalidate it; transport renewal
  and rekey preserve it. No plaintext fallback is introduced.
- A same-transport rekey retains knowledge of Speaking, so Stop clears it and
  resumption avoids a redundant gateway round trip. A rekey during the final
  silence drain resumes the normal bounded tail rather than leaving Speaking set.
- Bounded lifecycle events expose only opcode, generation and readiness/version
  before/after. Crust logs them on state changes, and the receiver analyzer retains
  both contexts through the requested test window, even after receiver failure.
  No keys, control payloads or per-frame logs are collected.

## Verification

Oto library suite: 103 passed, 6 existing manual/performance tests ignored.
Clippy for all Oto targets passes with warnings denied. Regressions cover an epoch
reset during Speaking, an epoch reset queued ahead of an in-flight frame, resumed
source delivery for callback and owned-channel inputs, replacement during rekey,
responsive Stop, and rekey during the terminal silence drain. The gateway test
also verifies opcode 24 and old/new readiness in the lifecycle event.

The integrated Crust workspace passes 160 tests (4 existing ignored); Clippy
passes for all workspace targets. Crust 4a05a7d pins Oto 352fa9a and logs the new
safe lifecycle events. Mantle is unchanged.

Four sequential release benchmarks used an A-B-B-A order, a one-second warmup
and ten-second measurement with the owned-channel, DAVE and loopback UDP path.
Every run produced/received 501 frames (measurement-boundary timing) with zero
allocations and reallocations. Before maximum lateness was 2.037/1.678 ms; after
was 1.957/1.904 ms. This does not show a consistent latency improvement or a
meaningful pacing regression. It confirms retained allocation-free steady-state
sending; it does not measure process memory savings. Candidate-only recovery tests
also passed in the exact release benchmark binary. Binary hashes and raw counters
are in benchmarks.json; no parallel builds ran during these measurements.

Raydio passes all 49 tests and all-target Clippy. The release was deployed to Oracle as Testbot PID 10564, using the existing
isolated service; production Raydio remains inactive/disabled. Package checksums,
exact running-binary hash and `--check` passed. Build revision 20f1cec has an
18,625,168-byte binary (+5,920 bytes versus the prior release) and a 7,570,715-byte
archive (+2,628 bytes). No runtime helper, codec setting or dependency was added.

## Five-minute live receiver result

Completed 12:13:10.171–12:18:10.223 UTC on September 10. Receiver coverage
299.999631 s; decoded PCM 300.010667 s. All 300 polls, PCM reports and event
history are complete, with no peer replacement, disconnect, checkpoint error or
incident-window overwrite. Checkpoint serialization peaked at 3.5 ms. Playback
controls were untouched during observation. No builds or benchmarks ran during
the measurement. Production Raydio remained stopped; Testbot PID 10564 did not
restart. The checked apt, firmware-refresh and man-db maintenance units logged
no activity in the observation window. These checks cannot exclude every external
network or host disturbance.

- 14,956 received packets, 30 net/positive lost packets, zero discarded packets,
  and 28 NACKs. Total concealment was 950.354 ms, including 442.542 ms silent
  concealment. Concealment is reconstructed audio, not necessarily silence.
- No full-scale clipping or nonfinite samples; PCM peak 0.573168.
- Two natural loop handoffs took 1.885 and 1.461 ms in sender event timestamps.
  Both had 976.25 ms receiver quiet, consistent with the prior 938.458 ms source
  tail plus the documented 100 ms tolerance. Four quiet fragments near these
  two boundaries remain preserved as source-tail candidates, not proven causes.
  The reference came from the previous build; this patch changes DAVE ownership
  and scheduling, not source decoding or volume. It is not fresh waveform proof.
- One actual off-boundary quiet interval lasted **441.771 ms**, ending at
  **12:15:22.216646 UTC**, about 85.6 s after a loop restart. It coincided with a
  speaking-indicator interruption and a one-second receiver sample containing
  20 received / 30 lost packets and 605.667 ms concealment. It is not song-ending
  silence, and the uninterrupted-audio acceptance criterion did not pass.
- PSS over five in-window host samples: **15.798–16.045 MiB**, median
  **16.045 MiB**; bot CPU **3.558% of one core**, host steal **0.200%**.
  Prior long-run median was 16.321 MiB, but different durations and conditions
  prevent attributing this small difference to the patch. No memory-saving claim.

## What the remaining incident tells us

The 12:14:23.495–12:15:23.495 sender checkpoint interval brackets the incident.
It contains exactly 3,000 sent frames and no new skipped deadlines, unavailable
frames, source overruns, send failures or active send gaps above 40 ms. No DAVE
transition, terminal failure, track transition or session cleanup occurred during
the entire receiver test. Sender UDP errors and memory-pressure events remained
zero; the local receiver's interface drop count and UDP error counters also did
not increase across the incident. Polling stayed around one second and no recorded
browser long task overlaps the interruption. Minute host samples cannot rule out
short native-thread or network disturbances.

This supports a packet-delivery interruption downstream of successful bot sends,
not the previously reproduced DAVE terminal failure or source EOF bug. It does
**not** identify whether packets were lost between Oracle and Discord, inside
Discord, on the receiver path (including Starlink), or inside unobserved receiver
processing. Successful UDP sends do not prove delivery. Do not change the codec,
add arbitrary buffering, or blame a particular host based on this single receiver.

There were also five additional sender gaps above 40 ms and eight missed deadlines
in the interior 240 s checkpoint span; none reached 100 ms, and all occurred before
12:14:23, separately from the 12:15:22 packet-loss incident. Early receiver
concealment is compatible with these scheduling disturbances, but minute
checkpoints cannot establish a one-to-one cause. The sender span omits 13.325 s
at the head and 46.675 s at the tail; those limits are explicit in summary.json.

Next targeted diagnostic: simultaneous independent receivers on different network
paths, plus bounded packet-header timing/sequence observation on the Oracle voice
socket. Compare matched incidents before selecting a transport fix. Avoid payload
capture, flooding, per-packet application logging, and changing controls during a
measurement. This would distinguish shared upstream loss from a receiver-specific
outage; a single receiver and aggregate counters cannot do that conclusively.

The DAVE race fix is committed, deployed and validated by deterministic debug and
release recovery regressions. This live smoke check demonstrates continued
playback across two loops, but no live rekey occurred, so it does not independently
exercise that rare recovery path. No new six-hour test was started. Testbot stays
playing on Oracle; production stays off. Temporary collectors and sleep inhibitor
were stopped after saving the evidence in live/raw-evidence.tar.gz.
