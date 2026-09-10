# Dependency fixes and six-hour Oracle run — 2026-09-10

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

## Current run

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
