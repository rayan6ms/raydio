# Playback repair evidence

See [the repair report](../BUG-FIXES-2026-10-03.md) for fix mapping and qualifications.
Original faulty-behavior reproductions remain in `../bug-audit-20261003`.

- `mantle-media-tests.log`: final full media suite, 250 pass / eight existing
  environment or optional-tool exclusions.
- `crust-tests.log`: adapter/server suites, 126 pass / two existing manual benchmarks.
- `raydio-tests.log`: all targets, 69 pass / no exclusions.
- `*-clippy.log`: scoped all-target checks with warnings denied.
- Native package, deployment and receiver observations are added after completion.

No credentials, encoded descriptors, signed media URLs or recorded audio are stored.
