# Cleanup and receiver concealment follow-up

## Current result

No bot-side concealment reduction has been qualified. Raydio continues on the
unchanged progressive production build `80f4ec627181171d224d5d3389cd2a86c553c578`,
alone on the existing Always Free Oracle instance. All short observations below
completed, but their considerable variation prevents selecting a route or
observer as a demonstrated audio fix.

The next missing evidence is a simultaneous, header-only capture of sender
packets and listener arrivals. Local `tcpdump` is installed but cannot capture
without sudo; the Linux sudo password was requested. No capture permission was
changed, and no media payload has been recorded.

## Cleanup

- Testbot had no active Oracle runtime or deployment directory. Its authenticated
  guild-leave operation returned HTTP 204, removing it from `test`. Its developer
  application and credentials remain available for recovery.
- Removed the unused Oracle worker release `9b527d59c0a429db19156e2b44fa2288ff3d44c7`
  and its uploaded package. `/opt/raydio/previous` points to the known full-stage
  fallback `bc6131dabfe01ce30554f7013d9d3eeffb40f326`.
- Removed Raydio's experimental worker feature wiring, version flag and extra
  feature CI runs. Default audio behavior and dependency pins are unchanged.
  Upstream opt-in code, dirty historical worktrees and measured evidence remain
  preserved.
- Found no local bot process in either Raydio checkout. Temporary host collectors
  and network probes have ended; browser meters, observers and checkpoint timers
  are inactive. The required home media companion and tunnel remain in use.
- General's temporary region override was restored to Automatic; the bot API
  verified `rtc_region=null` and the original 64 kbps channel setting.

## Observer comparison

One ongoing, cached Akcent “Stay With Me” playback, Loop ON, volume 70. Same bot
PID 34605, build, peer, SSRC and receiver track for the balanced sequence below.
Packet tracing was off. No builds, playback controls, source probes, deployment
or network probes ran during these windows. Host samplers read once per second;
memory traversal remained at most once per ten seconds. Persistence occurred
between windows, without the usual periodic browser checkpoint timer.

Endpoint mode reads counters during active-receiver selection, then once at the
end. It creates no AudioContext, audio sink, PCM worklet, DOM observer or polling
interval. PCM mode uses the existing full observer, including the extra analysis
graph, one-second stats/UI sampling and event-driven long-task diagnostics.
The report-return API was corrected before the first PCM window so the
comparison controller persists the complete report rather than a status-only
object.

All start times below are UTC on October 3; São Paulo is three hours earlier.

| Observer | Start | Seconds | Concealment | ms/min | Discards | Net loss |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Endpoint | 01:25:22.590 | 180.001 | 165.875 ms | 55.291 | 2 | 0 |
| Full PCM | 01:28:24.813 | 180.000 | 166.042 ms | 55.347 | 6 | 0 |
| Full PCM | 01:31:27.083 | 179.999 | 234.396 ms | 78.132 | 6 | 1 |
| Endpoint | 01:34:28.246 | 180.001 | 100.208 ms | 33.403 | 5 | 0 |

Endpoint aggregate: **44.347 ms/min**, seven discards, zero net loss over six
minutes. PCM aggregate: **66.740 ms/min**, twelve discards, one net loss over
six minutes. The endpoint rate was 33.55% lower in this sequence. This is an
observed difference, not a proven meter effect: the first pair was almost
identical, windows are short, and network/host behavior varies with time.
The meter is clearly not the sole source of concealment.

All windows retained their receiver identity and uninterrupted connection.
Both PCM windows had complete poll/PCM coverage, no long tasks, no clipping,
no invalid samples, no empty audio frames and zero silent concealment.
Endpoint mode has no PCM or per-incident coverage and makes no such claims.

The interior sender checkpoint spans are roughly two minutes per window,
not full three-minute packet traces. The first three spans each had 6,000
frames and zero skipped deadlines, source unavailability, overruns, send
failures, silence frames and gaps >=40 ms. The final endpoint interior had
one >=40 ms gap and one skipped deadline; no source/send failures.

The two PCM windows' median Oracle PSS was 16.220/16.265 MiB; endpoint windows
16.081/16.265 MiB. These are resource observations, not a memory optimization.

## Separate network diagnostic

01:38:13.696–01:41:13.696 UTC, three-minute full PCM receiver window with bounded
ICMP probes to the local router, Cloudflare and Google at five packets/second
each. This is deliberately excluded from the unprobed observer comparison.
Different protocols and paths prevent assigning a Discord packet's delay from
an ICMP measurement alone.

