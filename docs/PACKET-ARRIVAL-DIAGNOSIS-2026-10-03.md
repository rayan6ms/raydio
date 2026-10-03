# Paired RTP arrival diagnosis

## Result

The two-minute paired capture localized the recorded concealment incident to
additional delay **after Oracle's sender capture and before this computer's
kernel arrival**. It does not identify whether Discord's forwarding or an
intervening network hop introduced that delay. No audio change was deployed,
and the lower concealment result is not claimed as a bot optimization.

Raydio remained PID 34605, release
`80f4ec627181171d224d5d3389cd2a86c553c578`, on the existing free Oracle instance.
Playback: `test` → General, Akcent “Stay With Me” (`4moWSMi1L_4`), volume 70,
Loop ON. Commands and Loop were operated through the controlled browser.

## Capture correction

The initial receiver capture produced zero records. The diagnostic incorrectly
assumed both ends used Opus RTP payload type 120. Oracle sends type 120, while
Discord forwards this browser connection as type 111. A three-packet spot check,
limited to Ethernet/IP/UDP/fixed RTP headers, confirmed type 111 and the same SSRC.

`rtp_header_capture.py` now accepts a negotiated `--payload-type` and applies it
in both BPF and parsing. A regression test verifies type 111 acceptance and
rejection when configured for type 120. The initial empty capture and its receiver
report are preserved as an invalid paired experiment, not silently replaced.
The receiver counter report itself was valid: 184.4375 ms concealment in two
minutes, zero discards/net loss. It cannot attribute packet arrival timing.

## Valid repeat

Receiver observation: **2026-10-03 11:26:52.091–11:28:52.091 UTC**
(08:26:52–08:28:52 São Paulo). Both captures started before and ended after the
120-second receiver window. No builds, restarts, source probes, ping probes,
playback controls or exports ran during that window. Packet capture is diagnostic
instrumentation, so this is not an uninstrumented endurance qualification.

| Measurement | Oracle sender | Local kernel arrival |
| --- | ---: | ---: |
| Packets in receiver interval | 6,000 | 6,000 |
| Maximum inter-packet gap | 29.854 ms | 63.150 ms |
| Gaps >=40 ms | 0 | 27 |
| Gaps >=100 ms | 0 | 0 |
| Capture kernel drops | 0 | 0 |

All 6,000 packets received in the interval matched captured sender packets by
SSRC, RTP sequence and timestamp. No unmatched receiver packet was present.
Matching does not require the RTP payload type to remain identical through
Discord forwarding.

Matched packet transit variation, relative to the minimum observed delay:
median **3.301 ms**, maximum **76.555 ms**. Absolute one-way delay is not claimed:
the clocks' offset contaminates absolute subtraction. The relative measure also
assumes no material clock drift during this short window.

Receiver counters: **19.0625 ms concealment**, zero silent concealment, one
discard, zero net packet loss, seven NACKs. Full counter and PCM coverage,
uninterrupted connection, no clipping, invalid samples or empty audio frames.
Concealment was much lower than the initial window, but the same unchanged
production code ran in both; natural variability remains substantial.

The only recorded concealment/discard poll ended at **11:28:12.188 UTC**:

- Concealment: 19.0625 ms; one discard; zero net lost packets.
- Maximum nearby sender gap: **20.822 ms**.
- Maximum nearby local arrival gap: **56.613 ms**.

The comparison includes the poll's actual interval and 250 ms tolerance at each
edge. This is strong evidence of downstream timing variation for that incident,
not proof of one particular hop or of every historical concealment's cause.
Late packets can all arrive eventually while still missing their playout deadline.
This is why net zero packet loss does not imply zero concealment or discards.

## Operational recovery and safety

The controlled browser initially timed out; opening a new attached tab recovered
it without restarting T3 Code. The user signed in. The capture observer was
installed before rejoining General so the current WebRTC peer was tracked.

Oracle remained running. SSH was blocked after the home public IP changed;
the existing security list was updated using its ETag, preserving prior rules
and adding only the current administrator IPv4 /32 for TCP destination port 22.
No instance, shape, subscription or paid resource was created.

