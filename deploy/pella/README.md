# Pella Testbot experiment

This deployment is not qualified for production. On 2026-09-08 Pella's free
100 MB server required renewal after 24 hours using changing advertisement
links. No supported unattended renewal was established. A three-minute audio
test also had repeated interruptions; see `evidence/pella-screen-receiver.json`.

Create a ZIP with `main.py` and the empty `requirements.txt` at its root. Select
Discord Bot / Python and main file `main.py`; select only the Free tier. Set
only `DISCORD_TOKEN_TESTBOT` through Environment Variables. Never upload the
legacy repository's entire `.env`. Stop any other Testbot before starting this
deployment. The launcher uses the Python standard library only and replaces
itself with Rust using `execve`, leaving no permanent Python process.

The pinned release archive and native executable both have verified SHA-256
checksums. Downloads are size-limited and extraction admits only the expected
regular binary member. The x86-64 candidate requires a compatible Linux glibc;
the observed Pella Python image had glibc 2.41. Local checks covered both a
cached binary and a fresh real release download, replacing `execve` with a
mock to avoid starting a duplicate bot. The first launcher wrongly expected
`bin/raydio` instead of the archive's `./bin/raydio`; this was reproduced and
fixed before the audio test. Initial creation also returned a generic
"Failed to start"; a minimal Python probe and subsequent redeployment worked.

The test account created one free server, `raydio-testbot`, and selected no
paid resources. Runtime showed authenticated readiness and actual YouTube
playback. The server was stopped after measurement. The dashboard's plot
alone did not establish exact process RSS/PSS or CPU usage.
