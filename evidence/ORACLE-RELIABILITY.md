# Oracle audio qualification, September 6

Exactly one Always Free E2.1.Micro instance exists in São Paulo. Ubuntu 24.04
x86-64, 1 GiB RAM, 47 GiB boot volume. Production Rust Raydio is deployed, but
that fact is separate from audio qualification. No paid shape or second instance
is authorized. TypeScript is preserved on `legacy/typescript`.

## Retained failures

The initial 180-second receiver capture stopped mid-track, with 2,039,148
concealed samples and a 41.6-second quiet tail. The initial package ignored Oto
terminal audio events, so no exact failure classification survives for that run.
It cannot be retrospectively attributed to a specific error.

The next complete sender trace delivered 10,658 packets in 215.202 seconds,
without send errors or RTP discontinuities, but 46 gaps exceeded 40 ms and the
maximum was 81.938 ms. The corresponding 180-second receiver window had 82,748
concealed samples and two speaking interruptions. See `audio-oracle-traced.json`
and `udp-send-oracle-before.json`.

A new diagnostic package added terminal error reporting and repeated the same
track at volume 70, with no controls or build during capture. It did not
reproduce the terminal failure. The 180-second window had 8,957 received packets,
zero reported loss, 28,530 concealed samples (594.375 ms), zero silent PCM blocks,
zero clipping, and no speaking interruptions. The full track sender trace had
39 gaps over 40 ms, maximum 80.867 ms. Run-to-run variation alone is not proof of
an improvement. See `audio-oracle-diagnostic-before.json` and
`udp-send-oracle-diagnostic-before.json`.

## Repairs under verification

Crust now reads the current durable Oto sender state and reports a terminal
failure with safe typed counters, instead of leaving a playing zombie. Its new
regression timed out before this repair and passes afterward.

Oto previously rejected any source poll exceeding 2 ms wall time. A simulated
20 ms off-CPU delay demonstrated that a valid frame was permanently rejected.
Linux now uses thread CPU time for fatal attribution while retaining elapsed
budget overruns in telemetry. CPU-heavy and invalid-length sources still fail.
Callbacks must remain non-blocking: sleeping or blocking I/O is still forbidden
but cannot be detected by the CPU guard. This repair does not prove the cause
of the original unclassified cloud stop.

Extending the regression to a 30 ms delay during active playback exposed
catch-up polling immediately afterward. Oto now restarts the next deadline
20 ms after completion and discards the capacity-one old deadline. The extended
regression and the remaining automated Oto tests pass.

The local DAVE benchmark before/after the CPU guard retained zero allocations
and approximately 50 frames/s. Its one-run lateness difference is not presented
as a speedup. The coordinator-count experiment is excluded.

## Memory accounting

Fresh production idle PSS measured 12,384 KiB, RSS 14,808 KiB. Initial playback
PSS was about 15.4 MiB with ~4% of one CPU; exclude the final idle/failure window
when interpreting `oracle-playback-first.json`. The cgroup's ~2.6 MiB
`MemoryCurrent` omits file pages charged elsewhere and is not total bot memory.
Warm idle after playback is a different workload and must be labelled separately.

Further matched worker-count and corrected-package audio measurements follow.

## Fresh CI package and source diagnostic

The one-worker CI package `1e944a9` completed the track, but failed the receiver
gate. The 180-second window recorded 8,798 packets, zero net packet loss,
206,826 concealed samples (4,308.9 ms), 90 silent PCM blocks, a 3,712 ms quiet
run, and three speaking interruptions. The complete sender trace contains two
long gaps, 3,590.8 and 3,730.0 ms, each preceded by exactly five small encrypted
silence packets. The UDP send calls themselves took only about 0.02 ms. This
locates the interruption before/during frame supply rather than in the browser
alone. It does not distinguish a slow source read from delayed worker delivery.
See `audio-oracle-ci-workers1.json` and `udp-send-oracle-ci-workers1.json`.

A repeat added only temporary read-duration diagnostics. It recorded 8,966
packets, zero net loss, 30,445 concealed samples (634.3 ms), no quiet PCM blocks,
no clipping, and no speaking interruptions in 180 seconds. The complete sender
trace's maximum gap was 99.380 ms, with 21 intervals over 40 ms. No source read
over 58 ms was logged, so the multi-second source delay was not reproduced.
This unchanged behavior is run-to-run variability, not a proven optimization.
See `audio-oracle-source-diagnostic.json` and its matching sender report.

