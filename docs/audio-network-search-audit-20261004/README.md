# Audit evidence and replay

The report is [AUDIO-NETWORK-SEARCH-AUDIT-2026-10-04.md](../AUDIO-NETWORK-SEARCH-AUDIT-2026-10-04.md).

The `.patch` files add temporary characterization probes to the exact source
revisions recorded in `inspection-status.json`. They assert existing faulty
behavior; they are not fixes. The normal source was restored byte-for-byte.

Apply Raydio patches in the `raydio-rust` checkout, the three Mantle-related
probes in the two `mantle-*.patch` files in `mantle`, and each `crust-*.patch`
in `crust`. Preserve any local changes and use isolated checkouts for replay.
The Opus fixture path in its probe matches this audit's local workspace:
`/home/rayan/Documents/Projects/raydio-rust/docs/audio-network-search-audit-20261004/fixtures`.
Adjust that path if replaying elsewhere. Fixture generation commands are in
`fixture-generation.json`; validation results/hashes are in
`verification-summary.json`.

Bounded commands (unset inherited AppImage launcher variables when necessary):

```sh
# raydio-rust
CARGO_BUILD_JOBS=1 cargo test --locked audit_ -- --nocapture --test-threads=1
# mantle
CARGO_BUILD_JOBS=1 cargo test --locked -p mantle-media --lib audit_ -- --nocapture --test-threads=1
# crust
CARGO_BUILD_JOBS=1 cargo test --locked -p crust-server --test p10_voice audit_ -- --nocapture --test-threads=1
CARGO_BUILD_JOBS=1 cargo test --locked -p crust-oto-adapter --lib audit_deferred_source_wait -- --nocapture --test-threads=1
```

The notification probe captures a component-level interleaving, not a complete
voice-session failure. The server lag probe injects the adapter's typed error;
it does not create a real Oracle event-ring overflow. The fixture parser/mix
probes make no external source requests. Logs state these actual measurements;
no receiver-quality or production fix is implied by a passing test.

Regression logs record suites run with the normal source restored, except the
Crust voice regression log, which intentionally includes the D2 probe. Python
diagnostic tests ran via `uv run --no-project python -m unittest discover -s
benchmarks -p 'test_*.py' -v`; Bun ran each `benchmarks/test_*.mjs` directly.

`evidence-sha256.json` hashes the durable audit files. It excludes itself and
does not contain credentials, runtime configuration or signed media URLs.
