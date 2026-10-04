# Audit rollout requalification and precautionary rollback — October 4, 2026

**Production remains on the previous exact release, `c4654c5`.** The coupled
October 4 audit runtime changes have been withdrawn from `main` and the Rust
rewrite branch, and preserved on `candidate/audio-audit-20261004` at `2d8464d`.
Browser preparation and collector corrections remain in place. This is a
precautionary rollout reversal, not a claim that a specific source change caused
the earlier concealment spike or that rollback eliminates Oracle scheduling gaps.

The prior acceptance relied on targeted fault reproductions and successful
functional playback. That did not clear the requested comparative audio-quality
gate. Its acceptance statement is superseded by this report.

## Repeated comparison

Executed four five-minute recordings in A–B–B–A order. A is the saved previous
native binary at `c4654c51ed67a77aa8145abad52c396f28b7c2a4`; B is the audit
binary at `d2d3fad01346c526546c7e54ed122a58f944ad70`. No rebuild occurred
between recordings. Restarted the sole bot before each window. Testbot remained
inactive. Service unit files are identical and all four environment digests match.

All runs used the same Oracle instance, Discord test/General/#chat, signed-in
browser, exact `4moWSMi1L_4` URL, volume 70, Loop ON and ordinary WebRTC buffering.
Playback began through real slash-command UI interactions. Recordings began at
approximately 35–38 seconds into the track. Each observed a natural loop boundary.
All media downloads finished before the recording started; logged source size is
4,167,934 bytes in every run. The October 2 independent source quiet reference is
reused, without claiming a fresh digest match.

All four have complete receiver/PCM/speaking/track-phase/event coverage, complete
1 Hz Oracle/local host coverage under the declared 3 s slack, and successful
independent checkpoint persistence. No builds, source probes, packet captures,
other-guild commands or player controls occurred during recording. Browser
main-thread long-task counts were zero. The firmware-check timer scheduled for
the final baseline was deferred between recordings and restored afterward;
ordinary sysstat sampling was retained. Evidence was not rejected because of
host contention.

| Window | Build | Duration | Concealment | Discards | Sender gaps >40 ms | Skipped deadlines | Host steal |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A1 | Previous | 300.000 s | 29.125 ms | 0 | 0 | 0 | 0.147% |
| B1 | Audit | 300.000 s | 393.854 ms | 6 | 3 | 7 | 0.280% |
| B2 | Audit | 299.999 s | 125.813 ms | 6 | 0 | 0 | 0.159% |
| A2 | Previous | 300.180 s | 604.125 ms | 1 | 12 | 18 | 0.485% |

Sender counts cover each recording's interior minute-checkpoint interval,
approximately four minutes, not its unobserved head/tail. Exact coverage is
retained in each summary. Each build has approximately eight minutes of these
interior sender deltas and ten minutes of complete receiver recording.

Across both repetitions, previous/audit totals are:

- Concealment: **633.250 / 519.667 ms**. Duration-normalized rates are
  **63.306 / 51.967 ms per minute**, an observed 17.912% lower rate for B.
- Sender gaps >40 ms: **12 / 3**; skipped deadlines: **18 / 7**.
- Discarded packets: **1 / 12**.
- Net RTP loss: **0 / 0**. Positive/negative counter corrections are **+2/−2**
  for each build; zero net loss is not zero source-time omission.
- Silent concealed audio: **zero in all four windows**. No sender gaps >100 ms,
  source unavailable/overrun/send failures, disconnects, clipping, non-finite
  samples, empty PCM or off-boundary quiet intervals of at least 100 ms occurred
  in the recorded evidence.

Each recording contains the same 2,258.063 ms quiet interval at its natural
loop boundary, compatible with retained source head/tail duration. It remains a
source-tail candidate, not a proven fresh waveform match. It is retained and
separated from unexplained quiet rather than counted as a proven failure.

## Archive identity correction

