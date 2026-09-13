# Net packet loss follow-up — 2026-09-12

## What the six-hour result says

The latest qualified Oracle observation received 1,079,253 packets and ended
with 198 net lost packets (0.01834%). It recorded 319 positive loss deltas and
121 packets of negative correction. The largest positive bursts were 118, 54,
32, and 24 packets. They occurred while the browser reported one connected
receiver and while Raydio's sender checkpoints continued advancing. Raydio had
zero UDP send failures, source overruns, Linux UDP buffer errors, checksum
errors, OOM events, and maintenance interruptions. This makes a local sender
drop or socket exhaustion unlikely. The counter is a receiver/WebRTC metric;
Discord's media UDP path provides no retransmission API that Raydio can use to
repair a packet after a successful send.

The loss bursts are not natural loop boundaries. Their track phase was
`middle`, and the largest bursts had hundreds of milliseconds of concealment.
Two independent ICE/connection transitions recovered in about 34 ms and 38 ms,
but they did not coincide exactly with the largest bursts. A single receiver
cannot identify whether a remaining loss occurred on Oracle's egress, the
Discord voice route, or the listener's access path.

## Sender and transport review

Oto uses one connected UDP socket, absolute 20 ms pacing, bounded retries for
local send errors, and constructs one RTP sequence/timestamp per encrypted packet. Local send
retries reuse that encrypted packet without advancing its RTP header again. Blind duplication of successful sends is not enabled. A redundant packet can
help some loss patterns, but receivers must deduplicate it; support on Discord
and its effect on jitter and bandwidth have not been demonstrated here. Increasing socket
buffers is unsupported by the evidence because Oracle reported no buffer
errors. Opus's 5% packet-loss hint can reduce decoded error but cannot lower
`packetsLost`; forced in-band FEC changed music to a lower-quality hybrid mode
and was rejected by the earlier benchmark.

## Tested mitigation

Oto now has an opt-in Linux DSCP marking path, controlled by
`RAYDIO_AUDIO_DSCP=0..63`. It performs one best-effort socket option call at
transport creation; audio framing, codec, pacing, and packet contents are
unchanged. The default is disabled, so existing deployments are behaviorally
unchanged. Crust's adapter was also advanced to the same Oto revision; this
keeps the dependency used by the actual bot consistent with Raydio's direct
Oto pin.

On the same Oracle instance, source URL, volume 70, loop state, and signed-in
receiver, two quiet five-minute windows were collected:

| Window | Net lost | Received | Discarded | NACKs | Concealed samples | Coverage |
|---|---:|---:|---:|---:|---:|---|
| DSCP 0 (existing behavior) | 0 | 14,977 | 2 | 7 | 20,312 | complete; uninterrupted |
| DSCP 46 | 0 | 15,000 | 1 | 3 | 1,578 | complete; uninterrupted |

The DSCP 46 packets were verified on Oracle with `tcpdump` as IP TOS `0xb8`.
Oracle showed zero UDP drops and errors in both windows. The result is a
promising concealment screen, not proof of lower rare loss: both windows had
zero net lost packets and five minutes cannot sample the six-hour burst rate.
Route conditions and jitter-buffer state can explain the concealment difference.

A second five-minute DSCP-0 control was then run with a fresh player and the
same procedure. It received 14,999 packets, net lost 0, discarded 0, NACK 15,
and 3,652 concealed samples (76.08 ms). This shows that the 20,312-sample
first-control value and the 1,578-sample DSCP-46 value are within-run network
variation, not a controlled proof that DSCP reduces concealment. The second
control had complete poll/PCM/event coverage and no connection transition.

The first DSCP-46 run's receiver report itself had complete coverage, but its
separate Oracle resource collector was started late. It is retained for receiver
quality analysis and marked as a setup limitation; it is not used as a strict
host-correlation result. The second DSCP-0 control had its independent resource
collector started before playback.

## Decision

Keep the DSCP implementation available for a controlled longer experiment but
leave it disabled in the candidate service. Do not claim that it fixes raw
receiver loss or enable it in production from this screen alone. The safe
production baseline remains the existing pacing and codec settings with the
diagnostics enabled. A future A/B should alternate DSCP 0 and 46 over multiple
hours on the same receiver, preserve route/RTT and ICE events, and accept a
candidate only if net-loss rate and concealment both improve without increased
sender gaps, silent concealment, or PCM errors.

