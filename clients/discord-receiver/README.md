# Optional Discord web receiver buffer

This opt-in helper requests a **120 ms jitter buffer** for incoming audio in
this browser's Discord tab. It helps absorb late packet arrivals. It does not
alter Raydio's encoder, sender, source buffering or other listeners' clients.
It applies to all incoming voice audio in the tab, including conversations.

The matched measurements in
[the receiver follow-up](../../docs/RECEIVER-BUFFER-FOLLOWUP-2026-10-03.md)
found 162.75 ms concealment and four discards over ten default-buffer minutes,
versus zero of each over ten minutes at 120 ms. Mean buffering increased by
57.11 ms. This trades receive delay for tolerance of late packets, with no
change to codec quality. It cannot recover packets that never arrive or
guarantee uninterrupted playback on a future network path.

## Use in the controlled T3 tab

Evaluate `receiver_buffer.js` in the Discord tab's main JavaScript world. It
enables immediately and adopts existing peers retained by `raydioEndurance`.
Without that observer, install before joining voice, or leave/rejoin voice
after installation. New peers and description setup are observed through
WebRTC hooks, including setup with a constructor cached before installation.

```js
window.raydioReceiverBuffer.status();
window.raydioReceiverBuffer.disable(); // Restore original values where still owned.
window.raydioReceiverBuffer.enable(120);
```

The setting remains active after diagnostics finish and across voice
reconnects **in this page**. Reloading or reopening a controlled T3 tab clears
the script. T3's current preview tools provide no extension-install or
document-start injection API, so installation in that tab is session-scoped.

## Reapply after reload in regular Chromium

The directory is also a minimal Chromium Manifest V3 extension. In
`chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select this directory. Installation opts this browser into the setting on
`https://discord.com/*` at document start. Reload an already-open Discord tab
once after installation. No background process, storage, external request,
extra permission or third-party package is required. This extension is
provided for optional installation; it is not installed in T3 by these steps.

Disable/remove the extension to stop automatic application after reload. For
an immediate rollback in an open tab, call `disable()` above or reload after
removal. Browsers without `jitterBufferTarget` support leave the setting
unchanged and report unsupported receivers.

## Cost and diagnostics

The helper uses track/connection events, with no timers, stats reads,
per-packet hooks, audio graph, audio recording or network interception. It
releases ended receivers and closed connections. Native constructor behavior
and description arguments, errors and Promise identity are preserved.
Cleanup preserves settings/wrappers changed subsequently by other code.

The endurance observer records the initial/final helper state and target or
enable/disable changes. A setting change invalidates stable-buffer coverage;
the comparison controller refuses to run while this helper is enabled.

```sh
bun benchmarks/test_receiver_buffer.mjs
bun benchmarks/test_browser_endurance.mjs
bun benchmarks/test_browser_buffer_trial.mjs
```