A1's raw archive also contains an earlier completed candidate report from
13:42 UTC, saved by the checkpoint timer during preparation, before A1 began.
It is retained as
`a1/receiver-final-005c7e4eef4c92421792cb8133680365bd8f307ce3ad3663910a85c176de5537.json`.
Its `requestedAt` is `2026-10-04T13:42:16.986Z`; actual A1 is
`2026-10-04T15:17:19.771Z`. No receiver totals were taken from that prior report.
The summarizer already filters event/window/checkpoint archives by report
identity and host samples by recording time, and persistence verification
matched the actual advancing A1 report. All four have **seven saves belonging
to their own run**; A1's collected file additionally contains the prior save.
Corrected the comparison's A1 checkpoint count from eight raw rows to seven
matching saves. Its audio metrics and coverage are unchanged.

Checkpoint installation now ignores the initial terminal report. New failed
preflights remain eligible, as do already-running observations when recovering
the collector. Regression checks cover all three terminal states, attachment to
a running report, new preflights, retries, deduplication and final persistence.
All eight Bun browser-diagnostic test programs and ten Python collector/summary
tests pass. This correction affects
observation persistence only and does not change the restored audio runtime.

## Interpretation and decision

The paired direction reverses: B1 is worse than A1, while B2 is better than A2.
The previous build itself varies from 29 to 604 ms concealment and zero to twelve
sender gaps. This does **not reproduce a consistent concealment or sender-gap
regression caused by the audit bundle**. Neither the better aggregate B numbers
nor two repeats establish a causal improvement or statistical non-regression.

Both builds can have zero sender gaps under low host steal. A2's retained last-gap
timestamps at 15:43:42.292, 15:43:57.791 and 15:45:05.892 UTC overlap host steal
intervals of approximately 10.2%, 22.5% and 24.2%; an adjacent interval reaches
29.5%. B1's retained last gap at 15:27:42.891 is about 41 ms after the sampled
29.6% steal interval ends. These are strong timing associations with VM scheduling
pressure, not complete attribution of every gap or every receiver concealment.
Sampler intervals and counters are coarse; only last-gap timestamps are retained.

The remaining adverse observation is **six discards in each B repeat versus zero
and one in A**. Receiver mean buffering was approximately 67.2/60.8/66.3/91.7 ms
in A1/B1/B2/A2 despite identical buffer configuration. Native adaptive buffering,
network variation and host timing remain confounders. A discard does not by
itself prove an audible missing packet; some discard polls have no associated
concealment. Counter poll times do not establish exact packet-arrival times or
their discard reason. No specific code culprit is established for these discards.

Given the user's rejection of accepting worse or unproven transmission results,
the audit rollout is **pending**, not accepted. Restored the exact tested previous
runtime rather than deploying an untested mixture of the seven corrections.
The candidate and its fault-regression tests are retained for future isolation; the earlier
known audit faults are therefore still pending in production. They have not been
silently labeled fixed on the restored build. All improvements preceding the
October 4 audit bundle remain present.

## Verification and final state

All five affected runtime/dependency files match `c4654c5` exactly. The native
Oracle binary SHA-256 is
`ee17f6259de1c1c2a3fd7f8e99049a036aeb36cc716d0b3455255e2f3401fe08`,
and its selected release is `/opt/raydio/releases/c4654c51ed67a77aa8145abad52c396f28b7c2a4`.
Raydio is active, sole bot PID 40678, with zero automatic service restarts; Testbot is inactive.
The final five-minute previous-build run verifies playback of this exact runtime. Test
playback, receiver connection and all eight named local/Oracle collectors are
stopped. The firmware-check timer is restored.

Restored-source all-target tests pass: 66 unit tests plus three integration tests,
69 total. Formatting and warnings-denied all-target Clippy also pass. Raw per-run
reports, sender logs, host samples, preflights and the
[machine-readable comparison](audit-regression-20261004/comparison.json) are
in [audit-regression-20261004](audit-regression-20261004/).