The actual bot dependency graph was also corrected: Crust's Oto adapter and
server test fixtures now pin the same Oto transport revision as Raydio. This
prevents the binary from silently linking an older transport through the
adapter. The final build uses Oto `e205f9a3` and Crust `5479267a`; the transport
test covers both IPv4 and IPv6 marking and verifies unchanged packet bytes.
Crust tests (16 passed) and the full Raydio suite (49 passed) passed with the
aligned revisions. The live DSCP windows necessarily used the earlier trial
build (`0673097`/`6be8a10`); the final build was installed and checked on
Oracle but was not restarted for another receiver window.

Evidence is under `target/net-loss-20260912/`: `baseline/` is DSCP 0,
`dscp-collector-2/` is DSCP 46, and `manifest.json` records source and binary
identity. The six-hour source is under
`evidence/final-six-hour-20260912/`.


## Measurement follow-up — 2026-09-13 UTC

Review found two diagnostic shortcomings. Small positive loss/discard events
were logged but did not trigger surrounding incident samples unless concealment
also exceeded 40 ms. They now trigger the same bounded six-sample history and
five-sample follow-up, including subsequent signed loss corrections. This adds
no polling frequency and does not change the bot or receiver buffering.

The strict comparison previously rejected fully observed transient connection
interruptions, selecting smoother trials. It now reports those interruptions
as outcomes while still requiring complete polling, PCM, persisted event
history, and all three diagnostic collectors. Missing collector metadata no
longer bypasses qualification. An accepted measurement is not an audio-quality
pass. Failed/preflight-only reports remain excluded and preserved separately.

Of the six-hour run's 319 positive loss deltas, 228 (71.47%) came from four
polls; 36 of 360 minute bins contained positive deltas. At the 4,034-second
incident, inbound packets fell from approximately 50/s to 4, 0, and 28 before
recovering, while the 118-packet loss increment appeared at the end of that
stall. This shows that a loss counter's timestamp can lag the actual outage.
At the 14,796-second incident, +54 was followed by -38 and -3 corrections;
these are not evidence that already-concealed audio was repaired for playout.
Use the full surrounding window when attributing an incident, not only the
poll where `packetsLost` increased. These observations do not identify the
faulty hop or prove all successful local UDP sends reached Discord.


### Techniques considered against the evidence

- **QoS/DSCP:** a best-effort egress hint, preserving audio and packet rate.
  It cannot prioritize the separate Discord-to-listener connection. Many
  networks rewrite or ignore it, so packet marking alone is not efficacy.
- **Larger UDP buffers:** no sender `SndbufErrors`, interface drops, or
  checksum errors were recorded. A larger queue cannot repair downstream
  packet loss and can extend stale-audio delay if it fills.
- **Opus FEC:** RFC 7587 §3.3 requires the subsequent packet and receiver
  integration. It addresses missing audio, not the raw reception counter.
  The previous forced-FEC music test selected hybrid mode and was rejected
  for quality. It is not a recovery mechanism for multi-second outages.
- **RTP retransmission or redundancy:** the receiving browser's NACK counter
  does not show that Oto received feedback. No working feedback/retransmission
  path for this Discord bot transport has been established. Adding blind
  duplicates or unnegotiated RED payloads is not a supported production fix.
- **Larger jitter buffer:** can tolerate lateness at the cost of playout and
  control latency; it cannot recover permanent loss. The listener's Discord
  client owns that buffer. Changing the measurement browser alone would
  change the receiver under test and would not improve other listeners.
- **Packet duration/bitrate:** shorter frames increase packet rate and work;
  the previous 10 ms pacing candidate regressed. Longer frames increase loss
  sensitivity and latency (RFC 7587 §5). Lower bitrate has a quality tradeoff
  and needs actual congestion/MTU evidence, which this run did not establish.

