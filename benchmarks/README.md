# Rust memory comparison

For live cloud audio, avoid new SSH logins, builds, and kernel tracing during the
quiet receiver window. Ubuntu's dynamic SSH MOTD generation was observed to
disturb the fractional-CPU Oracle VM. A running bot and zero net packet loss do
not establish good audio: record concealment, PCM silence/clipping, speaking
changes, and sender timing separately. For mid-song comparisons, start early
and finish before EOF. Handoff/endurance tests must cover song boundaries and
retain their quiet intervals: natural tails are expected, extended tails are
still possible stalls and require review.

`playback_scheduler.py --pid PID --seconds 180 --output report.json` is a bounded
Linux diagnostic for a separate investigation window. It reads per-thread
scheduling counters once per second and measures independent 20 ms wakeups.
It must target the owned `raydio` or `testbot-release` process. Run it using
`uv run --no-project` locally or the standard-library Python interpreter on the
VM. Its own load and sampling limits must be retained in the interpretation.

For the current release experiment, exact binary hashes, live receiver captures,
and reproduction commands, start with [performance evidence](../evidence/PERFORMANCE.md).
The allocation experiment below documents an earlier optimization round.

`evidence/optimization-performance.json` identifies the baseline commit, measured
binary hashes, final source hashes, raw evidence, workload limits, and results.
The baseline is `bfc2a00`; the earlier playback comparison is a separate dataset.

Build with one Cargo job. On this host, retain the working native compiler/library
environment used for Mantle; do not compile while measuring. That round's checks were
`cargo test --all-targets` (42 passed), `cargo clippy --all-targets -- -D warnings`,
`cargo fmt --check`, and `git diff --check`.

## Endurance resource sampler

Start the sampler before playback and verify its first sample. The output path
is mandatory; an active Testbot service alone does not prove sampling started.
Run these commands on the VM, choosing a new output path for each attempt:

```sh
bot_pid=$(systemctl show raydio-six-hour.service --property=MainPID --value)
test "$bot_pid" -gt 0
bot_exe=$(sudo readlink -f "/proc/$bot_pid/exe")
sudo systemd-run --unit=raydio-endurance-resources \
  /usr/bin/python3 /opt/raydio/diagnostics/endurance-host.py \
  --pid "$bot_pid" --expected-exe "$bot_exe" --seconds 22200 \
  --output /var/lib/raydio/endurance-resources.jsonl
sudo systemctl is-active raydio-endurance-resources
sudo head -n 1 /var/lib/raydio/endurance-resources.jsonl
```

Do not begin playback until that first JSON row exists, has the intended PID,
has PSS/RSS/cgroup counters, and has no `error`. A missing or invalid row is a
measurement setup failure. Preserve each attempt separately; do not combine
short receiver captures into a six-hour result. Collect final sender logs and
resource samples after the observation window ends. Save browser checkpoints
during long runs so tab replacement cannot erase all prior observations.

### Receiver checkpoint preflight

Start `receiver_checkpoint.py --output NEW_DIRECTORY --seconds 25200` before
the browser audit. It refuses to overwrite an existing observation directory.
The collector writes `receiver-host.jsonl` immediately and once per minute,
independently of browser writes; browser disconnection therefore does not remove
local host pressure, CPU, uptime, UDP and interface evidence. A delayed sample is
marked `lateMs` and is not replaced with invented catch-up samples.

Install `browser_checkpoint.js` before the receiver audit. It observes replacement
reports after failed preflights, retries failed writes, and stays armed for seven
hours. It accepts the same 10–21,600 second durations as the audit so the full
persistence path can be checked in a short run. After starting the **actual**
report, call `raydioCheckpoint.save()` and verify `/health` from the Discord tab:
`lastReceiver.requestedAt` must match `raydioEndurance.report.requestedAt`, with
an advancing `elapsedSeconds`, and `hostSamples` must increase after one minute.
A timer handle or zero write errors alone is not proof of working persistence.
After the first minute, `await raydioCheckpoint.verify()` enforces the matching
running report, recent saved progress, two independent host samples, and enough
remaining lifetime in both collectors for the rest of the run plus a minute.
Do not call a run ready if this check throws.
Verify the independent Oracle sampler separately before beginning measurement.

