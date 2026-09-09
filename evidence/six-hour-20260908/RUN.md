# Oracle latest-candidate six-hour attempt

Status: **not qualified**. Receiver disconnected after 94 minutes; the sender
later failed with DaveTransition. See [RESULTS.md](RESULTS.md). The remaining
contents below preserve the original setup record, not a pass result.

- Receiver start: 2026-09-08T21:01:42.948Z (18:01:42 Sao Paulo).
- Expected end: 2026-09-09T03:01:42.948Z (00:01:42 Sao Paulo).
- Candidate source: `90bef68`, release `v0.2.2-rc.1`.
- SHA256: `4e1deea5c1179edb92f0ec6eb708ed67fdd73ce83ea19750b7b26539b2ad8ac3`.
- Oracle: existing Always Free Micro 137.131.202.133, fault domain 2.
- Unit: `raydio-event-wake-six-hour.service`, PID 3063, two workers.
- Binary: `/opt/raydio/candidates/event-wake/bin/raydio`.
- Testbot only; production `raydio.service` remains PID 876, v0.2.1.
- Track: dQw4w9WgXcQ, volume 70, loop enabled, test / General.
- Authenticated browser listener: migole, muted; controlled tab `tab_1`.

## Verified preflight and interference controls

The initially invoked old owned-channel unit was stopped before this measured
window. Its setup playback/sampler do not belong to this attempt. The correct
binary passed its checksum and offline `--check`. The process environment was
verified as two workers, explicit Testbot token, and no LD_PRELOAD. CPU quota and
runtime limit are infinity; Restart=no preserves failures instead of hiding
them. There is no automatic stop at six hours: Testbot is left running for review.
No other Testbot or diagnostic probe was running on Oracle at final preflight.
NTP was synchronized; 42 GB disk and approximately 577 MiB RAM were available.

Oracle apt-daily, apt-daily-upgrade and fwupd-refresh timers were paused and
scheduled for automatic restoration seven hours after preparation (about
03:59 UTC). Other standard OS services remain present; this is not a bare VM.
No SSH, builds, packet interposers, timer stress probes or controls are planned
inside the measured window. Normal production remains online and idle; new
production playback during the test would be additional host load to disclose.

Local systemd units `raydio-receiver-awake` and `raydio-receiver-checkpoints`
run independently of the assistant turn, bounded to seven hours after setup.
The former holds a sleep/idle inhibitor. The latter listens only on 127.0.0.1,
accepts Discord-origin audit JSON up to 4 MiB and atomically replaces the latest
checkpoint. Preflight verified an actual browser upload and rejection of an
unrelated origin/malformed audit. Available local RAM was over 10 GiB. No local
build/stress job is running. Browser scheduling/visibility/PCM gaps are recorded
to distinguish receiver interference from bot faults. These controls cannot
guarantee the local internet connection, power, browser or cloud scheduler.

## Retained evidence and retrieval

- Local `receiver.json`: complete aggregate audit as of the latest checkpoint,
  saved every minute and once on completion/failure. Contains receiver counters,
  minute bins, quiet intervals, speaking transitions, track repeats, clipping,
  browser long tasks and stale/missing measurement intervals. No audio recording.
- Local `checkpoints.jsonl`: persistence timestamps, status, elapsed time and size.
- Browser: `window.raydioEndurance.summary()` and `.report`;
  `window.raydioCheckpoint` retains save/error/serialization timing counters.
- Oracle `/var/lib/raydio/event-wake-six-hour-20260908/`: manifest,
  maintenance record, `resources.jsonl` (minute CPU/PSS/RSS/cgroup memory and host
  steal counters, low priority, seven-hour bound).
- Oracle timer `raydio-six-hour-save-20260908` saves `service.log`, `kernel.log`
  and `final-service.txt` around 03:15 UTC, after the six-hour receiver window.
  Journald retains logs independently before that snapshot.
- After the user returns, retrieve evidence before any restart or tab navigation.
  Require completed status, at least 21600 seconds, advancing packets and intact
  PCM/poll coverage. Review every quiet/speaking event against source tails;
  do not treat concealment alone as audible silence or hide positive loss.
- Sender lifetime counters flush on explicitly stopping/leaving Testbot after
  evidence retrieval; they include setup and post-window playback and must not
  be equated to receiver-window totals. The bot intentionally remains running.

Keep T3 and this Discord tab open and the listener connected. Do not reload,
deafen/disconnect, change tracks or controls, or run heavy work on the receiver.
If a receiver peer is replaced/disconnected, the audit records failure rather
than automatically resuming and claiming an uninterrupted six-hour run.

## Northflank retirement

API verified the raydio service at zero instances with CI disabled. Billing UI
showed Developer Sandbox and $0.00 usage. Card removal is blocked: the only card
is the default and its Delete button is disabled. Official documentation says
the default cannot be removed without selecting another payment method:
https://northflank.com/docs/v1/application/billing/add-a-card.md

No replacement card was added, no paid resource was used, and no account/team
was deleted. Actual removal remains unresolved and requires provider support
or a separately authorized account closure. No support message has been sent.
