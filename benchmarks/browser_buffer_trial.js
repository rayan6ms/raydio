// Listener-only experiment on unchanged playback. No packet capture or probes.
// Persist every terminal window; always restore the original receiver setting.
(() => {
    if (window.raydioBufferTrial?.running) throw Error('Buffer trial already running');
    const api = window.raydioBufferTrial = {running: false, report: null};
    const endpoint = 'http://127.0.0.1:18766';
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    api.start = async ({seconds = 300, targets = [null, 120, null, 120], warmupSeconds = 10} = {}) => {
        if (api.running || window.raydioEndurance?.running || window.raydioCounterAudit?.running
            || window.raydioObserverTrial?.running || window.raydioCheckpoint?.timer)
            throw Error('Another observer or checkpoint is active');
        if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600
            || !Number.isInteger(warmupSeconds) || warmupSeconds < 5 || warmupSeconds > 30
            || !Array.isArray(targets) || targets.length < 1 || targets.length > 8
            || targets.length * (seconds + warmupSeconds + 5) > 1800
            || targets.some(t => t !== null && (!Number.isInteger(t) || t < 0 || t > 300)))
            throw Error('Invalid bounded buffer comparison');
        api.running = true;
        const data = api.report = {requestedAt: new Date().toISOString(), seconds, targets,
            warmupSeconds, status: 'starting', windows: [], saved: 0, restored: false};
        let receiver, original;
        try {
            const response = await fetch(endpoint + '/health', {signal: AbortSignal.timeout(5000)});
            if (!response.ok) throw Error('Collector health HTTP ' + response.status);
            const health = await response.json();
            if (health.remainingSeconds < targets.length * (seconds + warmupSeconds + 5) + 30)
                throw Error('Collector lifetime insufficient');
            const candidates = [];
            for (const peer of window.raydioEndurance.peers) {
                if (peer.connectionState !== 'connected') continue;
                for (const raw of (await peer.getStats()).values()) {
                    if (raw.type === 'inbound-rtp' && raw.kind === 'audio')
                        candidates.push({peer, raw});
                }
            }
            await sleep(1100);
            const active = [];
            for (const c of candidates) {
                const raw = (await c.peer.getStats()).get(c.raw.id);
                if (raw && raw.packetsReceived - c.raw.packetsReceived >= 40) active.push({...c, raw});
            }
            if (active.length !== 1) throw Error('Expected one advancing receiver');
            const selected = active[0];
            receiver = selected.peer.getReceivers().find(r => r.track.id === selected.raw.trackIdentifier);
            if (!receiver || receiver.track.readyState !== 'live' || !('jitterBufferTarget' in receiver))
                throw Error('Live receiver with buffer target support unavailable');
            original = receiver.jitterBufferTarget;
            data.originalSetting = original;
            data.receiverIdentity = {id: selected.raw.id, ssrc: selected.raw.ssrc,
                trackIdentifier: selected.raw.trackIdentifier};
            data.status = 'running';
            for (const target of targets) {
                data.currentTargetMs = target;
                receiver.jitterBufferTarget = target;
                if (receiver.jitterBufferTarget !== target) throw Error('Buffer setting was not applied');
                await sleep(warmupSeconds * 1000);
                const report = await window.raydioEndurance.start({seconds, botName: 'Raydio', pcm: true, scheduling: true});
                report.receiverBufferTrial = {requestedAt: data.requestedAt, index: data.windows.length,
                    targetMs: target, actualSettingMs: receiver.jitterBufferTarget, warmupSeconds};
                data.windows.push(report);
                const saved = await fetch(endpoint + '/checkpoint', {method: 'POST',
                    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(report),
                    signal: AbortSignal.timeout(5000)});
                if (!saved.ok) throw Error('Window persistence HTTP ' + saved.status);
                data.saved++;
                if (report.status !== 'completed') throw Error('Receiver failed: ' + report.error);
                if (JSON.stringify(report.receiverIdentity) !== JSON.stringify(data.receiverIdentity))
                    throw Error('Receiver identity changed');
                if (report.coverage?.uninterruptedConnection !== true
                    || report.coverage?.completePollCoverage !== true
                    || report.coverage?.completePcmCoverage !== true
                    || report.coverage?.completeEventHistory !== true)
                    throw Error('Incomplete receiver coverage; terminal report retained');
            }
            data.status = 'completed';
        } catch (error) {
            data.status = 'failed'; data.error = String(error);
        } finally {
            try {
                if (receiver && original !== undefined) {
                    receiver.jitterBufferTarget = original;
                    data.restored = receiver.jitterBufferTarget === original;
                    if (!data.restored) throw Error('Original buffer setting was not restored');
                }
            } catch (error) {data.status = 'failed'; data.restoreError = String(error);}
            data.finishedAt = new Date().toISOString(); api.running = false;
        }
        return data;
    };
    return {installed: true};
})();