The current receiver path differs from earlier sessions after a local public-IP
change and browser restart. Preserve that limitation in cross-session comparisons.
The current CI playback sampler measured 15,709–15,837 KiB PSS in the first seven
20-second windows, at approximately 3.85–4.05% of one CPU. The eighth includes
the audio interruption and must not be treated as an equally active CPU sample.
These are playback measurements, not a new authenticated-idle improvement.

The HTTP audit found that Crust always supplies a RoutePlanner policy, including
when disabled. Mantle deliberately disables connection pooling for routed
requests. A regression proved that two real adapter metadata loads opened two
TCP connections before and one afterward. Crust now uses Mantle's normal source
and playback paths when the planner is disabled. Enabled routing retains its
connection isolation, and 19 adapter/filter tests plus Clippy pass. See
`source-http-reuse.json`. Temporary source-read diagnostics are excluded from
the committed implementation.

The first pooled one-worker track completed with 10,658 outgoing packets,
zero send/RTP errors, and maximum spacing 85.607 ms (28 gaps over 40 ms). The
180-second receiver capture began too late and included the final seconds of
the song: its terminal quiet run is not a valid mid-track comparison. The full
raw result is retained. A new 150-second window with two workers is measured
below. The pooled one-worker PSS was 15,849–16,201 KiB; no memory reduction
is claimed for keeping HTTP connections reusable.

See [the free hosting assessment](../deploy/FREE-HOSTING.md) for alternatives
and their billing, uptime, and bandwidth constraints.

The pooled two-worker 150-second receiver capture recorded 7,462 packets, zero
net packet loss, 38,244 concealed samples (796.75 ms), no silent PCM blocks, no
clipping, and no speaking interruptions. The complete track sender trace had
10,658 packets, no send or RTP errors, maximum interval 100.277 ms, and 20 gaps
over 40 ms. Memory across seven windows was 16,349–16,493 KiB PSS at roughly
4.2–5.2% of one CPU. HTTP connection reuse is proved by the regression; these
variable cloud timing results do not establish a live audio speedup.

## Same-binary local versus Oracle comparison

The same prototype binary, volume 70, two workers, and browser peer were tested
sequentially on Oracle and locally. Both 150-second captures had zero silent
PCM blocks, clipping, speaking transitions, and net packet loss. In the sender
trace aligned to each receiver window:

| Measurement | Local | Oracle Micro |
| --- | ---: | ---: |
| Received packets | 7,503 | 7,462 |
| Concealed audio | 74.708 ms | 796.750 ms |
| Maximum outgoing packet interval | 21.027 ms | 100.277 ms |
| Outgoing intervals over 40 ms | 0 | 16 |
| Playback PSS, seven windows | 16,001–16,025 KiB | 16,349–16,493 KiB |
| Playback CPU, one core | 3.30–3.50% | 4.19–5.18% |

The long intervals already exist before packets leave the Oracle process.
Together with earlier low syscall durations this implicates sender/worker/host
scheduling or upstream supply, rather than only downstream packet loss. It does
not isolate hypervisor scheduling as the sole cause. The isolated source timing
diagnostic did not reproduce the multi-second stall. A1 remains untested and
out of capacity; this Micro has not matched local transmission timing.

The local control phase followed the audio capture automatically in the browser
and passed all 12 alternating Pause/Resume transitions. It measures click to
updated footer, not audible control latency. The earlier cloud control attempt
started after EOF and is retained as invalid. The benchmark now requires an
advancing panel before clicking; stale historical messages cannot count as an
active player. No matched live button speedup is claimed.

Raw reports: `oracle-local-pooled-comparison.json`, both
`audio-*-pooled-workers2.json` files, the corresponding memory files, and
`latency-local-pooled-workers2.json`. Sequential shared-host observations are
not randomized network trials or a guarantee for a whole future session.

A 60-second independent Python/OS timer probe with Testbot stopped measured
maximum wakeup lateness of 0.186 ms locally and 6.026 ms on Oracle. Neither
recorded an interval over 40 ms. Therefore the 80–100 ms audio intervals were
not reproduced by an idle host timer alone; assigning every gap to hypervisor
steal would be unsupported. Oracle cgroup accounting reported no quota
throttling and the service has no CPU quota. The worker/source/loaded-host
interaction remains unresolved. Raw timer reports and the bounded probe are
committed for reproducibility.
