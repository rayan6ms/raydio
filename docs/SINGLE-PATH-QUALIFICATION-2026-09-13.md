# Single-path qualification — 2026-09-13

A bounded five-minute Testbot observation used the verified Rust candidate
`ef30de0fa39228712a50e1a5221152957f93986b` on the existing Oracle
`VM.Standard.E2.1.Micro`. Production `raydio.service` was disabled and no
other bot process ran. The receiver was a signed-in Discord session on the
same Starlink connection used for the browser controls.

The observation completed for 299.9998 seconds with complete receiver polling,
PCM, event, speaking, and track-phase coverage. It received 14,998 RTP
packets with **0 net lost packets**. The receiver reported one positive loss
delta that was later corrected, 2 discarded packets, 9 NACKs, 1,654 concealed
samples (about 34.5 ms at 48 kHz), and 0 silent concealment. PCM contained
14,400,512 frames (300.0107 seconds), no clipping, non-finite values, or empty
frames; the longest quiet interval was 976.25 ms and was retained as a
boundary candidate. The WebRTC connection remained connected throughout.

Oracle's independent host sampler produced seven valid samples with no
procfs errors, UDP receive errors, cgroup memory events, or network interface
errors. Bot PSS was 16,384–16,753 KiB (median 16,749 KiB), RSS
18,724–19,036 KiB, and cgroup memory 9.1–9.8 MiB. The sender journal reported
zero send failures, zero source overruns, and zero gaps of at least 100 ms;
there were 24 active-send gaps of at least 40 ms by the final checkpoint, with
a maximum of 79.62 ms. These short sender gaps did not produce net receiver
loss in this window but remain the main measurable reliability risk.

The first collector launch was intentionally excluded: its output directory
had not been created, so no receiver audit was started against it. The
corrected collector was started only after its first host sample existed, and
persistence verification passed with three host samples before the run was
allowed to continue. Testbot and all temporary collectors were stopped after
preserving the evidence; maintenance masks were removed and production Raydio
remains inactive.

This is a successful five-minute single-receiver qualification, not proof of
six-hour reliability. A second independent network was unavailable, so these
measurements cannot identify whether residual packet loss or concealment is on
Oracle's egress, Discord forwarding, or the listener path. The sender gaps are
not evidence that a safe code-level pacing change exists; forcing extra
buffering, duplication, FEC, bitrate, or pacing would change audio behavior
without causal evidence. The next justified action is a longer run with the
same diagnostics, or an A/B using a second network when available.

Evidence is under [`evidence/single-path-20260913-1350/`](../evidence/single-path-20260913-1350/).
