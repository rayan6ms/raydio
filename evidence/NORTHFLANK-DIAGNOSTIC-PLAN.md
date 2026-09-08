# Northflank scheduling diagnosis

The provider receiver traces and sender counters disagree about the exact
intervals because they use different clocks and lifetimes. The new
`deploy/diagnostic.Dockerfile` packages the unchanged pinned release with
`benchmarks/container_sampler.c`. It supervises the bot in one child process
and emits one bounded host sample per second, without intercepting, delaying or
altering audio. Each sample records bot RSS (and PSS every 30 seconds), thread
count, cgroup memory, cgroup CPU usage/quota/throttling counters, and per-thread
`schedstat` run/wait deltas (up to 128 threads). A missed deadline skips ahead
instead of bursting samples. Sampling overhead is measured in every row.

The supervisor was compiled with `cc -Os -Wall -Wextra -Werror` in the Rust
Bookworm container and passed a two-second child-process smoke test. Its first
sample took 0.308 ms wall / 0.306 ms CPU; the second took 0.178 ms wall /
0.176 ms CPU. The sampler itself consumed roughly 1 ms CPU over the smoke run.
No bot or network service was started by that test.

Use this image only in a separate Northflank Testbot service, with the existing
Testbot secret and an explicit 900-second command override for screening. Keep
the current service stopped during the test to avoid duplicate tokens. Save
sender logs and browser receiver checkpoints, then correlate `utcNs` with the
receiver clock. Pay particular attention to `throttledPeriods`,
`throttledUs`, `maxThreadWaitDeltaNs`, and sender `max_lateness_us`.

This diagnostic cannot prove a cause by itself: a zero cgroup throttle counter
does not rule out host descheduling or network stalls, and a browser receiver
long task remains a separate confounder. Do not use instrumentation for the
six-hour qualification run.
