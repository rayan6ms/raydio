# Dependency fixes: six-hour attempt interrupted — 2026-09-10

The six-hour attempt **did not complete or pass audio continuity**. Receiver
coverage ended after **2 h 31 min 31.592 s** at 05:55:55.749 UTC. Its final report
was saved at 05:55:56.824 UTC, after the voice connection failed. Testbot later
stopped playback on a DAVE encryption-state failure at 05:56:38.234 UTC. The bot
process survived with its original PID and zero restarts. This is useful failure
evidence, not a successful six-hour test or a measured audio improvement.

## Final measurements

| Measurement | Result |
|---|---:|
| Requested / receiver / PCM coverage | 21,600 / 9,091.592 / 9,092.432 s |
| Unobserved requested receiver time | 12,508.408 s (3 h 28 min 28.408 s) |
| Received / net lost packets | 453,596 / 22 |
| Positive / negative loss-counter changes | +37 / -15 |
| Discarded packets / NACKs | 189 / 618 |
| Concealed / silently concealed audio | 28.307 / 17.812 s |
| PCM clipping / nonfinite / empty frames | 0 / 0 / 0 |
| Off-boundary quiet >=100 ms before final outage | 6; 126.9–944.1 ms, 3.040 s total |
| Final quiet interval, still ongoing at recorder stop | 15.526 s; a lower bound on the outage |
| Natural boundary long quiet intervals | 43; 976.25–986.25 ms |
| Oracle playback PSS min / median / max | 15.595 / 16.321 / 16.345 MiB |
| Bot CPU / host CPU steal | 4.030% of one core / 0.395% |
| In-window sender frames unavailable / send failures / source overruns | 0 / 0 / 0 |
| In-window active sender gaps >=40 / >=100 / >=1,000 ms | 87 / 0 / 0 |
| Sender maximum active gap / deadline lateness (lifetime snapshot) | 80.135 / 60.724 ms |
| Oracle UDP/NIC errors or drops / cgroup OOM events | 0 / 0 |
| Receiver stale polls / missing PCM reports / lost archived events | 0 / 0 / 0 |
| Checkpoint saves for actual run / save errors | 153 / 0 |

Sender deltas cover 03:24:47.831–05:55:47.831 UTC: they omit the first 23.674 s
and last 7.918 s of receiver counters. Host CPU/PSS use 152 samples during the
receiver interval, excluding the later idle bot. The first/last five PSS samples
have medians 16,329/16,717 KiB, a 388 KiB increase. This is not a proven leak or
memory reduction. The prior six-hour run's median was 16.396 MiB and CPU 3.98%;
different duration and conditions do not establish an improvement here.

The 151 minutes before the final partial minute contain 13.062 s concealment
(3.092 s silent), or 86.509 ms/minute over 9,059.545 s. This separate subtotal
helps identify concentration in the final outage; the full totals above remain
the result. Concealment counters, PCM quiet and network loss are different
measurements and must not be added or interpreted as identical audible silence.
Zero clipping does not prove absence of other perceptual artifacts.

## What happened, and what the evidence supports

1. **Ordinary song tails were not the major interruption.** All 43 long boundary
   quiet events end near consecutive logged natural finish/start pairs, whose
   maximum handoff is 5.019 ms. Their duration agrees with the independent
   938.458 ms source tail plus the explicit 100 ms tolerance. Two overlap receiver
   concealment and stay flagged; the other 41 long tails and 42 short ~22 ms tails
   are source-tail candidates. No extended boundary quiet or end-watchdog stall
   was recorded. This supports the EOF fix over 43 repeats, not permanent proof.

2. **Five mid-song interruptions point beyond the application sender.** Quiet
   ending at 03:34:28.282, 03:35:13.072, 03:43:27.834, 05:27:12.563 and
   05:27:56.096 UTC lasted 944, 785, 483, 320 and 381 ms. Each bracketing sender
   minute delivered 3,000 frames with unchanged >=40 ms gap, unavailable-frame,
   skipped-deadline and error counters. Receiver packets arrived late, were lost,
   or were discarded; e.g. the last event has 23 packets followed by 80, with
   buffer delay rising to about 403 ms. These records argue against a matching
   application pause. They do not locate a kernel, Oracle, Discord or receiver
   network hop, nor prove that every successful UDP send arrived on time.

3. **One short cluster has a sender scheduling contribution.** Near 03:52 UTC,
   63 and 127 ms off-boundary quiet coincides with a minute containing 18 additional
   >=40 ms send gaps, 16 skipped deadlines and 2,955 delivered frames. Host steal
   rose to 3.00% in the containing minute, versus about 0.26% just before. No
   source starvation, send failure or >=100 ms active send gap occurred. This is
   a supported correlation with VM scheduling, not exact attribution of each
   concealed sample; the once-per-minute snapshot retains only the latest gap's
   exact timestamp. This run does not justify lowering audio quality or adding
   an arbitrary large sender buffer.

