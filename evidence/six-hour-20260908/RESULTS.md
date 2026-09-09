# Six-hour attempt: not qualified

The receiver failed at 22:35:49 UTC September 8 after 5,645.096 measured seconds
(1h34m05s): `Receiver or voice row was replaced/disconnected`. All 96 checkpoint
saves succeeded, including the final failure. There is no receiver qualification
for the remaining approximately 4.5 hours.

## Three separate findings

1. At about 22:05:43 UTC (64 minutes), PCM recorded one **216.75 ms mid-track
   silence**, with a speaking-off/on interval. One receiver poll had 30 packets;
   the next had 70 and 23 discards. This suggests delayed delivery followed by
   catch-up but does not identify the delay's origin. No browser long task or
   local journal event overlaps that immediate window. Lifetime sender counters
   and minute host samples cannot localize this subsecond failure.
2. At about 22:35:30 UTC packets stopped arriving. The receiver became
   disconnected at 22:35:37 and failed at 22:35:47, retaining a final 17.067-second
   quiet interval. Independent local logs at 22:35:42–53 reported router mapping
   NetworkFailure, UDP blocked and loss of IPv4/IPv6 reachability. Routing changed
   shortly afterward. Receiver-network interference prevents treating this as a
   bot-only failure. The computer did not suspend and PCM/poll reports continued.
3. At **02:58:17 UTC September 9** (23:58:17 Sao Paulo, 5h56m34s after receiver
   start), Oracle logged a **terminal DaveTransition audio failure**. Playback
   stopped while Testbot's process remained alive. This independently prevents a
   six-hour pass, separate from the earlier receiver disconnect.

`DaveTransition` identifies the encryption/transition path, not a specific key
expiry, ratchet bug or timeout. Oto maps both owner-channel and backend encryption
failures to this category; its audio snapshot retains only ErrorKind, which Crust
logs. The underlying categorical cause is not retained and cannot be reconstructed
with certainty. A code inspection is not a reproduction of the live failure.

## Scoped results

| Measurement | Result |
| --- | ---: |
| Receiver duration / completed repeats | 94m05s / 26 |
| Received packets | 281,291 |
| Net loss / positive loss / recovered deltas | 13 / 23 / 10 |
| Discards / NACKs | 77 / 315 |
| Clipping / non-finite / empty PCM frames | 0 / 0 / 0 |
| Stale polls / missing PCM reports | 0 / 0 |
| Concealment, first 93 complete minute bins | 5,970.854 ms |
| Silent concealment, same prefix | 221.958 ms |
| Warm playback PSS | 16,067–16,711 KiB (15.69–16.32 MiB) |
| CPU, one logical core | 3.913% |
| Host steal across sampled playback | 0.295% |
| Memory-limit/OOM events | 0 |
| Sender frames, lifetime | 1,074,019 |
| Sender source overruns / send errors | 0 / 0 |
| Sender unavailable / silence frames, lifetime | 5 / 5 |
| Sender skipped deadlines / max lateness, lifetime | 224 / 61.448 ms |

The prefix is 5,579.968 seconds through minute bin 92. Its concealment rate is
about 64.2 ms/min, similar to the earlier ten-minute Oracle sample's 63.2 ms/min.
Separate times and durations prevent causal improvement claims. Concealment is
not necessarily audible silence. The full failed receiver totals (22.361 seconds
concealment, 16.396 seconds silent concealment) are dominated by the terminal
network outage and remain in the raw report.

Fifty-two quiet events match the repeating source-tail pattern: 26 short quiet
segments, 24 tails at 976.25 ms and two tails at 968.75/969.063 ms, corroborated
by loop timing. Some player phase labels were stale. These events are retained;
the unrelated 216.75 ms interval at position 95 seconds is not excluded.

Browser long tasks: 185, 14.018 seconds cumulative, maximum 109 ms. They remain
a receiver confounder. Median PSS for the first five playback samples was 16,251
KiB and for the last five 16,711 KiB (+460 KiB): neither a memory reduction nor
proof of an unbounded leak. Resource data covers nearly six hours, unlike the
receiver. Sender lifetime includes warm-up and playback after receiver failure.

## Improvements supported by the evidence

1. **DAVE lifecycle diagnosis/recovery first.** Retain a bounded, credential-free
   error category (invalid state, closed owner, timeout, backend rejection, panic)
   and lifecycle phase. Reproduce listener reconnects, epoch resets and queued
   encryption during transitions before choosing recovery behavior. Distinguish
   recoverable lifecycle loss from authentication/cryptographic failures; never
   fall back to plaintext. No specific repair is established by this run.
2. **Localize the 217 ms gap.** Prefer bounded, event-driven sender delay summaries
   over per-packet logs or high-frequency probes that can perturb audio. Current
   lifetime counters cannot determine whether this gap originated at the sender.
3. **Separate receiver reconnections into explicit segments.** Future monitoring
   can continue collecting after a replaced peer, retaining a network-gap marker.
   It must not combine those segments into an uninterrupted six-hour pass. A
   stable independent receiver connection would improve failure isolation.
4. **Keep Oracle and codec quality.** Resources are ample; these observations do
   not justify lower bitrate, a larger source buffer or another host migration.
   Do not promote this candidate to production yet.

## Final state

Testbot PID 3063 is online but idle after the voice failure. Production Raydio
PID 876 remains online on v0.2.1. Neither process restarted. No production
deployment or audio-code change was made during this review.

Oracle evidence, including the automatic 03:15 UTC snapshot, was copied locally.
The temporary resource sampler and local checkpoint/sleep inhibitor were stopped
after collection. Deferred maintenance timers were restored. The existing SSH
administrator rule was refreshed to the observed current public IPv4 /32 after
the old address stopped matching; no broad SSH ingress was added.

See `summary.json`, `receiver.json`, `checkpoints.jsonl`, `oracle/resources.jsonl`,
`oracle/service.log`, `oracle/kernel.log`, `local-network-events.txt` and
`post-audit-status.txt`. The exact DAVE subcause remains a diagnostic limitation.
