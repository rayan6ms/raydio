# Final six-hour Oracle evidence — 2026-09-12

This directory is the preserved result of the final candidate's 21,600-second Oracle Testbot run. See [`FINAL-SIX-HOUR-COMPARISON-2026-09-12.md`](../../docs/FINAL-SIX-HOUR-COMPARISON-2026-09-12.md) for interpretation and comparison.

`receiver.json` and `summary.json` have complete receiver/PCM/event coverage. `service.log` records the isolated sender; `resources.jsonl` records the independent host sampler; `receiver-host.jsonl` records receiver-side persistence health. `post-test-state.txt` proves both production and isolated services were stopped after collection and records the verified running binary hash.

The observation is valid but does not pass a strict uninterrupted-transport gate: two brief ICE/connection transitions and several mid-track packet/concealment bursts were retained. Sender failures and source overruns remained zero. Natural track-tail quiet is classified separately; all quiet remains present in the raw report.
