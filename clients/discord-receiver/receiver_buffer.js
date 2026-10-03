// Optional listener setting, not a Raydio sender or codec modification.
// Main-world script: connection events only; no timers, stats reads or traffic.
(() => {
    'use strict';
    if (window.raydioReceiverBuffer?.version === 1) return window.raydioReceiverBuffer.status();
    const Native = window.RTCPeerConnection;
    if (typeof Native !== 'function') return {installed: false, reason: 'WebRTC unavailable'};
    const peers = new Map(), receivers = new Map(), unsupported = new WeakSet();
    const errors = [];
    let enabled = false, targetMs = 120, generation = 0, unsupportedCount = 0;
    let changedReceivers = 0, failedApplications = 0, failedRestorations = 0;
    let constructorHook, constructorOriginal;
    const methodHooks = [];
    const note = (operation, error) => {
        if (errors.length === 8) errors.shift();
        errors.push({operation, message: String(error).slice(0, 200)});
    };
    const forgetReceiver = receiver => {
        const record = receivers.get(receiver);
        if (!record) return;
        receiver.track.removeEventListener('ended', record.ended);
        receivers.delete(receiver);
        for (const peer of peers.values()) peer.receivers.delete(receiver);
    };
    const restoreReceiver = receiver => {
        const record = receivers.get(receiver);
        if (!record) return;
        try {
            // Do not overwrite a later setting made by the application/user.
            if (receiver.jitterBufferTarget === record.applied) {
                receiver.jitterBufferTarget = record.original;
                if (receiver.jitterBufferTarget !== record.original) throw Error('Restoration was not accepted');
            }
        } catch (error) {failedRestorations++; note('restore', error);}
        forgetReceiver(receiver);
    };
    const applyReceiver = receiver => {
        if (!enabled || !receiver?.track || receiver.track.kind !== 'audio'
            || receiver.track.readyState !== 'live') return;
        if (!('jitterBufferTarget' in receiver)) {
            if (!unsupported.has(receiver)) {unsupported.add(receiver); unsupportedCount++;}
            return;
        }
        let record = receivers.get(receiver);
        try {
            if (!record) {
                record = {original: receiver.jitterBufferTarget, applied: targetMs,
                    ended: () => forgetReceiver(receiver)};
                receiver.track.addEventListener('ended', record.ended);
                receivers.set(receiver, record);
            }
            if (receiver.jitterBufferTarget !== targetMs) {
                receiver.jitterBufferTarget = targetMs;
                if (receiver.jitterBufferTarget !== targetMs) throw Error('Buffer target was not accepted');
                changedReceivers++;
            }
            record.applied = targetMs;
        } catch (error) {
            failedApplications++; note('apply', error);
            restoreReceiver(receiver);
        }
    };
    const detachPeer = peer => {
        const record = peers.get(peer);
        if (!record) return;
        peer.removeEventListener('track', record.track);
        peer.removeEventListener('connectionstatechange', record.state);
        peers.delete(peer);
        for (const receiver of record.receivers) restoreReceiver(receiver);
        record.receivers.clear();
    };
    const attachPeer = peer => {
        if (!enabled || !peer || peer.connectionState === 'closed') return;
        let record = peers.get(peer);
        if (!record) {
            record = {receivers: new Set()};
            record.track = event => {
                if (event.receiver?.track?.kind === 'audio') {
                    applyReceiver(event.receiver);
                    if (receivers.has(event.receiver)) record.receivers.add(event.receiver);
                }
            };
            record.state = () => {
                if (peer.connectionState === 'closed') detachPeer(peer);
            };
            peer.addEventListener('track', record.track);
            peer.addEventListener('connectionstatechange', record.state);
            peers.set(peer, record);
        }
        for (const receiver of peer.getReceivers()) {
            if (receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') {
                applyReceiver(receiver);
                if (receivers.has(receiver)) record.receivers.add(receiver);
            }
        }
    };
    const safelyAttach = peer => {try {attachPeer(peer);} catch (error) {note('peer', error);}};
    const installHooks = () => {
        const previous = window.RTCPeerConnection;
        constructorOriginal = previous;
        constructorHook = new Proxy(previous, {
            construct(target, args, newTarget) {
                const peer = Reflect.construct(target, args, newTarget);
                safelyAttach(peer);
                return peer;
            }
        });
        window.RTCPeerConnection = constructorHook;
        // Discord may have cached its constructor before this script ran.
        // Hook description setup too, before the asynchronous track events.
        const hookMethod = (name, after) => {
            let owner = previous.prototype;
            while (owner && !Object.hasOwn(owner, name)) owner = Object.getPrototypeOf(owner);
            if (!owner) return;
            const descriptor = Object.getOwnPropertyDescriptor(owner, name);
            const nativeMethod = descriptor.value;
            if (typeof nativeMethod !== 'function') return;
            const hook = function (...args) {
                // Retain native return values (including Promise identity)
                // and errors; helper errors cannot break successful calls.
                const result = Reflect.apply(nativeMethod, this, args);
                try {after(this);} catch (error) {note(name, error);}
                return result;
            };
            Object.defineProperty(owner, name, {...descriptor, value: hook});
            methodHooks.push({owner, name, descriptor, hook});
        };
        hookMethod('setRemoteDescription', safelyAttach);
        // Native close() need not emit a state-change event. Release even then.
        hookMethod('close', detachPeer);
    };
    const removeHooks = () => {
        // Leave wrappers installed by another tool/application intact.
        if (window.RTCPeerConnection === constructorHook) window.RTCPeerConnection = constructorOriginal;
        for (const {owner, name, descriptor, hook} of methodHooks)
            if (Object.getOwnPropertyDescriptor(owner, name)?.value === hook)
                Object.defineProperty(owner, name, descriptor);
        methodHooks.length = 0;
        constructorHook = undefined;
    };
    const api = window.raydioReceiverBuffer = {
        version: 1,
        get generation() {return generation;},
        status: () => ({installed: true, enabled, targetMs, generation, peers: peers.size,
            scope: 'All incoming audio in this Discord tab',
            persistence: 'Voice reconnects; page reload requires the optional extension',
            receivers: [...receivers].map(([receiver, record]) => ({trackId: receiver.track.id,
                live: receiver.track.readyState === 'live', originalMs: record.original,
                appliedMs: receiver.jitterBufferTarget, matches: receiver.jitterBufferTarget === targetMs})),
            changedReceivers, unsupportedCount, failedApplications, failedRestorations, errors: errors.slice()}),
        enable: (ms = 120) => {
            if (!Number.isInteger(ms) || ms < 0 || ms > 300) throw Error('Target must be an integer from 0 to 300 ms');
            if (window.raydioBufferTrial?.running) throw Error('Stop the buffer comparison before enabling the helper');
            targetMs = ms;
            if (!enabled) {
                enabled = true;
                try {installHooks();} catch (error) {note('hooks', error); api.disable(); throw error;}
            }
            generation++;
            for (const peer of peers.keys()) safelyAttach(peer);
            // An audit installed earlier retains the currently connected peers.
            for (const peer of window.raydioEndurance?.peers || []) safelyAttach(peer);
            return api.status();
        },
        disable: () => {
            enabled = false; generation++;
            removeHooks();
            for (const peer of peers.keys()) detachPeer(peer);
            for (const receiver of receivers.keys()) restoreReceiver(receiver);
            return api.status();
        }
    };
    return api.enable();
})();