4. **The final receiver outage preceded the bot error.** PCM quiet starts at
   approximately 05:55:41.046 UTC; packets stop, ICE/peer become disconnected at
   05:55:46.526, and the peer fails at 05:55:56.524. Oracle was still
   Connected/Sending at 05:55:47.831 and sent another 2,520 frames before its
   terminal error. Local independent network logs later report TCP timeout,
   router/NAT `NetworkFailure`, IPv6 route recovery and a changed public IPv4
   mapping at approximately 05:56:59–05:57:25. The last pre-outage mapping record
   was 01:39:26 UTC. This strongly implicates a disruption of the local receiver's
   Internet path. It does not prove the router versus ISP cause, or that Tailscale
   caused the disruption. No suspend, stale browser poll, missing PCM report or
   matching Oracle resource failure was found. USB resets follow the start of
   the outage; their coincidence does not explain the missing network packets.

5. **Playback also failed to survive a later encryption-state change.** At
   05:56:38.234 UTC the bot reports `DaveTransition / InvalidState`, with
   `active_version=0`, `transition_pending=false`, `ready=false`, then Raydio
   deliberately cleans up the session. This proves why playback stopped, but
   cannot explain the earlier receiver outage. Code inspection identifies a
   plausible race: the DAVE owner processes a control that clears readiness;
   the gateway publishes the new phase only after awaiting its outbound messages;
   an in-flight sender can still request encryption, which currently treats
   not-ready as fatal. `PrepareEpoch(epoch=1)` and invalid-commit recovery can both
   produce the observed state. The log does not record which control occurred;
   neither a specific control nor this interleaving is claimed proven for this
   incident. A deterministic reset/queued-frame/recovery reproduction is needed
   before claiming a fix. Any fix must preserve the pending frame, keep Stop and
   replacement responsive, and never send unencrypted audio.

The highest-value next bot investigation is that DAVE lifecycle race. The largest
observed outage also requires a stable receiver path (ideally a second receiver
on an independent network) for a meaningful repeat. Moving off Oracle or reducing
bitrate would not address the demonstrated local network disruption. Oracle
remains the chosen free host.

## Evidence integrity and analyzer correction

The browser's surviving final report agrees with the disk recording. There are
1,098 events with complete sequencing, all 79 incident windows, no dropped
windows, 0.2 ms initial clock uncertainty and -17.7 to +2.57 ms recorded clock
drift. The largest browser long task was 84 ms; the largest poll was 1,080 ms.
Serialization peaked at 6.5 ms. These do not explain the multi-second outage.
Local host samples continued after the receiver stopped. Oracle retained all 421
host samples from 03:03:41.908 to 10:03:41.908 UTC with no sampling error or PID
change. Seven hours of host samples are not seven hours of music.

The analyzer previously restricted sender reporting to receiver coverage. It now
also reports typed terminal sender events through the **planned** observation end,
including the later DAVE failure, while keeping CPU/memory statistics restricted
to the actual receiver interval. It also exposes the receiver error, missing
duration and independent host collection coverage. A regression verifies that
post-disconnect failure is retained, post-stop idle memory is excluded, and events
after the requested end are excluded. All 10 relevant Python tests pass.

Original receiver and Oracle files were copied before any runtime changes. Full
read-only Oracle collection required refreshing the existing administrator-only
SSH /32 after the local public IP changed; no broader ingress was added. This
happened after the planned test window. The original launch also had one extra
read-only status SSH around 03:26 UTC, so this was not literally an SSH-free run.
That check is not near the major incidents and does not establish measurement
interference. No bot restart, rebuild, packet interception or new playback command
was performed during this results review.

At review, Testbot is online with PID 8963, **idle after playback cleanup**.
Production Raydio is inactive and disabled. Oracle maintenance timers were
restored; receiver/resource collectors and journal-save timer have ended. No new
six-hour run has been started. Only analysis/reporting code changed in this
review; there is no new bot build or deployment to claim tested.

`results/summary.json` and `results/incident-correlation.json` retain calculations.
`results/raw-evidence.tar.gz` preserves the receiver, sequenced archive, both host
samplers, Oracle logs/status and source provenance. Its manifest hashes each file.
Credentials, OCI identifiers, media payloads and unredacted network-address logs
are excluded. To reproduce from the repository root:

```sh
mkdir -p target/dependency-run-review
tar -xzf evidence/dependency-fixes-20260910/results/raw-evidence.tar.gz -C target/dependency-run-review
uv run --no-project python benchmarks/summarize_receiver.py --input target/dependency-run-review --output target/dependency-run-review/summary.json --source-tail-ms 938.458333 --source-head-ms 0
```

## Launch and implementation record

The seven findings from `../dependency-audit-20260910/RESULTS.md` now have fixes
and permanent regressions. The latest candidate is deployed as Testbot on the
existing free Oracle instance. Production Raydio remains inactive and disabled.

## Code and measured checks

- Mantle `88fbed2`: filter replacement drains accepted streaming data and retains
  decoded/resampled PCM, partial output, clocks and EOF. Repeated identity changes
  preserve every encoded byte and timestamp for FLAC, MP3, AAC 48 kHz, resampled
  AAC 24 kHz and mono PCM 8 kHz. Rate transitions preserve partial samples without
  inserting a padded transition frame. Opus bypass/processing toggles retain
  packet order and source position. Changing a finished source's filters remains
  EOF rather than panicking.
