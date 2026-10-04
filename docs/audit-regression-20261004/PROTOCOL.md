# Repeated live regression qualification — October 4, 2026

The previous rollout accepted reproduced-fault corrections without establishing
live transmission non-regression. The user rejected that acceptance. The current
release is under qualification; its prior live results do not establish either
causation or non-regression.

Compare the saved native releases, without rebuilding:

- A: `c4654c51ed67a77aa8145abad52c396f28b7c2a4`, binary SHA-256
  `ee17f6259de1c1c2a3fd7f8e99049a036aeb36cc716d0b3455255e2f3401fe08`.
- B: `d2d3fad01346c526546c7e54ed122a58f944ad70`, binary SHA-256
  `58c5a023653eb6dfe926846edd5d92b1102f7f6173a3bde0aeb85550759f64cc`.

The order is A1, B1, B2, A2. Restart before each observation. Raydio is the only
bot process; Testbot stays inactive. The service unit files are identical. Record
the environment-file digest without reading credentials, and verify it remains
unchanged. Use the same Oracle instance, Discord test/General/#chat, browser,
ordinary receiver buffering, exact `4moWSMi1L_4` URL, volume 70 and Loop ON.

Each receiver recording is 300 seconds, starts after approximately 35 seconds
of advancing playback, and must have complete receiver/PCM/event/phase history,
complete 1 Hz Oracle/local host coverage with 3 s slack, and successful independent
persistence. Retain sender checkpoints, host steal/scheduling/cgroup counters,
receiver timing incidents, and natural song boundaries. No builds, source probes,
packet captures or player controls during recordings. A genuine disconnect or
incomplete coverage invalidates a performance comparison, not its incident data.

Compare repeated same-duration concealment, silent concealment, discards, signed
loss counters, off-boundary quiet, sender gaps/deadline omissions, CPU and PSS.
Keep the reused October 2 source quiet reference explicitly labeled. Retain
natural loop quiet instead of counting it as a proven interruption.

Do not equate zero net RTP loss with uninterrupted playout. Do not discard a bad
window solely because it contains host steal. Examine the timing relationship,
compare both repeats and both balanced-order pairs, and distinguish evidence
of a release effect from host/network variation. If B consistently worsens
concealment or sender gaps, fix/isolate the change or revert it. If the comparison
cannot establish a safe rollout, leave the previously qualified release active
and mark the new changes pending further qualification rather than accepting
an unproven audio-quality regression.
