# Raydio — Rust rewrite

Work in progress on branch `rewrite/rust-raydio`, in a separate Git worktree at
`/home/rayan/Documents/Projects/raydio-rust`. The original TypeScript bot remains on `main` in
`/home/rayan/Documents/Projects/raydio`. Legacy deployment scripts, TypeScript source/tests, and
historical roadmaps are excluded from this branch; Git history and the original checkout preserve them.

**Blocked on a verified Mantle YouTube loading regression.** Give [MANTLE_HANDOFF.md](MANTLE_HANDOFF.md)
to Mantle's Codex. This checkout is not yet a working replacement for the Discord bot.

The intended runtime is one Rust process: Twilight for Discord; private, embedded Crust for player
orchestration; Mantle for YouTube/media; Oto for Discord voice and DAVE. Crust binds an ephemeral
loopback port using a random process-local password. No public music-service port or JVM is needed
by the new runtime. All three local sibling projects are used through Cargo path dependencies;
Mantle's git dependencies in Crust are overridden to the local Mantle checkout. The supported
revisions used for the current checks are recorded in [evidence/revisions.json](evidence/revisions.json).

## Implemented and checked so far

- Real Crust/Mantle/Oto dependency integration and explicit backend shutdown.
- Lavalink v4 WebSocket session creation and server-issued session IDs, with bounded event delivery
  and reconnect/session invalidation handling. Basic live backend lifecycle is covered by integration tests;
  reconnect/failure behavior still needs dedicated integration tests.
- Definitions for all 19 original slash commands and the original help text.
- Queue, track/queue loops, skip, previous, jump, move, remove, clear, shuffle, bounded history,
  queue admission, and three-failure recovery policy.
- Original playback configuration defaults with explicit test-bot token selection.
- YouTube-only input classification, playlist precedence, resolver filtering, and result limits.
- Player and paginated queue view rendering, including the seven player buttons, artwork, progress,
  and Unicode-safe length limits.

Discord command execution, voice handshake/cache/permission handling, stale interaction enforcement,
concurrent play cancellation, timers, autocomplete, panel refresh ownership, diagnostics, and live
Discord tests are still pending. Do not infer completion of those features from the pure policy/view
modules or from command registration data.

## Build and verification

Requirements: Rust 1.97.1+, C and C++ toolchains, CMake, make, and the sibling `crust`, `mantle`, and
`oto` repositories (including their required submodules). Cargo is limited to one compilation job;
the integrated runtime uses two Tokio workers. Upstream native codec build scripts may use two jobs.

```sh
cargo fmt --check
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo run -- --probe-backend
cargo run --example mantle_load_probe
cargo run --example media_probe
```

The explicit backend probe performs read-only YouTube metadata/search requests. The examples perform
the documented metadata/frame checks. They do not read `.env`, log into Discord, or alter bot commands.

On this particular host, the available compiler is Mantle's existing cached toolchain. The following
process-local environment was used successfully; it changes neither T3 Code nor sibling source:

```sh
mkdir -p target/toolchain-libs
ln -sf /usr/lib64/libstdc++.so.6 target/toolchain-libs/libstdc++.so

env -u APPIMAGE -u APPDIR -u ARGV0 \
  CC="$PWD/../mantle/.cache/media-toolchains/xaac-root/usr/bin/cc" \
  CXX="$PWD/../mantle/.cache/media-toolchains/xaac-root/usr/bin/c++" \
  LD_LIBRARY_PATH="$PWD/../mantle/.cache/media-toolchains/xaac-root/usr/lib64" \
  LIBRARY_PATH="$PWD/target/toolchain-libs" \
  cargo test --all-targets
```

Use that same environment for other Cargo commands that build native dependencies. Prefer an
installed compiler for normal development; these cache paths are an environment-specific workaround.

## Performance status

A valid end-to-end comparison is pending completion and playback parity. Earlier 98 MiB versus 9 MiB
figures compared different failed startup paths and **do not establish a performance improvement**.
The final comparison must include the complete original Node + Lavalink stack and the complete Rust
bot under the same idle, playback, and queue/control workloads, with repeated startup time, CPU,
RSS/PSS, and command latency measurements. Any source failures must be reported separately.

The original suite passed 149 tests before isolation. Rust verification results and the current source
compatibility blocker are recorded under [evidence](evidence/).
