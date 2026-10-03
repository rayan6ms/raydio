# Receiver buffer replication and paired arrival follow-up

## Result

The balanced 20-minute replication recorded **162.750 ms concealment and four
discards with default buffering**, versus **zero concealment and zero discards
with a 120 ms receiver target**, over ten measured minutes per setting. Net
packet loss was zero in both groups. Mean measured buffer delay increased from
62.895 to 120.006 ms: **57.111 ms extra buffering**.

This is a measured benefit for this browser listener, not a deployed bot-wide
fix or six-hour qualification. Raydio cannot impose `jitterBufferTarget` on other
Discord clients. The setting was restored to its original `null` value after
each experiment and verified afterward. No codec, bitrate, volume, source,
worker, pacing, production binary or service setting changed.

The paired follow-up strengthened the downstream-delay finding: all six
concealment polls in the final default window had nearby sender gaps below
21 ms and arrival gaps of 49–63 ms. The target window tolerated a 77 ms arrival
gap without concealment. This does not identify which intervening hop caused
the delay or guarantee that the target will handle future larger delays.

## Conditions and controls

- Oracle production PID 34605, build
  `80f4ec627181171d224d5d3389cd2a86c553c578`; executable SHA-256
  `4a169d0149cd4c93881674aa7f72655feaf87e9b629b295f810db7cc248ea351`.
- One existing Always Free instance. Raydio active; Testbot inactive.
- Existing playback in `test` → General: Akcent “Stay With Me”,
  `4moWSMi1L_4`, volume 70, Loop ON. No playback restart or control change.
- Same connected peer, receiver SSRC 9597 and track
  `3af11c66-cbb7-4464-aa97-d6e5de31b9d0` throughout.
- Sequence: default → 120 ms → default → 120 ms, 300 seconds each. Ten seconds
  after each setting change were excluded, followed by observer/PCM priming.
- No packet capture, builds, network/source probes or deployment during these
  four comparison windows. Paired captures were a separate later experiment.
- Local host sampling once per second; Oracle sampling once per two seconds,
  memory traversal at most once per ten seconds. Persist reports between
  windows, with no periodic browser checkpoint timer.
- All four reports passed strict poll, PCM, event, connection, speaking and
  phase coverage. Same receiver identity; no cached/stale polls.

Both machines reported synchronized clocks before/after the experiments.
Short packet comparisons still report relative transit variation, not absolute
one-way latency or guaranteed cross-host clock accuracy.

## Balanced comparison

All start times are UTC on October 3, 2026; São Paulo is three hours earlier.

| Window | Start UTC | Setting | Concealment | Discards | Net loss | Mean buffer |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 0 | 11:54:21.853 | Default | 135.271 ms | 3 | 0 | 72.375 ms |
| 1 | 11:59:34.494 | 120 ms | 0 ms | 0 | 0 | 122.730 ms |
| 2 | 12:04:46.926 | Default | 27.479 ms | 1 | 0 | 53.417 ms |
| 3 | 12:09:59.260 | 120 ms | 0 ms | 0 | 0 | 117.283 ms |

Group concealment rates: default **16.275 ms/minute**, target **0 ms/minute**.
This observed reduction is not a statistical confidence bound: sequential
windows remain subject to changing network conditions and buffer adaptation.

Mean buffer delay is the change in `jitterBufferDelay`, divided by the change
in `jitterBufferEmittedCount`, times 1,000. It is not end-to-end latency and the
requested target is not assumed to equal the measured delay.

All four windows had zero silent concealment, clipping/near-full-scale samples,
nonfinite samples and empty audio frames. PCM quiet intervals of roughly
2.258–2.261 seconds were retained at known song-tail/loop boundaries. These are
classified separately from network concealment; neither zero concealment nor
ordinary song quiet is described as proof of perfect perceptual audio.