The 256-window receiver bound would retain all 168 diagnostic windows from the
September 9 six-hour observation, instead of discarding 40. It remains bounded;
`diagnosticWindowsDropped` and event truncation must still be reported. No
collector can recover missing historical samples, identify the faulty network
hop from a single receiver, or guarantee that measurement has zero overhead.

Run the harness checks with:

```sh
bun benchmarks/test_browser_checkpoint.mjs
bun benchmarks/test_browser_endurance.mjs
uv run --no-project python benchmarks/test_receiver_checkpoint.py
```

Summarize a collected directory containing `receiver.json`, `service.log`,
`resources.jsonl` and optional `checkpoints.jsonl` with:

```sh
uv run --no-project python benchmarks/summarize_receiver.py \
  --input target/RUN/collected --output target/RUN/summary.json \
  --source-tail-ms 938.458
uv run --no-project python benchmarks/test_summarize_receiver.py
```

The tail value must come from the tested source; this example is the measured
Rick Astley fixture. Boundary alignment within two seconds only identifies a
candidate tail. An interval longer than the source tail plus an explicit 100 ms
tolerance remains flagged, even if its end coincides with a restart. All quiet
intervals are retained; this classification is not waveform matching. Checkpoint
counts are matched to the receiver's `requestedAt`, and negative loss-counter
changes are retained as signed corrections rather than attributed recoveries.

### Redundant volume regression

`source_packets OUTPUT --staged --repeat --redundant-filters` compares two plays
of one retained compressed source. The second restates volume 70 every 100
frames. `compare_source_controls.py OUTPUT REPORT` checks frame counts and
packet identity. Run this separately from Discord qualification. Identical
packets establish unchanged source processing for this test, not absence of
network loss or listener artifacts. Actual gain/filter changes require separate
control and audio validation.

## Sender/host correlation diagnostics

`scheduler_probe.c` extends the earlier Python scheduler observation with one
absolute 20 ms sleeping timer pinned to each of two permitted vCPUs, plus
one-second per-vCPU steal samples. It uses nice 10, no busy waiting, fixed
buffers (2,048 late events per CPU), and a maximum 1,200 seconds. It prints the
retained data only when finished; keep it alive until its duration ends.
The final summary includes its own CPU time. Compile separately from playback:

```sh
cc -O2 -Wall -Wextra -Werror -pthread benchmarks/scheduler_probe.c -o target/scheduler-probe
target/scheduler-probe 2 > target/scheduler-probe-smoke.csv
```

For a separate diagnostic window, start the probe and existing bounded
header-only sender interposer before playback. Preserve the sender host's
monotonic-to-UTC clock sample, the receiver report, and the completed probe CSV.
No new SSH logins or other administration should overlap the observation.
Afterward, correlate them with:

```sh
uv run --no-project python benchmarks/correlate_delivery.py \
  --trace target/sender.csv --clock target/clock.json \
  --receiver target/receiver.json --scheduler target/scheduler.csv \
  --output target/correlation.json
uv run --no-project python benchmarks/test_correlate_delivery.py
```

The probe's delayed wakeups include guest scheduling effects; overlap with
CPU-steal increments supports VM descheduling but does not provide subsecond
steal attribution. Truncation or timer errors reject the probe input. RTP
wraps, boundary-crossing gaps, and administrative packets outside the receiver
window are covered by synthetic analysis tests. These are diagnostic checks,
not passing audio or six-hour tests. Remove instrumentation for qualification.

The browser meter also retains discarded packets and NACK/FEC counters when
the browser exposes them. `availableCounters` distinguishes missing counters
from observed zero. These use the existing one-second `getStats()` poll and
do not change receiver buffering. A zero net-loss counter cannot substitute
for checking discarded/late packets, concealment and PCM continuity.

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
- Fresh receiver and playback-memory runs are in `evidence/PERFORMANCE.md`.
  The browser audit now selects an advancing stream and times its own windows.
  A player-panel edit race found by the control test is fixed; control speedup
  remains unclaimed because the failed baseline is not a valid comparison.
