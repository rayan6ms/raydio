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
