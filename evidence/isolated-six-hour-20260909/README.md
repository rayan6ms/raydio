# Isolated Testbot diagnostic attempt

Production Raydio was stopped and disabled at user request on September 9.
Its release files, service definition and configuration remain for redeployment.
The preceding shared-instance diagnostic was deliberately stopped after
803.238 seconds of receiver coverage. Its receiver and host evidence are preserved
under ../dave-diagnostic-20260909/interrupted/. It is not a six-hour qualification.

## Diagnostic changes

- Oto retains DAVE protocol version, ready state and whether a transition was
  pending in failure snapshots, alongside the previously added typed cause.
  State is observed after failure; it does not prove the ordering of a race.
  No keys, payloads or arbitrary backend exception text are logged.
- Crust emits a timestamped cumulative sender and connection snapshot at most
  once per minute, piggybacking on existing snapshot calls. It adds no observer
  task or per-frame logging. Counts, source generation, current phase, sender
  lateness, source overruns and typed failures can now be aligned with receiver
  windows without stopping the bot to retrieve lifetime counters.
- Raydio logs track start/finish, accepted source failures/stalls and voice
  closure with numeric playback position/generation. No source URLs or exception
  messages are logged. These lifecycle events disambiguate source repeat tails.
- Host samples include UDP errors/buffer errors, interface bytes/errors/drops,
  host available RAM/swap, load and CPU/memory/I/O pressure. The checkpoint writer
  also saves local-host pressure and network counters once per minute.
- Receiver samples retain six seconds of preceding and five seconds of following
  data around interruptions/high concealment. At most 128 windows and 4,096 events
  are retained; older records are dropped with explicit counters. Minute totals
  remain. Coverage/truncation must be reviewed before claiming a full pass.
- Receiver events include browser online/offline, ICE state, track mute/end,
  audio-context and device changes. Codec, sample rate, audio-context latency,
  safe ICE RTT and clock alignment are retained; candidate addresses are omitted.

No encoder settings, bitrate, pacer behavior or retry policy changed. No packet
interposer, network stress, raw audio recording or per-frame disk writes are used.
The bot contains a few lifecycle-only log statements and extra failure metadata;
the sampler and receiver observe their own overhead. This does not establish that
all measurement effects or internet/cloud scheduler disruptions are impossible.

## Validation

95 Oto tests and warnings-denied all-target clippy passed; the terminal DAVE test
also verifies the context survives into the durable snapshot with no plaintext.
14 Crust adapter tests passed and all-target clippy passed.
49 Raydio tests passed. Browser tests simulate six hours of repeated anomalies,
verify bounded histories and dropped-event accounting, cleanup and disconnect
failure. A checkpoint HTTP smoke check persisted local host counters. A virtual
clock sampler smoke check verified host UDP/device/memory/pressure samples.

The full integration and release checks, live smoke results, candidate checksum,
start/end times and retrieval locations are recorded alongside this document.
Six-hour success requires uninterrupted receiver/PCM coverage, review of silence
and speaking transitions against source boundaries, and no terminal sender error.
A diagnostic run alone is not a proven fix for the original DAVE failure.
