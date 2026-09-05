# Raydio — Rust rewrite

Work in progress on branch `rewrite/rust-raydio`, in a separate Git worktree at
`/home/rayan/Documents/Projects/raydio-rust`. The original TypeScript bot remains on `main` in
`/home/rayan/Documents/Projects/raydio`. Legacy deployment scripts, TypeScript source/tests, and
historical roadmaps are excluded from this branch; Git history and the original checkout preserve them.

The Discord runtime now authenticates and registers all 19 commands. Mantle's direct-video metadata
regression is fixed, and Crust player volume now reaches the audio path. Live voice playback and
performance under playback are still unverified; this is not yet declared a complete replacement.

The runtime is one Rust process: Twilight for Discord; private, embedded Crust for player
orchestration; Mantle for YouTube/media; Oto for Discord voice and DAVE. Crust binds an ephemeral
loopback port using a random process-local password. No public music-service port or JVM is needed
by the new runtime. All three local sibling projects are used through Cargo path dependencies;
Mantle's git dependencies in Crust are overridden to the local Mantle checkout. The supported
revisions used for the current checks are recorded in [evidence/revisions.json](evidence/revisions.json).

## Implemented and checked so far

- Real Crust/Mantle/Oto dependency integration and explicit backend shutdown.
- Lavalink v4 WebSocket session creation and server-issued session IDs, with bounded event delivery
  and reconnect/session invalidation handling. Real backend lifecycle and resumable/replaced
  connections are covered by integration tests.
- Definitions for all 19 original slash commands and the original help text.
- Queue, track/queue loops, skip, previous, jump, move, remove, clear, shuffle, bounded history,
  queue admission, and three-failure recovery policy.
- Original playback configuration defaults with explicit test-bot token selection.
- YouTube-only input classification, playlist precedence, resolver filtering, and result limits.
- Player and paginated queue view rendering, including the seven player buttons, artwork, progress,
  and Unicode-safe length limits.

The runtime includes serialized guild commands, FIFO source requests with stop/leave cancellation,
voice state and permission checks, autocomplete, stale panel protection, presence, diagnostics,
watchdogs, and idle/alone cleanup. Deterministic tests exercise controls through real Crust with
its media/voice test fixtures; a separate integration test starts all real backends. Live testbot
login and command registration passed. The current live audio probe joins voice but waits for
DAVE group establishment; receiving-participant verification remains pending.

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

To run the bot:

```sh
cargo run --release -- --env-file /path/to/raydio.env
cargo run --release -- --testbot --env-file ../raydio/.env
```

The production token is `DISCORD_TOKEN`; `--testbot` explicitly selects `DISCORD_TOKEN_TESTBOT`.
See [.env.example](.env.example) for playback settings. The optional
[systemd user service](deploy/raydio.service) runs a release binary from `~/.local/bin/raydio`
and reads `~/.config/raydio/env`; installation is not performed automatically.

The backend probe and `mantle_load_probe`/`media_probe` examples perform read-only YouTube metadata
and frame checks. `media_probe` exercises the bot’s default volume of 70. The opt-in
`discord_voice_probe` reads a specified test environment file, verifies the dedicated testbot identity,
joins General and private-vc in the authorized test server, and cleans up its voice connection.
It requires a receiving participant to verify encrypted playback:

```sh
cargo run --example discord_voice_probe -- ../raydio/.env
```

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

Nine authenticated idle runs (three per profile, rotating order) compare the complete Rust bot
with the complete original Node + Lavalink stack. Medians across trials:

| Stack | Idle PSS | Idle RSS | Startup | Threads |
| --- | ---: | ---: | ---: | ---: |
| Rust | 14.8 MiB | 17.6 MiB | 2.56 s | 4 |
| Node + Lavalink, tuned | 338.7 MiB | 346.6 MiB | 8.82 s | 42 |
| Node + Lavalink, ordinary | 496.5 MiB | 504.4 MiB | 8.17 s | 117 |

Rust uses **95.6% less idle proportional memory than the tuned original** in this measurement.
The release binary is 33.2 MiB. PSS apportions shared pages; original measurements sum
both processes. Each run waits for bot/backend/command registration readiness, warms up for five
seconds, then samples for 15 seconds. Node is v24.19.0; Lavalink is 4.2.2 with YouTube plugin 1.18.2.
The tuned JVM uses `-Xms64m -Xmx192m -XX:ActiveProcessorCount=2`. The ordinary profile uses its normal
processor defaults with a 512 MiB Java heap safety cap. This is a shared host with warm OS caches;
startup includes Discord network requests. Idle CPU differences are near the measurement resolution.

These results establish an idle-memory improvement, not playback or command-latency parity.
Matched playback/interaction measurements remain pending live verification. Earlier failed-startup
figures have been withdrawn and are not used here. Full observations, revisions, binary hash, and
limitations are in [evidence/idle-performance.json](evidence/idle-performance.json). Reproduce with:

```sh
uv run --no-project python benchmarks/compare_idle.py --env-file ../raydio/.env --node /path/to/node
```

The original suite passed 149 tests before isolation. The Rust suite now passes 38 tests (36 unit
and guild-control tests, one real-backend lifecycle test, and one reconnect test); formatting and
Clippy pass. Dependency corrections are committed locally as Mantle `8be808b` and Crust `df19a6d`.
Rust verification results and source compatibility evidence are recorded under [evidence](evidence/).

Remaining live checks are receiving-participant playback in General and private-vc, slash commands
and buttons through Discord, and matched playback/interaction performance. The available testbot
credentials authenticate correctly. The current empty-channel probe reaches voice transport
readiness but waits in Oto’s `EstablishingDave` state. It does not prove an Oto defect: group
establishment with a listener still needs verification. The browser execution tool required to
operate the authenticated Discord client is unavailable in this session. No encryption bypass or
production cutover has been introduced.
