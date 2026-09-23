# Default audio implementation: matched six-hour observation

**Result:** the observation ended with gaps after receiver failure and a later bot DAVE timeout. See [the results and qualified comparison](DEFAULT-AUDIO-WORKER-RESULTS-2026-09-23.md). The following records the original preparation.

The default implementation was started on Oracle with the experimental audio worker disabled. This was a comparison run, not a production promotion. Only Testbot ran; production Raydio remained disabled and inactive.

- Recording: September 23, 2026, **02:30:49.945–08:30:49.945 UTC**, or **23:30:49.945 September 22–05:30:49.945 September 23 Brasília**.
- Run: `default-worker-stream-20260923`; Oracle PID `58789`.
- Same bot audio source revision `e7db90e` and pinned Oto/Crust/Mantle revisions as the worker-enabled run. Release built with `--locked --no-default-features`; fingerprints confirm no experimental worker. Startup independently reports `isolated_audio_worker=false`.
- Binary SHA-256: `61b10d0617fef197d10fccb2bb02c71a51daacf615c554b7114f7bd4a3490403`; 18,682,384 bytes.
- Same song, volume 70, Loop ON, two runtime threads, sender trace enabled, continuous append-only journal followers and minute resource sampling. No audio code or diagnostic collection parameters changed.
- Receiver persistence verified against the actual advancing recording, with two independent host samples and sufficient remaining collector lifetime. Browser receiver/PCM, scheduling, segment history, checkpoints, Oracle sender trace, bot/host resources and collector overhead are collected autonomously.
- Local sleep inhibitor and bounded Oracle maintenance masks are active. Independent restoration is scheduled after seven hours. These reduce known disruptions; they cannot guarantee uninterrupted internet, browser or shared-VM scheduling.

Validation before recording: backend `--check` passed on Oracle; 50 library tests, one binary test and six export-guard tests passed. All local builds/tests finished before measurement.

## Collection after completion

Do not export, compress, restart or change playback during recording. Export only after **08:31:49.945 UTC**, and after the persisted session and final receiver segment are terminal:

```sh
uv run --no-project python benchmarks/collect_completed_run.py \
  evidence/default-worker-stream-20260923/run-manifest.json
```

The command enforces both conditions, validates session identity and the final archived segment, takes a fixed-byte snapshot, and transfers an uncompressed archive without stopping Testbot. It refuses to overwrite an existing archive. A failed or interrupted terminal run can be preserved after the deadline, but must not be called a successful six-hour run.

## Interpretation

Compare against `queued-worker-stream-20260922` using identical durations and counter definitions: sender gaps, receiver losses and positive/corrected loss deltas, discarded packets, concealment, quiet intervals, source transitions, CPU, PSS and collector overhead. Song boundaries and known source silence must remain distinct from unexpected mid-track silence.

The preceding worker-enabled run had 8.738505 seconds of premature-export interference at its end. Preserve its full totals and separately label comparisons excluding that contaminated interval; do not silently discard incidents. This default process is fresh whereas the preceding worker process was warm. Network and shared-VM conditions also vary. One pair of runs can inform a decision but does not isolate every cause or prove a guarantee of zero interruptions.

The follower's 64 MiB cgroup memory limit remains unchanged for comparability, including cache charging/reclaim risk. Analyze sampled collector CPU, memory events and file progress before attributing differences to the worker.

Detailed identities and diagnostic hashes are in [the run manifest](../evidence/default-worker-stream-20260923/run-manifest.json). No production decision has been made.
