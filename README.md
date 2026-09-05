# Raydio

A lightweight Discord music bot written in Rust, powered by
[Crust](https://github.com/rayan6ms/crust), [Mantle](https://github.com/rayan6ms/mantle),
and [Oto](https://github.com/rayan6ms/oto).

Raydio runs as one process. It plays YouTube audio with Discord's encrypted voice
transport, including private voice channels. It includes the original 19 slash
commands, seven player buttons, autocomplete, playlists, bounded queues/history,
track and queue loops, volume, progress panels, permission checks, diagnostics,
reconnection handling, and idle/alone cleanup.

The TypeScript implementation is preserved on
[`legacy/typescript`](https://github.com/rayan6ms/raydio/tree/legacy/typescript)
and in Git history. This branch contains the bot, its tests, and its deployment tools.

## Run

Download a native Linux release from [Releases](https://github.com/rayan6ms/raydio/releases).
Use `aarch64` on Oracle Ampere A1 and `x86_64` on Intel/AMD. Packages target
Ubuntu 24.04 or newer (glibc 2.36+); no JVM, Node, ffmpeg, or compiler is needed on the server.

```sh
cp .env.example raydio.env
# Set DISCORD_TOKEN in raydio.env.
./raydio --env-file raydio.env
```

For boot startup, small-instance limits, verified updates, and rollback, follow
the [Oracle deployment guide](deploy/README.md). Tokens stay outside the repository.
Crust is embedded on an ephemeral loopback port with a random per-process password.

## Build and test

Install Rust 1.97.1, Git, a C/C++ toolchain, CMake, make, and CA certificates.
All dependencies are pinned to public Git revisions in `Cargo.lock`; sibling
checkouts are no longer required. Cargo fetches Mantle's pinned codec submodule.
The runtime uses two Tokio workers; build examples below use one compilation job.

```sh
CARGO_BUILD_JOBS=1 cargo test --locked --all-targets
cargo fmt --all -- --check
CARGO_BUILD_JOBS=1 cargo clippy --locked --all-targets -- -D warnings
CARGO_BUILD_JOBS=1 cargo build --locked --release
target/release/raydio --check
target/release/raydio --env-file /path/to/raydio.env
```

`--check` exercises the real embedded backend offline. `--probe-backend` also
checks live YouTube loading. `--testbot` explicitly selects `DISCORD_TOKEN_TESTBOT`.
See [.env.example](.env.example) for playback and queue limits.

CI builds and tests natively on ARM64 and x86-64 using pinned Debian 12 builder
images. Version tags publish binary archives with checksums, license notices,
source revision, and an install/update tool. The developer host's compiler cache
is not part of the distribution.

## Measured performance

The latest matched compiler experiment reduced the already optimized Rust bot:

| Workload | Previous Rust build | Size-optimized dependencies |
| --- | ---: | ---: |
| Authenticated idle PSS | 12.66 MiB | 12.04 MiB (−4.8%) |
| Active playback PSS | 18.05 MiB | 16.30 MiB (−9.7%) |
| Playback CPU, one core | 3.20% | 3.30% |

Idle uses three alternating process starts per build. Playback uses three
20-second windows, one stream at volume 70, looping, with an active listener.
These are shared-host measurements, not capacity guarantees or Oracle measurements.
The earlier tuned TypeScript + Lavalink stack measured 338.7 MiB idle PSS and
391.6 MiB during playback; those were separate experiments, not the same trial.

Fresh receiver captures validated advancing encrypted audio across each full
60-second window. Both builds had one net lost packet, no full-scale PCM samples,
and no non-finite samples. Small concealment events remained; this does not prove
zero glitches on every network. No fresh control-latency improvement is claimed.

See [performance evidence and limitations](evidence/PERFORMANCE.md) for exact
observations, withdrawn results, and reproduction commands. The bot suite passes
44 tests, including real-backend controls, reconnects, and service notification.
Earlier live tests exercised all 19 commands and seven buttons; the user confirmed
clear audible playback at volume 70.
