# Rust memory comparison

`evidence/optimization-performance.json` identifies the baseline commit, measured
binary hashes, final source hashes, raw evidence, workload limits, and results.
The baseline is `bfc2a00`; the earlier playback comparison is a separate dataset.

Build with one Cargo job. On this host, retain the working native compiler/library
environment used for Mantle; do not compile while measuring. The final checks were
`cargo test --all-targets` (42 passed), `cargo clippy --all-targets -- -D warnings`,
`cargo fmt --check`, and `git diff --check`.

## Whole bot

Preserve separate release binaries before running:

```sh
uv run --no-project python benchmarks/compare_rust_idle.py \
  --before target/performance/raydio-bfc2a00 \
  --after target/performance/raydio-optimized
```

The driver verifies the dedicated Testbot identity, starts one owned process at a
time, waits for Discord readiness, warms up five seconds, then samples `/proc`
for fifteen seconds. It alternates build order over three independent starts
each and terminates its own processes. Child logs and tokens are never written
to evidence. Stop any existing owned Testbot instance before starting; no builds
or other benchmarks should overlap. Saved binaries are local ignored artifacts.

## Allocation workloads

```sh
CARGO_BUILD_JOBS=1 cargo build --release --example memory_workloads
target/release/examples/memory_workloads
```

This uses production `Cache::update`, `resolver::normalize`, and `views::player`
with deterministic inputs. The example's counting allocator measures requested
Rust heap bytes, not allocator metadata, native codec allocations, or process
PSS. Parsing consumes an already allocated response: compare `peakHeapBytes`,
not the saturating `retainedBytes` delta. Channel-cache retained bytes exclude
the input event fixtures, which exist before measurement. Five parsing/rendering
trials are recorded; each rendering trial has 10,000 calls. The panel JSON emitted
by the old and new binaries was semantically equal.

The final section models the old and new autocomplete cache representations with
500 queries and ten tracks each, including 400-byte encoded tracks. It retains
the same clones as the respective runtime paths. Compare retained bytes and hit
workloads; construction timings cover different work and are not comparable.
Instrumented timings include the allocation-counter overhead, so they are not
unmodified production latency or Discord round-trip measurements.

To rebuild the baseline core workload, create a detached sibling worktree at
`bfc2a00`, copy the current example through the line preceding
`// Paired cache model:`, and append the closing `}` for `main`. This excludes
the later autocomplete model's dependency on `views::search_choices`, which did
not exist in the old runtime. Build the example there with the same compiler,
release profile and dependency checkouts. The input fixtures and core measurement
code are identical. Locally the original executable is preserved as
`target/performance/workloads-before`.

## Scan decisions

- Kept compact channel records, compact autocomplete choices, owned JSON
  consumption, direct typed panel construction, and the local client's reduced
  dependency/buffer setup after the memory comparison improved.
- Confirmed the earlier button response fix with a successful HTTP fixture:
  Pause emits one edit, retains its delivered snapshot, and does not deserialize
  a returned message body. This is a correctness/request-count check, not a new
  live latency measurement.
- Reviewed Crust/Mantle/Oto buffer ownership. The voice bridge is capacity one;
  Mantle and Oto already reuse audio buffers. Audio buffering, codec quality,
  pacing, and DAVE were left unchanged: this pass found measurable savings in
  Raydio without changing those behaviors.
- Did not claim startup or idle CPU improvement: the startup median was 2.608s
  before and 2.658s after, and idle CPU was near measurement resolution.
- Live playback-memory and browser click-latency measurements require the user
  to sign in to the reopened controlled Discord tab. The previous live datasets
  have not been relabeled as measurements of this build.
