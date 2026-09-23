# Append-only collection and six-hour candidate run — September 22

Status: **completed with full receiver coverage; final 8.74 seconds overlapped premature evidence export**. See [results](QUEUED-AUDIO-WORKER-STREAM-RESULTS-2026-09-23.md), measured start **2026-09-22 19:37:48.268 UTC**, expected end **September 23 01:37:48.268 UTC / September 22 22:37:48 Brasília**. [Manifest](../evidence/queued-worker-stream-20260922/run-manifest.json).

This is the user's authorized follow-up after the prior run exposed collection interference. Only the diagnostic collection and recorder supervision changed. Testbot remains the same candidate binary, PID 53299, with detailed tracing enabled, the same looping track at volume 70, and the same connected receiver. No bot restart, new playback command, codec change or production promotion occurred. Raydio remains inactive and no local bot process is running.

## Collector change

The previous job reread and rewrote the complete growing journal every five minutes. Replaced it with two bounded-lifetime `journalctl --follow --no-tail` services that append each new entry once: bot/service logs and kernel logs. Both run at nice 19 and IOWeight 1, with 64 MiB/8-task limits, no automatic restart, and a seven-hour lifetime. There is no periodic full-history export, compression, or file rewrite during measurement.

Both preparation paths call `start_oracle_capture.sh`. Deploy this helper to `/opt/raydio/diagnostics/start_oracle_capture.sh` and the updated sampler to `/opt/raydio/diagnostics/endurance_host.py` before using either path. These exact files are installed on Oracle for this run. The attach path checks the sole running bot and binary hash; it does not restart playback. Its seven-hour maintenance restoration is independently scheduled before masking units.

The minute sampler now reads collector cgroup CPU, memory, memory events and liveness, and stats the output files for byte count and modification time. Missing cgroups/files become explicit errors. The trace's packet indices and periodic checkpoints remain available to detect missing diagnostic coverage. A collector exit does not silently restart and reread history. Final service outcomes and collector lifecycle are exported once after the measurement, not repeatedly during it.

The combined first-minute collector cost was **0.026528 CPU seconds over 60.003 seconds**, or **0.04421% of one core**. The journal follower charged 7.21 MiB and kernel follower 2.58 MiB to their cgroups, including charged cache; those are collector figures, not bot PSS. Service-log output advanced from 11,596 to 319,535 bytes, with zero collector OOM events. These are startup qualification figures; continued cost and output progress are measured throughout the run, not assumed from one minute.

The change removes the known repeated-full-export mechanism. It does not establish zero instrumentation effect: per-packet tracing and continuously formatting/appending new records still have overhead. Keeping those settings equal to the previous candidate isolates the collection-method change more closely; different host/network conditions still limit causal comparisons.

## Recorder and verification

The connected Discord receiver is reused. Persistent PCM/WebRTC aggregates, event/window archives and independent receiver-host samples are active. The session supervisor still archives failures before observing a replacement peer. Fixed an edge case where repeated failed reattachments could create overlapping open gaps: they now retain one gap starting at the original failure until recording resumes or the deadline ends.

Passed: session supervisor simulations including repeated preflight failures; existing browser checkpoint and six-hour endurance simulations; seven Python persistence tests; shell syntax and Python compilation checks. Live Oracle integration verified both follower units, advancing log output, minute collector metrics and no collector errors. Live receiver verification confirmed the actual new report identity, advancing RTP/PCM, loop/volume, independent host samples and enough collector/inhibitor lifetime.

Evidence lives in local `evidence/queued-worker-stream-20260922/six-hour` and Oracle `/var/lib/raydio/queued-worker-stream-20260922`. `collector-preflight.jsonl` and `collector-overhead.json` retain the overhead qualification. The run manifest fingerprints deployed diagnostic sources separately from the unchanged bot binary.

## End-of-run analysis

First establish full receiver and sender coverage, including any failed/rearmed segments. Inspect collector liveness, CPU/memory evolution and output byte progression; a stalled or failed follower invalidates an unsupported continuity claim. Compare six-hour gap rates, concealment, packet loss, quiet classification and resource use with the previous candidate capture method. Use within-window deltas because the process/playback predate this measurement. Retain natural source-tail candidates and every unexplained interruption.

This run is not a matched worker/default comparison. Even a better result would first support the collector correction, not prove a benefit from the experimental worker. Production remains unchanged until the results are reviewed.
