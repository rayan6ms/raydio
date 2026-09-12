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
local send errors, and advances RTP sequence/timestamp only after a successful
send. Retrying a successful datagram or duplicating an RTP sequence would be
incorrect: duplicates are discarded and can worsen jitter. Increasing socket
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

## Decision

Keep the DSCP implementation available for a controlled longer experiment but
leave it disabled in the candidate service. Do not claim that it fixes raw
receiver loss or enable it in production from this screen alone. The safe
production baseline remains the existing pacing and codec settings with the
diagnostics enabled. A future A/B should alternate DSCP 0 and 46 over multiple
hours on the same receiver, preserve route/RTT and ICE events, and accept a
candidate only if net-loss rate and concealment both improve without increased
sender gaps, silent concealment, or PCM errors.

Evidence is under `target/net-loss-20260912/`: `baseline/` is DSCP 0,
`dscp-collector-2/` is DSCP 46, and `manifest.json` records source and binary
identity. The six-hour source is under
`evidence/final-six-hour-20260912/`.
