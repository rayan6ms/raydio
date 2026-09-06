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
