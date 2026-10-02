# Sub-five-second startup investigation

The preceding deployed build `5f23955` took 6.947476 seconds from command receipt
to processing TrackStartEvent for `4moWSMi1L_4`, with 5.637977 seconds in media
opening. The user's target is below five seconds without degradation. Retain the
same selected format, complete bounded staging before playback, and existing
voice/DSP/pacing settings. TrackStart is a sender lifecycle measurement, not an
exact first-audible-frame timestamp at the listener.

## Transport experiments

Bounded same-source Oracle probes fetched itag 251, 142,217 bit/s, 4,167,934 bytes
through the existing home SOCKS egress. Header, range-query and POST variations
all returned identical SHA-256
`a31c27999d21b6402368699057c277597e906ca88e4ab68ab3cf6322df685097`.
Initial controls took 4.191/4.141 seconds versus 3.499 seconds for query and
3.497 seconds for POST. Repetition varied from 2.733 to 4.875 seconds, with one
redirect/two connections each. The alternatives lacked a stable advantage;
neither request semantics nor signed URLs are changed.

A Rust source-only harness using Mantle's actual downloader measured response
setup at 0.620–0.832 seconds and full staging at 3.270–6.151 seconds. Thus the
dominant residual wait is transport, not decoding or voice setup. These were
bounded diagnostics, not Discord receiver tests; no probes run during the final
live comparison.

## Verified connection-reuse bug and fix

ureq finalizes a length-delimited response on the read after its last payload.
HttpRangeInput previously dropped the reader at the last byte, closing that
socket instead of returning it to the pool. A keep-alive regression failed
before the correction: three staged objects still opened three connections
with a shared agent. The fixed reader explicitly observes EOF locally. Media
openers also reuse the source manager's existing pool when their transport
policies match. Routed clients and custom policy retain independent agents.

The controlled three-object, 4 MiB/object, 20 ms/connect fixture measured:

| Transport | Connections | Total open/read time |
| --- | ---: | ---: |
| Separate clients | 3 | 152.927 ms |
| Shared pool, completed bodies | 1 | 108.237 ms |

This is 66.7% fewer connections and 29.2% lower fixture time. It does not predict
cold-start improvement when no reusable connection exists. Complete staging,
exact range/length/identity validation, bounds, cancellation, and replay remain.
No bitrate, encoder, gain, packet pacing or read-ahead setting changes.

## Oracle source-only preservation check

An interleaved actual Mantle source harness discovered, completely staged, and
drained the same video five times. It ran without Discord transmission; a
new manager represented an independent pool, while one shared manager served
the three pooled cases.

| Case | Discovery | Media open | Output frames |
| --- | ---: | ---: | ---: |
| Separate 1 | 171.922 ms | 4683.874 ms | 12,460 |
| Shared first | 173.301 ms | 3742.077 ms | 12,460 |
| Shared second | 113.825 ms | 3219.094 ms | 12,460 |
| Separate 2 | 129.569 ms | 4184.836 ms | 12,460 |
| Shared third | 123.428 ms | 3489.625 ms | 12,460 |

Every output used OpusPassthrough and had the same packet MD5
`de9da549be67cb676d8c5f6eb5c8d9ba`. This confirms exact packet preservation in
these samples; it does not measure volume processing or live packet loss.
Shared second response setup was 352.456 ms versus separate controls
822.143/907.599 ms. Shared first had no existing media socket and must not be
treated as causal pooling evidence. Network/CDN caches and routing were not
controlled. Test scripts kept credentials and signed URLs internal and emitted
only bounded safe timing/status/digest fields.

## Validation and remaining qualification

Mantle's full media suite and all-target Clippy with warnings denied pass, with
existing live/process/environment exclusions unchanged. Regressions cover
transport-policy mismatch, routed pooling exclusion, cancellation, exact bytes,
incomplete-body recovery, stale metadata, changed identity, and real Opus/AAC
replay. The deployed fresh-command and receiver results are reported separately
below. Neither source-only transport checks nor a short live observation
establish six-hour reliability.

Published dependency pins: Mantle
`775d64f85912bfcf96814ff404144300f34cb635`, Crust
`7876fd86f744865882b802d5cf203a70488992e5`. Crust's 32 adapter tests and
all-target Clippy pass (two existing manual benchmarks excluded). Raydio's
54 library tests, main test, backend/reconnect integrations, all-target Clippy
and formatting pass. The lock diff preserves all registry packages/dependencies
and Oto's `62d2fc87e5dc239695a8b86a7372a4edc1caa933` correction.

The bounded release build and backend self-check pass. The controlled browser
is signed in to test → General, muted and undeafened. The existing receiver
observer is installed before voice creation; its peer reports Connected. A
one-hour, 96 MiB/10% CPU bounded loopback collector saved the five-minute audit
independently of agent turns. Browser-to-collector health returned HTTP 200;
full persistence was verified against the actual advancing report.

## Deployment

Raydio release `bc6131dabfe01ce30554f7013d9d3eeffb40f326` was published,
packaged and activated on the existing Oracle VM at 21:38:52 UTC. Package and
remote backend self-checks passed; the deployed binary SHA-256 matches the tested
build: `465d47a048805aadbcfc357fc7ce59ced51a3e495b64ecf056ea74dd22ccae88`.
The service reports Connected to Discord, active, zero automatic restarts.
The previous release remains available for rollback. No download probes,
compilers, restart or playback controls ran during the live observation.