- Oto `831d5e2`: attachment ownership survives cancellation after acknowledgement;
  32 cancellations and retry preserve nonce progression 123 to 124. Pacer
  registration installs its cancellation guard before yielding, releasing orphaned
  coordinator slots. Bounded sender counters retain active send-gap thresholds,
  latest/max gap and latest wall timestamp.
- Crust `bc2ef70`: pending frame demand no longer holds Stop behind a stalled
  read. Stopped source results are discarded; cancellation rejects abandoned
  controls. Deferred Play/Seek/filter updates expire after one second behind a
  read. Already started open/seek I/O retains its configured timeout. Load Drop
  cancels its worker signal and aborts its watcher. Player churn prunes dead Weak
  allocations: 1,000 cycles retain one entry and capacity at most four.
- Raydio `373c656`: exact dependency pins, improved receiver evidence, and a
  conservative boundary classifier. Tests: Raydio 49, integrated Crust 160,
  scoped Mantle 99, Oto 98. All passed, with existing manual/environment exclusions
  unchanged. Scoped Clippy checks pass. Mantle advisory, license and vet checks
  pass. No new third-party dependencies were introduced.

The old frame-loss reproductions lost 60 ms FLAC, 60 ms resampled AAC and 20 ms
MP3 per tested filter change. The new repeated-change tests retain exact output.
This is a deterministic continuity improvement, not proof of perfect live audio.

The separate ten-second release owned-channel/DAVE/UDP benchmark retained zero
allocations and reallocations before and after. It delivered 500/501 packets and
observed maximum lateness 2.139/1.837 ms. One short pair cannot establish a lasting
latency improvement; the one-frame difference is measurement-boundary timing.
See `sender-benchmark.json` for exact binary hashes.

The deployed binary SHA-256 is
`e62fb82176d81ea35b4fdc54626ff0f40f9563d340d1369d57c338edf3699a23`.
It is 18,619,248 bytes; the deployment archive is 7,568,087 bytes. Oracle verified
all archive checksums and passed `--check`. The binary needs glibc through 2.34
and the usual libc/libm/libgcc runtime; no media helper process is required.

## Source reference and evidence interpretation

A fresh, separate Oracle source pull at volume 70 produced 10,653 frames over
213.06 seconds. Independent system libopus 1.6 decoding found no malformed frame
duration, nonfinite sample or clipping. The only >=20 ms quiet interval was the
938.458333 ms terminal tail. Maximum source read time was 13.961395 ms with zero
reads reaching 20 ms. `source-reference.json` records provenance and packet hash.
The source fetch is separate from the live run, not a waveform recording of each
loop. Its startup gain and native audio characteristics were unchanged.

Quiet intervals remain in raw evidence. Consecutive matching natural finish/start
generations, bounded handoff, matching duration, and absence of overlapping
receiver/transport/scheduling anomalies are required for a source-tail candidate.
Even a candidate is not proof of source-only causation. Extended boundary quiet
and off-boundary quiet remain flagged. Acoustic timestamps use the audio worklet
clock, with reset uncertainty and ongoing clock drift retained; delayed browser
report delivery no longer supplies the quiet interval's endpoint.

All required receiver counters were available at preflight. Receiver replacement,
counter reset/disappearance and coverage gaps fail or warn explicitly. The local
collector saves a bounded sequenced event archive with deduplication and gap
accounting. Sender and receiver hosts have independent minute samples; Oracle
journals are saved every five minutes. The host samplers, journal timer and sleep
inhibitor outlive the planned receiver end. Counters and logs cannot identify every
network hop; sender gap counts retain only the latest exact event time per snapshot.

## Original launch timing

Actual receiver start: **2026-09-10 03:24:24.157 UTC**.
Planned completion: **2026-09-10 09:24:24.157 UTC** (**06:24 São Paulo**).
Run identity: `2026-09-10T03:24:21.947Z`.

One Testbot, General in server test, volume 70, Loop ON. Oracle PID 8963 uses
`raydio-isolated-six-hour.service`; production `raydio.service` is inactive.
The first setup observation was stopped after enabling Loop and preserved
separately. Per the latest request, the six-hour run began immediately and its
first five minutes serve as qualification without stopping the recording.
No bot restart, build, tracing or administrative SSH is planned during measurement.

Persistence was verified against the actual advancing run, with two independent
host samples, no missing archived events, and more than 25,000 seconds of local
collector lifetime. Initial PCM reset uncertainty was 0.2 ms. Early concealment is
retained; starting successfully is not a clean-quality or six-hour pass claim.

Local receiver evidence: `target/dependency-six-hour-20260910/receiver/`.
Oracle evidence: `/var/lib/raydio/dependency-six-hour-20260910/`.
Exact collector units, source reference and timing are recorded in `run.json`.
The bot stays running when the receiver measurement completes.
