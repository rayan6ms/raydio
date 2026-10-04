# Playback repair evidence

See [the repair report](../BUG-FIXES-2026-10-03.md) for fix mapping and qualifications.
Original faulty-behavior reproductions remain in `../bug-audit-20261003`.

- `mantle-media-tests.log`: final full media suite, 250 pass / eight existing
  environment or optional-tool exclusions.
- `crust-tests.log`: adapter/server suites, 126 pass / two existing manual benchmarks.
- `raydio-tests.log`: all targets, 69 pass / no exclusions.
- `*-clippy.log`: scoped all-target checks with warnings denied.
- `receiver.json`: unchanged collector's completed five-minute receiver/PCM
  observation, including retained events and diagnostic windows.
- `oracle-resources.jsonl`: 361 read-only one-second host rows, including setup;
  `host-summary.json` aligns 299 rows with the receiver interval. Memory is
  sampled once per ten seconds (30 aligned samples).
- `oracle-playback.log`: allowlisted, ANSI-stripped command, source,
  preparation, terminal/start and sender checkpoints. Includes setup so lifetime
  sender counters are not mistaken for measured-window deltas.
- `live-summary.json`: release artifact, observed transitions and sender
  counter deltas with explicit time windows and measurement limitations.
- `runtime-advisories.json`: additional full Raydio lockfile audit, zero
  vulnerabilities and one existing unmaintained-package warning; strict
  warnings-denied whole-lockfile audit is not clean.
- `evidence-sha256.json`: hashes of evidence files, excluding itself.

No credentials, encoded descriptors, signed media URLs or recorded audio are stored.