The first control recorded eight browser long tasks (857 ms total, maximum
255 ms). The first target recorded one (165 ms); the last two windows recorded
none. None overlapped a concealment poll's interval in the first control. This
is not proof that browser scheduling can never matter. The second control's
concealment occurred without any long task, so long tasks are not a complete
explanation of this result.

Median Oracle PSS was **17,958 KiB (17.54 MiB)** in every window; median bot CPU
was approximately **4.00% of one core**. This experiment changes no bot memory
or CPU policy. Oracle host sampling retained some CPU steal, including a
4.96% peak two-second interval; it is not assumed to explain every receiver
incident.

The saved 38 sender checkpoints cover 11:53:43–12:30:43 UTC, including the
experiments and gaps between them. That wider span contains 20 new sender gaps
≥40 ms and 34 skipped deadlines, with no new ≥100 ms gap, send failure, source
overrun, source-unavailable frame or explicit silence frame. Its minute counters
do not localize each gap exactly. They prevent generalizing the short clean
captures to the entire session. The four-minute interior checkpoint spans of
the comparison's default windows had zero new ≥40 ms sender gap; the first
target window had one and the second had zero. These interior spans are not
complete five-minute packet traces. See `checkpoint-spans.json`.

## Paired captures

One selected IPv4 UDP/RTP stream only; 54-byte snaplen retains fixed headers,
not media payloads. Oracle sends payload type 120, the browser receives 111.
All captures have hard duration, packet, memory and process-count bounds.

The first attempt (index 0) started capture too early relative to observer
startup: its 150-second capture ended before the receiver's full 120-second
window. The receiver report is complete, but **paired correlation is invalid**
because both captures lack trailing coverage. It is retained and excluded from
the qualified comparison. Its 107.646 ms concealment is not erased or promoted
as a fully covered packet diagnosis.

The corrected starts launched local capture, Oracle capture and the already
prepared receiver controller in one orchestration call. Each capture lasted
170 seconds, surrounding a two-minute receiver observation and ten-second
setting warm-up. Captures finished before the next pair began.

| Index | Receiver start UTC | Setting | Concealment | Discards | Sender max gap | Arrival max gap | Arrival gaps ≥40 ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 12:20:54.131 | Default | 0 ms | 0 | 31.649 ms | 55.436 ms | 8 |
| 2 | 12:24:41.338 | 120 ms | 0 ms | 0 | 32.282 ms | 77.162 ms | 9 |
| 3 | 12:28:16.421 | Default | 117.000 ms | 4 | 29.255 ms | 62.608 ms | 12 |

All three pairs qualify: full capture/receiver coverage, zero capture kernel
drops, errors, rejected records or incomplete records, and all captured
receiver packets match sender packets by SSRC/sequence/timestamp. There were
no sender gaps ≥40 ms, and neither end had gaps ≥100 ms. Net receiver loss was
zero. A clean default window remains in the evidence; the effect is not
presented as deterministic failure whenever the default is selected.

Relative transit excess over each capture's observed minimum reached **80.737,
119.074 and 97.598 ms** respectively. Absolute latency is not inferred from
cross-host timestamp subtraction. The 120 ms target window experienced the
largest measured transit variation while still reporting zero concealment.

The final window contains 6,001 captured arrivals in the wall-clock interval,
versus 6,000 sender packets in the corresponding sender wall-clock interval.
All 6,001 arrivals match the wider sender capture. Different transit delays and
clock offsets affect interval-edge inclusion; counts from these different
clock domains are not treated as a missing/duplicate packet count.

Final default window's six concealment polls:

| Poll end UTC | Concealment | Nearby sender max gap | Nearby arrival max gap |
| --- | ---: | ---: | ---: |
| 12:28:42.449 | 14.979 ms | 20.844 ms | 48.828 ms |
| 12:28:57.466 | 26.063 ms | 20.841 ms | 62.608 ms |
| 12:29:12.482 | 9.896 ms | 20.970 ms | 56.560 ms |
| 12:29:27.497 | 18.271 ms | 20.849 ms | 51.694 ms |
| 12:29:42.514 | 22.542 ms | 20.798 ms | 61.856 ms |
| 12:29:57.559 | 25.250 ms | 20.852 ms | 54.678 ms |