Standards consulted: [RTP loss reporting, RFC 3550 §6.4.1](https://www.rfc-editor.org/rfc/rfc3550#section-6.4.1),
[Opus FEC, RFC 7587 §3.3](https://www.rfc-editor.org/rfc/rfc7587#section-3.3),
and [Opus congestion tradeoffs, RFC 7587 §5](https://www.rfc-editor.org/rfc/rfc7587#section-5).
A cumulative loss correction does not undo already concealed playback; the
standards also distinguish late/duplicate reception from audio playout.

### Completed 15-minute comparison

The final installed binary (SHA-256
`436db3478beed4c8d7a22daba18a5cd1b4ea620bbce69227f444a8c4cee6fe57`)
was used for both windows. DSCP 0 ran from 00:34:39 to 00:49:39 UTC;
DSCP 46 ran from 00:54:34 to 01:09:34 UTC on September 13. Both used the
same connected browser peer, source URL, volume 70, Loop on, and Opus
48 kHz stereo. Outgoing DSCP-46 datagrams were verified as TOS `0xb8`
before its measured window. There was no packet capture, SSH administration,
build, or control interaction during either measured window.

| Metric | DSCP 0 | DSCP 46 |
|---|---:|---:|
| Receiver observation | 900 s | 900 s |
| Received packets | 44,989 | 44,991 |
| Net lost packets | 0 | 1 |
| Positive loss deltas / signed corrections | 1 / −1 | 4 / −3 |
| Discarded packets | 15 | 20 |
| NACKs | 44 | 64 |
| Concealment | 668.73 ms | 971.88 ms |
| Concealment per minute | 44.58 ms | 64.79 ms |
| Silent concealment | 17.50 ms | 0 ms |
| Sender gaps ≥40 ms, interior 840 s | 5 | 4 |
| Sender gaps ≥100 ms / send failures / source overruns | 0 / 0 / 0 | 0 / 0 / 0 |
| Bot PSS median | 16.113 MiB | 16.310 MiB |
| Bot CPU, one core | 3.803% | 3.906% |
| Host CPU steal | 0.271% | 0.279% |
| PCM clipping / non-finite / empty frames | 0 / 0 / 0 | 0 / 0 / 0 |

Both observations completed with full poll, PCM, speaking UI, track-phase,
persisted event, and independent collector coverage. Neither had a connection
transition, a UDP buffer/checksum error, or a sender termination. The minute
samplers report their endpoint slack explicitly; sender deltas cover the
interior 840 seconds, not all 900 seconds. No kernel warning or maintenance
service activity was recorded during the qualified windows.

Concealment was 45.3% higher with DSCP 46, discards 33.3% higher, and NACKs
45.5% higher. Silent concealment and short sender gaps were lower. The overall
result does **not** support enabling DSCP. It also does not establish that
DSCP caused the worse observations: one sequential pair cannot control route
variation or the receiver jitter-buffer history. Bot process age and starting
track phase differed (about 64 vs 84 seconds into the track). The same binary
and unchanged audio configuration exclude a different encoder implementation,
but not those environmental effects. No raw-loss reduction is demonstrated.

Natural boundaries remain visible. The DSCP-0 report retained two quiet
intervals ≥100 ms for review: 988.75 ms with a receiver anomaly and 1,051.25 ms
at a boundary. The latter exceeds the historical 938.458 ms source tail plus
100 ms tolerance by 12.792 ms. Neither was silently classified as a clean
source tail. DSCP 46 had no ≥100 ms interval requiring review. The source
reference was reused from September 10; this is not fresh waveform alignment.

Setup attempts are retained separately and excluded from the comparison:
the first DSCP-0 audit lacked its Oracle collector at the beginning; it was
stopped and restarted after collector verification. The first DSCP-46
preflight ran before a fresh play command and correctly failed with no
advancing receiver. The subsequent completed reports have distinct identities.
Early failed collector launches also did not count as observations. Raw final
reports are restored from their immutable, SHA-256-named collector archives;
source-reference annotations live outside the raw receiver payload.

The deployment decision remains unchanged: DSCP is opt-in and disabled by
default. Both temporary Testbot services and their collectors were stopped
after preservation; production `raydio.service` remains inactive and disabled,
as it was before this task. The verified candidate remains installed. No
six-hour qualification or production promotion is claimed by these windows.

Evidence: `evidence/net-loss-matched-20260913/`, including both reports,
archives, sender journals, host samples, comparison, manifest and hashes.
Validation: 49 Raydio Rust tests, 27 Python diagnostic tests, and the three
Bun receiver/persistence/PCM harnesses passed. Oto/Crust/Mantle runtime code
was not changed during this follow-up.
