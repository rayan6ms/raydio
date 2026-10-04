# Reproduction evidence — 2026-10-03

See [the audit](../BUG-AUDIT-2026-10-03.md) for impact, qualifications and repair
criteria. The eight tests assert the observed faulty behavior, not a corrected
implementation. They all passed. No production deployment was performed.

| Patch | Apply in | Result |
| --- | --- | --- |
| `raydio-reproductions.patch` | Raydio `308f343` | `raydio-tests.log`: four cases |
| `mantle-reproductions.patch` | Mantle `aba9bb1` or source-identical `a6919a2` | `mantle-tests.log`: three cases |
| `crust-reproduction.patch` | Crust `a229515` | `crust-tests.log`: one case |

`manifest.json` records full dependency pins and the SHA-256 of each source file
after exact restoration. The temporary test patches are the only code changes
used to obtain this evidence; no production-function instrumentation was added.

To replay in clean disposable checkouts, check and apply the relevant patch with
`git apply --check` and `git apply`, then run its command below. Use one build job
and keep the tests serial. Do not apply them over unrelated modifications.

```sh
# Run in the matching repository, after applying its patch.
env -u APPIMAGE -u APPDIR -u ARGV0 -u PYTHONEXECUTABLE -u __PYVENV_LAUNCHER__ \
  CARGO_BUILD_JOBS=1 cargo test --locked --offline --lib audit_ -- --nocapture --test-threads=1

# Mantle
env -u APPIMAGE -u APPDIR -u ARGV0 -u PYTHONEXECUTABLE -u __PYVENV_LAUNCHER__ \
  CARGO_BUILD_JOBS=1 cargo test --locked --offline -p mantle-media --lib audit_ -- --nocapture --test-threads=1

# Crust
env -u APPIMAGE -u APPDIR -u ARGV0 -u PYTHONEXECUTABLE -u __PYVENV_LAUNCHER__ \
  CARGO_BUILD_JOBS=1 cargo test --locked --offline -p crust-server --test p17_security_resources audit_ -- --nocapture --test-threads=1
```

The Raydio cleanup case deliberately injects an already-successful preparation
result and exercises actual cleanup/JoinSet and HTTP cancellation behavior. It
then applies the same unconditional assignment as the actor's result arm. It is
not an end-to-end Discord-loop test or a captured production race. The watchdog
case models an expired deadline directly, then delivers progress and calls the
actual session tick; it does not induce a live network outage.

The OAuth case holds the real manager lock and synchronizes the waiter's initial
cancellation check. It proves uncancellable lock contention without token traffic.
The admission case uses FakeMantle to isolate HTTP permit policy; the report traces
the real adapter's encoded Play into network discovery/opening separately.