These roughly 15-second-separated polls reinforce the earlier periodicity
observation. They localize these incidents downstream of sender capture;
they do not distinguish Discord forwarding from Starlink or another network
hop. The final default window recorded no browser long tasks. The target
paired window had one 346 ms long task but no concealment. One receiver and one
connection cannot establish how other users' paths perform.

## Local queues and remaining access

Both local `enp8s0` and Oracle `ens3` use `fq_codel`; before/after snapshots
showed zero drops and zero queue backlog. Local UDP error, receive/send-buffer
error, checksum error and memory error counters did not increase in either
experiment. These are endpoint observations, not measurements of the router's
WAN queue or intermediate infrastructure.

The gateway identifies as TP-Link AX53 v1, firmware UI
`AX53v1_1.11.0_2026-01-05T02:52:45.222Z`. Its administration login is reachable
at `http://192.168.0.1/webpages/index.html#/login`. The user authenticated it and
the read-only inspection completed. Its WAN session had been up over six hours.
During 08:54–09:31 São Paulo time, the displayed WAN/controller/NAT log entries
were routine acknowledged DHCP renewals (300-second leases, approximately
154-second renewal spacing), with no recorded link drop/release/reboot in that
interval. This does not exclude brief packet delay or a radio/access-path stall.

The QoS service's latest startup log says `Function disabled` at 03:20:38,
before the test. The web HomeShield page describes **device prioritization**
and directs control to the Tether mobile app. No editable queue-delay/CAKE/SQM
control or WAN queue occupancy metric was exposed by the inspected web UI.
The `usageStats` page concerns opt-in product telemetry, not traffic queues.

No router configuration was modified, traffic shaping applied, paid service
enabled or connection restarted. Device-priority QoS is not established as a
fix for these incidents, and router log continuity does not identify the
upstream hop. The sanitized log summary is retained as `router-log-summary.json`;
router credentials, device addresses and identifiers are not published.

## Diagnostic fixes, cleanup and reproduction

- `browser_endurance.js` now waits at least 250 ms between stats reads, including
  the last read. A tiny terminal remainder previously could reread Chrome's
  cached stats and falsely fail strict coverage. Actual observed duration is
  retained; stale polls and real coverage failures are not hidden. Regression
  tests simulate cached timestamps and task overhead.
- `browser_buffer_trial.js` validates limits, collector lifetime, concurrency,
  receiver identity, applied settings and full coverage, persists terminal
  reports and restores the original setting on success or failure.
- `compare_buffer_trials.py` retains invalid windows, preserves optional unknown
  counters, separates quiet from concealment, and reports measured buffer cost.
- Validation: **56 Python tests**, plus Bun endurance, buffer-controller and
  observer-controller regression checks passed. No Rust build/deploy was
  required for these diagnostic-only changes.
- All temporary capture/collector services ended; the privileged shell exited.
  The required media companion and home tunnel remain running. Raydio's PID and
  production service are unchanged; Testbot remains inactive.

Reproduce the comparison offline:

```sh
env -u PYTHONEXECUTABLE -u __PYVENV_LAUNCHER__ uv run --no-project --offline python benchmarks/compare_buffer_trials.py docs/receiver-buffer-followup-20261003/comparison
env -u PYTHONEXECUTABLE -u __PYVENV_LAUNCHER__ uv run --no-project --offline python benchmarks/correlate_rtp_headers.py --sender docs/receiver-buffer-followup-20261003/paired/sender-3 --receiver docs/receiver-buffer-followup-20261003/paired/arrival-3 --report docs/receiver-buffer-followup-20261003/paired/receiver-audits/receiver.json
```

Evidence: [receiver-buffer-followup-20261003](receiver-buffer-followup-20261003/),
including every terminal report, the invalid initial pair, header-only packet
records, host samples, computed comparisons/correlations and restoration state.
