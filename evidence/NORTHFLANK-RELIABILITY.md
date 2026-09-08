# Northflank candidate — 2026-09-08

The Developer Sandbox project `raydio-test` in US Central (Council Bluffs)
successfully ran Testbot using `deploy/testbot.Dockerfile`, build
`tiny-companion-1626`, repository commit `d9f28ff`. The image downloads the pinned
`v0.2.2-rc.1` native binary, whose source is `90bef68`; a packaging commit is not
a new audio implementation. Runtime allocation: one instance, 0.1 shared vCPU,
256 MB memory, 1 GB ephemeral storage. These are limits, not measured usage.

## Initial receiver screen

`northflank-screen-receiver.json` records 179.9995 seconds from
2026-09-08T15:04:37.052Z, using the controlled Discord browser as a muted
listener in test / General. Track: Never Gonna Give You Up, volume 70, loop on.

- 9,000 received packets; zero net loss, positive loss deltas, discards or NACKs.
- Zero concealed or silently concealed samples in the measurement window.
- Zero clipped/near-full-scale, empty or non-finite PCM samples.
- Longest quiet region: 10 ms; no unexpected silence events.
- Three receiver long tasks, 190 ms total, maximum 79 ms; zero missing PCM
  reports or stale polling intervals. Retain these receiver confounders.
- Track positions approximately 26–206 seconds: **no loop boundary covered**.

This is a promising short transmission result compared with the latest Oracle
ten-minute sample (632.292 ms concealment, seven discards, 22 NACKs), but the
durations and times differ. It proves neither a causal host advantage nor
six-hour reliability. Northflank's Observe charts did not supply usable CPU/RAM
measurements during this check. No resource-usage improvement is claimed.

## Ten-minute repeat check

`northflank-repeat-receiver.json` records 599.9998 seconds from
2026-09-08T16:51:48.300Z using the same native candidate and free allocation,
pod `raydio-7dcbbf7b76-zrhff`. Pella was stopped before this run. No builds,
deployments or playback controls were used inside the measurement window.

- 29,883 packets; 2 lost, 8 discarded, 38 NACKs.
- 2,906.771 ms concealment, including 2,099.729 ms silent concealment.
- No clipping, non-finite samples, empty PCM frames, missing PCM reports or
  stale polls. Browser long tasks: 25, totaling 1,748 ms, maximum 99 ms.
- Unexpected quiet events: 75.3125 ms at elapsed ~21 seconds, 1,443.146 ms
  at ~167.9 seconds, and 653.417 ms at ~174.2 seconds. Speaking-indicator
  changes occurred alongside these. The latter gaps preceded the first repeat.
- Two repeat boundaries (~194.55 and ~407.94 seconds). Their ~942/975 ms quiet
  tails resemble the previously measured source ending. The panel clock was
  stale at the second tail (205 seconds), illustrating why phase labels alone
  do not distinguish source silence from an interruption.

After the window, `/diagnostics` showed no track failures or watchdog recovery,
but six transient player-edit failures. Its **last** audio window reported 3,000
sent / zero unavailable / zero missed deadlines; that window does not describe
the entire run. On leaving voice at 17:02:41.684806Z, sender lifetime counters
reported 33,646 frames sent, 9 silence/unavailable frames, 108 skipped deadlines,
zero send failures or source overruns, maximum lateness **1,640,992 us**. These
counters include warm-up and post-measurement time and cannot be equated to
receiver-window totals. They independently establish sender scheduling delays;
they do not identify CPU quota, hypervisor scheduling or a particular lock as
the cause. A browser-only explanation is insufficient.

This longer run **fails audio continuity** despite the clean initial screen.
Do not promote this deployment or claim six-hour readiness. The latest Oracle
ten-minute sample had less concealment (632.292 ms), but different capture
times still prevent causal host rankings.

## One-worker configuration experiment

The same release binary was restarted with `RAYDIO_WORKER_THREADS=1`, verified
in the saved environment editor, with the same 0.1 vCPU / 256 MB allocation.
An initial editor submission saved an empty value; the bot correctly rejected
it before login. This was corrected and authenticated readiness confirmed at
17:11:23.396916Z before playback or measurement. No failed startup was included
in the audio comparison.

`northflank-one-worker-receiver.json` covers 600.0002 seconds beginning
17:12:24.016Z. No controls, builds or deployments occurred inside the window.

| Receiver metric | Two workers, 10 min | One worker, 10 min |
| --- | ---: | ---: |
| Packets received | 29,883 | 29,871 |
| Net lost packets | 2 | 7 |
| Discarded packets | 8 | 9 |
| NACKs | 38 | 88 |
| Concealment, ms | 2,906.771 | 2,901.042 |
| Silent concealment, ms | 2,099.729 | 1,531.146 |
| Longest quiet interval, ms | 1,443.146 | 1,180.646 |
| Clipping / empty PCM / non-finite | 0 | 0 |

One worker still produced large mid-track gaps. It had 26 browser long tasks,
1,850 ms total, maximum 103 ms, with no missing PCM reports or stale polls.
Sender lifetime at 17:22:50.982730Z: 31,935 frames sent, 5 silence/unavailable
frames, 104 skipped deadlines, no send failures or source overruns, maximum
lateness 1,432,444 us. The lifetime extends beyond the receiver window.

This is **not a successful optimization**. Concealment was nearly unchanged,
packet loss/NACKs increased, and >1-second gaps remained. Different pods and
times are confounders; no causal claim about worker count is warranted. Restore
two workers, keep the test service stopped outside experiments, and do not
qualify either configuration for six hours. CPU/RAM plots were unusable and
the shell UI stayed disconnected; no measured memory improvement is claimed.
The next useful diagnostic is time-aligned cgroup CPU throttling, scheduler
delay and process resource sampling, alongside sender and receiver counters.

## Free-plan verification

The team billing UI showed Developer Sandbox ($0/month), an active card and
$0 usage. Service billing showed "No usage" and no accrued costs. Its card
verification dialog stated that Developer Sandbox usage would not be charged.
The resources UI confirms "Autoscaling is not available on free projects."
No paid plan, addon, persistent volume, additional instance or BYOC selected.

The authenticated project-creation selector was also checked with all 17 regions
visible. Brazil (`southamerica-east`, Osasco) explicitly requires "Upgrade to pay
as you go to use this region." Only US Central (Council Bluffs) and Europe West
(London) lacked this restriction. No new project was submitted or paid region
selected. The official region documentation lists Brazil but does not itself
establish free-tier availability:
https://northflank.com/docs/v1/application/run/deploy-to-a-region.md

Official documentation says a card will not be charged until paid services are
created and used. The $50 billing threshold is an invoice trigger, **not a hard
spending cap**. Alerts are notifications, not enforcement. No hard $0 account
cap has been established, and this report does not guarantee future provider
terms or protect against future paid configuration changes.

- https://northflank.com/docs/v1/application/billing/add-a-card.md
- https://northflank.com/docs/v1/application/billing/billing-thresholds.md
- https://northflank.com/docs/v1/application/billing/monitor-spending.md

The service was scaled to zero after the screen before attempting Pella,
preventing duplicate Testbot sessions. Production Oracle was not changed.
CI/CD follows `rewrite/rust-raydio`: never push during an audio measurement
unless automatic deployment has first been disabled.
