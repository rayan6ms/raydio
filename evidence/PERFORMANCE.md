# Final release: 4cdb705

[Native CI](https://github.com/rayan6ms/raydio/actions/runs/33985944055) passed
45 bot tests, formatting, Clippy, deployment lifecycle tests, and the unprivileged
package check on ARM64 and x86-64. A subsequent test-only regression also passed,
checking that stale paused panels are corrected once and polling stops after
three status checks. See [artifact hashes](release-validation.json).

The [final matched idle comparison](optimization-final-idle.json) used three
alternating starts of each binary with no concurrent bot or local compilation.
PSS fell from **12,937 KiB to 12,085 KiB (12.63 to 11.80 MiB, −6.59%)**. RSS
fell from 15,820 to 15,016 KiB. Both used four threads. Startup medians were 2,557
and 2,809 ms; no startup or idle CPU speedup is claimed. These figures compare
the preserved baseline with the portable final package, including toolchain and
runtime changes, rather than isolating the compiler option.

The final ARM64 archive is 7,013,232 bytes (**6.69 MiB**), and x86-64 is
7,398,147 bytes (**7.06 MiB**). Live measurements use x86-64 on the developer
host. Native ARM64 CI and read-only Oracle image verification do not replace
an actual Oracle VM/network test.

## Final portable live checks

The [final five-minute receiver capture](audio-final-release-soak.json) passed all
60 five-second packet windows and crossed a full song loop. It received 14,965
packets with 4 net lost packets, 46,057 concealed samples (~0.960 s cumulative),
11 concealment events, a 99.55 ms mean jitter-buffer residence, and zero
full-scale/non-finite PCM samples. Compared with the previous portable run,
concealment decreased from 68,715 samples and the loop window rose from 37.94 to
42.38 packets/s. Source reload still causes a short gap; network variability and
one run each prevent a causal percentage claim for audio quality.

[Playback memory](playback-final-release-soak.json) was stable but increased to
20,223 KiB median PSS (~19.75 MiB) across fifteen 20-second windows after the
asynchronous scheduling change. That is higher than the previous portable
run's 16,531 KiB, so the earlier 9.7% compiler-only playback saving is not a
claim about the complete final implementation. Final idle remains 6.6% lower.
The extra resident memory is under investigation separately from the successful
receiver run.

# Portable build before asynchronous progress updates

The pre-update portable runtime/deployment revision is
`01be5a4f3d05fddbc0c247a705e4b08d959c738c`. Both native CI jobs passed all 44
bot tests, formatting, Clippy, deployment lifecycle tests, release packaging,
and the unprivileged offline backend smoke test.
[Artifact hashes and sizes](release-validation-01be5a4.json) identify the tested downloads.

This x86-64 package reduced authenticated idle PSS from **12,905 KiB to
11,924 KiB (12.60 to 11.64 MiB, −7.60%)**, with three alternating process starts
per binary. RSS went from 15,792 to 14,832 KiB. Both used four threads. Startup
medians were 2,959 and 2,808 ms, but network variation and three starts do not
establish a startup-latency speedup. This compares the preserved old executable
against this portable build; it includes compiler/toolchain and subsequent
runtime changes. The isolated compiler experiment is retained below.
See [portable idle samples](optimization-portable-before-async-idle.json).
The [intermediate portable experiment](optimization-portable-idle.json) is an
older artifact and is not the current release result.

The ARM64 archive is **6.68 MiB** (15.33 MiB executable); x86-64 is **7.05 MiB**
(17.27 MiB executable). Tests used native GitHub ARM64/x86-64 runners, and live
Discord measurements used the x86-64 package on the developer host. Oracle API
verification found the configured Ubuntu 24.04 ARM64 image available and no
instances in the configured compartment. No Oracle VM or egress-network claim
is inferred from CI.

## Loop-boundary failure and progress scheduling

The [portable receiver run](audio-portable-before-async-soak.json) retained all
300 seconds, including a complete loop, but **failed** its strict packet-window
threshold. One five-second window at the loop boundary had 37.94 packets/s,
about 1.2 seconds of packet deficit; the other 59 windows were within 40–60.
It recorded 14,940 packets, 4 net lost packets, 68,715 concealed samples, and
no full-scale/non-finite PCM. This is retained failure evidence, not a passing
continuity claim. Its [memory samples](playback-portable-before-async-soak.json)
include the restart and should not be called uninterrupted playback.

Inspection found that the guild task awaited each Discord progress edit before
processing track-end events. The controlled HTTP regression failed on the old
implementation: restart remained blocked at the 1,001 ms deadline. With one
owned progress-edit task and coalescing, restart completed in 13.8 ms while the
same edit was still blocked. Controls apply to audio before waiting for the
previous panel edit, and message writes stay ordered. The regression also checks
that only one progress request is in flight. Live revalidation is required before
attributing the observed loop gap to this scheduling change.

The follow-up live run on the updated debug bot completed 24 alternating
pause/resume actions with the stored panel ending in the expected Playing state.
Observed browser-to-panel update times ranged from 908 ms to 2,244 ms; this is a
valid correctness run, but it is not a matched latency improvement because the
portable baseline run timed out. A 60-second receiver capture after the update
had 3,002 packets, zero packet loss, all twelve packet-rate windows between
49.78 and 50.27 packets/s, 1,262 concealed samples (~26 ms), 0 full-scale and
0 non-finite samples, and a 104.4 ms mean jitter-buffer residence. It is a
short continuity check; the failed loop-boundary run above remains the relevant
five-minute limitation.

The stored panel mismatch was independently reproduced with the Discord REST
API: a direct PATCH remained Paused for six seconds. The code now performs up to
three delayed, status-only checks after a paused control and re-edits only when
Discord persisted a stale snapshot. This bound is reached only during a paused
transition and does not affect authenticated idle memory.

# September 5 follow-up

The baseline is the preserved `6873ad1` size-control executable. The candidate
changes the full release graph to `opt-level="s"`, thin LTO, one codegen unit.
Audio sample rate, Opus settings, volume behavior, and 20 ms pacing are unchanged.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Authenticated idle PSS, median of three starts | 12,961 KiB | 12,333 KiB |
| Active playback PSS, median of three windows | 18,488 KiB | 16,694 KiB |
| Playback CPU (% one core) | 3.197 | 3.296 |
| Receiver packets in ~60 seconds | 2,992 | 2,998 |
| Net packets lost in receiver window | 1 | 1 |
| Concealed samples (48 kHz) | 8,522 | 5,034 |
| Concealment events | 7 | 5 |
| Mean receiver jitter-buffer residence | 99.76 ms | 94.11 ms |
| Full-scale / non-finite PCM samples | 0 / 0 | 0 / 0 |

Idle memory improved **4.85%**; playback memory improved **9.70%**. CPU increased
0.099 percentage points in this sample; no CPU speedup is claimed. Receiver
concealment was about 177.5 ms and 104.9 ms cumulatively over 60 seconds. Those
are receiver concealment totals, not the duration of a single gap. Network and
scheduler variation prevent attributing their difference to the compiler option.
The audio windows differ in song position, so peak/RMS values are not a codec
quality comparison. No clipping occurred at volume 70 in either capture.

## Evidence

- [Matched authenticated idle](optimization-global-s.json): alternating order,
  three starts each, five-second warmup, 15-second samples, binary hashes.
- [Verified baseline playback](playback-size-control-verified.json) and
  [candidate playback](playback-global-s.json): three consecutive 20-second windows
  per process, loop enabled and player position advancing, four threads.
- [Baseline receiver](audio-size-control-verified.json) and
  [candidate receiver](audio-global-s.json): timed within the browser, selected by
  advancing packet counters, five-second validation windows, same exact receiver
  throughout. One listener, no compilation during samples.
- [Candidate button measurements](latency-global-s.json): 12 pause/resume actions.
  [Baseline attempt](latency-size-control-incomplete.json) timed out and did not
  consistently alternate observed state. It is incomplete, and there is no valid
  fresh before/after control-latency claim.

The earlier **17.65 MiB playback claim is withdrawn**. Its process was sampled
after playback had stopped. [That record](playback-size-control.json) now marks
itself invalid; it must not be used as an active-playback benchmark. Older valid
idle and playback results remain historical evidence for their recorded revisions.

## Reproduce

Use the explicitly authorized test bot and an authenticated browser listener.
Keep token values out of logs. Build both binaries before collecting measurements.

```sh
uv run --no-project python benchmarks/compare_rust_idle.py \
  --before /path/to/baseline --after /path/to/candidate \
  --env-file /path/to/testbot.env --output evidence/new-idle.json
```

For playback, `benchmarks/start_rust.py` owns the bot process and cleans it up.
Join voice, start the same video at volume 70, enable track loop, and verify the
panel advances. Use `sample_playback.py --pid PID --expected-exe PATH` for memory
and CPU, and install `browser_audio.js` before the listener joins. Its timed audit
must report `valid: true`; retained historical packet counters alone are not proof
of playback. It stores aggregate PCM statistics, not audio recordings.

The release also strips nonresident symbol tables, adds systemd readiness, and
uses public dependency pins. Those deployment changes require their own final
artifact validation; the table above describes the measured compiler experiment.

## Extended audio and controls

Five-minute runs crossed a full 3:33 song loop with the same receiver and advancing
player positions throughout. [Baseline](audio-baseline-soak.json) and
[size-optimized](audio-global-s-soak.json) captures recorded 14,945 and 14,973
received packets, respectively; net loss was 3 and 2 packets. Both had zero
full-scale and non-finite samples. Cumulative concealment was 89,052 and 40,967
samples (~1.855 s and ~0.853 s), and mean receiver buffer residence was 145.4 and
102.9 ms. These runs include the natural loop reload and network variation;
they are evidence of functioning extended playback, not a causal audio-quality
speedup or a gapless guarantee.

Rapid control testing exposed a separate correctness bug: the bot reported paused
while both Discord's stored message and the browser displayed Playing. Player
controls edited via a webhook while the periodic refresh used the channel route.
Controls now use that same channel route, and edits consume response bodies before
the next update. The [24-action reproduction](controls-channel-route.json) passed
without a reversion after the change; the final stored Discord message agreed.
The regression test checks the route and absence of duplicate edits. This is a
correctness improvement, not a claimed latency reduction.