Capture snaplen was 54 bytes: Ethernet, fixed IPv4, UDP and the 12-byte RTP header.
Only parsed timing/header metadata was written; no audio payload pcap was saved.
Each capture was limited to 150 seconds and 10,000 packets, within 64 MiB/eight
tasks on Oracle. Captures ended, and the temporary privileged local shell exited.
No privileges or executable capabilities were permanently granted.

## Receiver buffer experiment

On the same uninterrupted playback and receiver identity, the browser ran
default → 120 ms → default, with five seconds of warm-up excluded before each
120-second observation. Production code and playback controls were unchanged.
The original `jitterBufferTarget=null` setting was restored automatically and
verified after completion. The bounded collector was then stopped.

| Measurement | Default (first) | Target 120 ms | Default (reversal) |
| --- | ---: | ---: | ---: |
| Concealment | 50.042 ms | 0 ms | 101.292 ms |
| Mean measured buffer delay | 66.987 ms | 103.166 ms | 52.543 ms |
| Mean target buffer delay | 58.959 ms | 120.000 ms | 40.000 ms |
| Received packets | 6,000 | 6,000 | 6,000 |
| Discarded packets | 0 | 0 | 0 |
| Net lost packets | 0 | 0 | 0 |
| Complete poll coverage | No | Yes | Yes |

Mean buffer delay is cumulative `jitterBufferDelay` divided by cumulative
`jitterBufferEmittedCount`, converted to milliseconds; it is not total end-to-end
latency. The target window cost about 36–51 ms more mean buffering than the
controls. Its loss counter briefly increased by one and later decreased by one;
net zero does not hide that transient event.

All windows completed, retained the same SSRC/track, had full PCM/event coverage,
and had no disconnect, clipping, nonfinite samples or empty frames. The first
control had one stale stats poll and therefore **fails strict poll coverage**.
Its terminal cumulative totals remain useful exploratory evidence, but this
three-window sequence cannot qualify as a fully valid controlled comparison.
The target and reversal both passed strict coverage. A single short sequence
also cannot establish repeatability or exclude changing network conditions.

The target window contained 2.258 seconds of quiet near track positions 246–248
of 249 seconds, adjacent to a recorded loop restart. This is track-boundary quiet,
not concealed audio: concealment and silent-concealment counters stayed zero.
It is retained separately, not described as a transmission outage. The other
windows' longest quiet was 10 ms.

These observations support sensitivity to receiver playout buffering. They do
**not** prove a general bot optimization: Discord clients choose their own buffer,
and Raydio cannot enforce this browser setting for other listeners. No bot audio
change was deployed on this basis, and the experimental setting was not left on
to make later production measurements appear better.

Full reports, host samples and computed comparison:
[buffer-trial](packet-arrival-diagnosis-20261003/buffer-trial/).

## What this supports next

The sender's healthy timing in this incident does not justify another encoder,
buffering or worker change as its fix. The next useful remedy experiment concerns
the delivery/receiver path. The buffer experiment above found a useful signal,
with an explicit latency cost, but needs replication before a stronger claim. A browser-only
setting would apply to that listener, not fix Discord clients for every bot user;
it must not be promoted as a general bot-side solution. Isolating Discord forwarding
from the home access path still requires an independent path or equivalent evidence.

Other incidents already documented correlated with Oracle scheduling stalls;
this short clean sender window does not invalidate those findings.

`correlate_rtp_headers.py` retains capture validity, matching coverage, missing
packets, sender/arrival gaps and each receiver incident. Empty, truncated or
kernel-dropped captures cannot qualify. Regression tests cover negotiated payload
types, clock reversal, constant clock offset, missing identity matches and invalid
captures, and partial header exports. All 52 Python diagnostic tests passed using
`env -u PYTHONEXECUTABLE -u __PYVENV_LAUNCHER__ /usr/bin/python3 -m unittest discover -s benchmarks -p 'test_*.py'`.
The inherited app launcher environment makes an uncleaned Python test invocation
misidentify `sys.executable`, so its subprocess tests fail before executing Python;
this was corrected in the verification command, without restarting T3 Code.

Evidence: [packet-arrival-diagnosis-20261003](packet-arrival-diagnosis-20261003/),
including the invalid initial capture and complete terminal receiver reports.