## Fresh live startup

The user submitted the same Akcent URL and enabled Loop, then reported that it
was “way better now”. Interaction `1555695742469935267` was received at
21:39:28.579699 UTC. Metadata resolution took 153 ms, acknowledgement 403 ms,
and DAVE was ready at 21:39:29.796658 UTC.

| Measurement | Previous `5f23955` | Pooled `bc6131d` |
| --- | ---: | ---: |
| Command receipt → processing TrackStartEvent | 6.947476 s | 5.184758 s |
| Source discovery | 133.638 ms | 113.050 ms |
| Media response/opening and staging | 5637.977 ms | 3530.333 ms |
| Total source preparation | 5771.615 ms | 3643.383 ms |
| Failed media handoffs | 0 | 0 |

The comparable logged startup improved **25.37%**. All 4,167,934 media bytes
were staged at 21:39:33.427679 UTC, **4.848 seconds after command receipt**.
Response setup took 894.214 ms and staging 2635.681 ms. The player-message
response completed at 21:39:33.764364 UTC, immediately before the session
processed its queued TrackStart event. That remaining ~336 ms includes Discord
HTTP response work; changing only when this event is logged would not prove
faster audio. No first-send trace or first-audible-frame timestamp was captured.
Consequently **first audible playback below five seconds is not established**.

These are uncontrolled live samples, not a latency guarantee or isolated causal
estimate. The first media request after activation has no pooled media socket;
CDN/cache/network variation can contribute to its improvement. Controlled
keep-alive regressions establish the connection-reuse fix independently.

## Five-minute receiver check

The measured interval was 21:40:20.851–21:45:20.925 UTC, after playback had
started. It contains 299.999 seconds of receiver counters and 300.011 seconds
of PCM aggregates. Poll, PCM, event, track-phase and speaking-indicator coverage
are complete; the connection remained uninterrupted. Persistence was verified
while the report advanced, and the final report was saved successfully.

| Receiver measurement | Result |
| --- | ---: |
| Received packets | 14,975 |
| Net packet loss | 0 |
| Positive loss / subsequent negative corrections | 3 / −3 |
| Discarded packets / NACKs | 7 / 17 |
| Concealed audio | 1177.833 ms (0.393% of observation) |
| Silent concealed audio | 41.042 ms |
| PCM empty frames / nonfinite samples / clipping-threshold hits | 0 / 0 / 0 |
| Receiver long tasks / stale polls / missing PCM reports | 0 / 0 / 0 |
| Maximum sampled jitter | 9 ms |

Zero net loss does **not** imply every packet met its playout deadline. Retain
concealment, discards and transient loss in the assessment. The receiver had one
37.938 ms quiet interval in the middle of the track, overlapping concealment;
no off-boundary quiet interval reached 100 ms. A single receiver and this short
window cannot isolate a network hop or establish six-hour reliability. There is
no matched prior receiver window for a causal audio-quality comparison.

The longest quiet interval, **2258.063 ms**, ends at the natural Loop transition.
After the receiver test completed, an independent decode fetched the same
source bytes: its SHA-256 matches the predeployment source digest. At the same
1e−5 stereo quiet threshold and volume 0.7, the source has **1931.792 ms of quiet
tail and 265.188 ms of quiet head**, totaling **2196.979 ms**. The receiver differs
by 61.083 ms, within the classifier's 100 ms tolerance. Finish/start processing
was 1.409 ms apart. This is a source-tail candidate with no overlapping receiver
anomaly, rather than an unexplained 2.26-second interruption; it remains in the
raw measurements. Source/receiver waveform alignment is not claimed.

Sender checkpoints within the interval span 21:40:30.085–21:44:30.085 UTC,
leaving 9.234 seconds at the head and 50.765 at the tail uncovered by interior
counter subtraction. They record zero unavailable/silence frames, source
overruns, send failures or DAVE failure; nine gaps exceed 40 ms, none exceed
100 ms, and 13 deadlines were skipped. The next checkpoint, **9.161 seconds
after receiver coverage ended**, has 11 cumulative gaps over 40 ms, 17 skipped
deadlines and a maximum gap of 61.277 ms, with the same zero-failure counters.
Do not present that later checkpoint as an exact receiver-window delta.

Receiver-host snapshots and checkpoint archives cover the observation, with no
archive gaps or sampler errors. Sender-host resources were **not** sampled
during it; the summary explicitly warns about missing sender-host coverage.
A single post-observation sample at 21:49:47 UTC has PSS **16,739 KiB
(16.35 MiB)** and RSS **19,328 KiB**. This is not a memory improvement or leak
measurement. No bitrate, codec, DSP, pacing, worker or staging policy changed.

Evidence is in [pool-receiver/summary.json](playback-startup-20261002/pool-receiver/summary.json),
its raw report/archives, allowlisted credential-free `service.log`, and
`source-reference.json`. Startup history is in
[comparison.json](playback-startup-20261002/comparison.json).
The temporary browser checkpoint timer and local collector were stopped after
the completed report persisted. Normal Raydio and home-egress services remain
running; Testbot remains inactive. Retain this deployment: startup is shorter,
exact source packets are preserved in source-only tests, and the short live
check verifies playback/Loop without a terminal failure. It does not prove
artifact-free transmission or a guaranteed sub-five-second first audible frame.