Receiver: 98.729 ms concealment, one discard, one net lost packet, zero silent
concealment and complete uninterrupted PCM coverage. Probe samples aligned
to that window:

| Path | Median RTT | p95 | Maximum | Samples |
| --- | ---: | ---: | ---: | ---: |
| Local router | 0.442 ms | 0.580 ms | 1.350 ms | 866 |
| Cloudflare | 22.700 ms | 36.000 ms | 141.000 ms | 894 |
| Google | 23.100 ms | 36.300 ms | 134.000 ms | 896 |

Independent WAN destinations produced near-simultaneous spikes, while LAN
latency stayed low. WAN outliers concentrate around UTC modulo-15 seconds
11–12. This supports investigating the access/ISP path. It does not prove
that Starlink caused every concealment or the earlier ICE disconnect.
The three recorded concealment windows did not consistently coincide with
the largest ICMP spikes.

Published research also documents globally synchronized 15-second Starlink
reconfiguration intervals with latency/throughput variation:
[A Multifaceted Look at Starlink Performance](https://doi.org/10.1145/3589334.3645328).
Its abstract was checked through OpenAlex. This is context for the hypothesis,
not a substitute for the bot's packet evidence.

A larger receiver incident at **01:40:17.895 UTC** contained 56.729 ms of
concealment. The sender's last >=40 ms gap was **56.655 ms at 01:40:17.892 UTC**,
and a nearby host interval had **12.676% CPU steal**. This supports a sender
scheduling contribution to that incident. Correlation does not establish the
cause of all other incidents, and process priority cannot guarantee removal
of hypervisor steal on a shared free VM.

## Voice route experiment

General was temporarily switched from Automatic to US East through the signed-in
server-owner UI. The bot API lacked Manage Channels (HTTP 403); no additional bot
permission was granted. Raydio resumed automatically after each migration.
Migration/warm-up intervals were excluded from the recordings.

| Route | Receiver start | Seconds | Concealment | Discards | Net loss | Final RTT |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| US East | 01:46:03.120 | 180.000 | 214.729 ms | 7 | 0 | 146 ms |
| Automatic restored | 01:51:25.977 | 180.000 | 435.271 ms | 3 | 4 | 19 ms |

US East did not beat the earlier balanced PCM aggregate and increased network
latency considerably. The restored route's worse single window demonstrates
the noise in choosing a winner from one observation. Neither route was
qualified as a fix; Automatic was restored and verified.

These windows also had complete receiver/PCM coverage, no clipping or silent
concealment, and no connection interruption during the measured interval.
All PCM quiet intervals >=100 ms in the follow-up were retained and classified
as source-tail candidates using the known 1,931.792 ms tail / 265.188 ms head
reference plus natural finish/start pairing. They were not erased or counted
as proven interruptions. Endpoint windows have no quiet classification.

## Diagnostic changes and validation

- `browser_counter_audit.js`: bounded endpoint-only observation; verifies an
  advancing, live, stable receiver, cumulative counter availability and signed
  loss corrections. Missing optional counters are unknown, not invented zeros.
- `browser_observer_trial.js`: bounded sequential comparisons, concurrency and
  collector-lifetime guards; persists each completed/failed window separately
  and stops on a failure or connection interruption.
- `browser_endurance.js`: rejects overlap with counter observation and returns
  its complete persistable report. Reinstall returns an explicit status.
- `compare_observers.py` and `correlate_network_phase.py`: retain per-window
  outcomes, normalize actual durations, preserve missing counters, distinguish
  endpoint/PCM coverage, and state the limits of ICMP attribution.
- `rtp_header_capture.py`: prepared two-minute capture, bounded to at most
  10,000 records and 180 seconds. BPF selects one IPv4 UDP/RTP/SSRC stream.
  Snaplen is 54 bytes (Ethernet, IPv4, UDP, fixed RTP header); only parsed
  timing/header metadata is saved. No payload pcap is retained. Unsupported
  layouts are rejected. **Regression-tested, not live-validated yet.**

Validation: default Rust all-target suite (58 tests), Clippy with warnings denied,
format check, 46 Python diagnostic tests and all five relevant Bun browser
harness checks passed. No audio algorithm, codec-quality or dependency change
was promoted on inconclusive results.

Evidence: [concealment-followup-20261003](concealment-followup-20261003/).
`observers/comparison.json` includes only the four balanced windows; terminal
archives also preserve the later, separately labelled diagnostics and routes.
