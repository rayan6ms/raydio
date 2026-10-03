// Observer-influence control: two endpoint counter reads, no extra audio sink,
// DOM observer, repeated stats polling, packet interception or buffering change.
(() => {
    if (window.raydioCounterAudit?.running) throw Error('Counter audit already running');
    const fields = ['timestamp', 'packetsReceived', 'packetsLost', 'bytesReceived',
        'packetsDiscarded', 'nackCount', 'concealedSamples', 'silentConcealedSamples',
        'concealmentEvents', 'totalSamplesReceived', 'jitterBufferDelay',
        'jitterBufferEmittedCount', 'insertedSamplesForDeceleration',
        'removedSamplesForAcceleration'];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const counters = row => Object.fromEntries(fields.filter(key => typeof row[key] === 'number').map(key => [key, row[key]]));
    const api = window.raydioCounterAudit = {running: false, report: null};
    api.start = async ({seconds = 180} = {}) => {
        if (api.running || window.raydioEndurance?.running)
            throw Error('Another receiver audit is running');
        if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600)
            throw Error('Duration must be 10..600 seconds');
        api.running = true;
        const data = api.report = {version: 1, observer: 'endpoint-counters',
            requestedSeconds: seconds, requestedAt: new Date().toISOString(),
            status: 'starting', elapsedSeconds: 0, events: [], pcmEnabled: false,
            diagnosticWindows: [], limitations: [
                'No PCM inspection, speaking/track UI observation, or interval loss accounting.',
                'Net zero loss can contain late-packet corrections.',
                'Endpoint readings cannot attribute individual concealment incidents.']};
        const removals = [];
        let measuredStart;
        try {
            const candidates = [];
            for (const peer of window.raydioEndurance?.peers || []) {
                if (peer.connectionState !== 'connected') continue;
                for (const row of (await peer.getStats()).values())
                    if (row.type === 'inbound-rtp' && row.kind === 'audio')
                        candidates.push({peer, row});
            }
            await sleep(1100);
            const active = [];
            for (const candidate of candidates) {
                const stats = await candidate.peer.getStats();
                const row = stats.get(candidate.row.id);
                if (row && row.packetsReceived - candidate.row.packetsReceived >= 40)
                    active.push({...candidate, row, stats});
            }
            if (active.length !== 1) throw Error('Expected exactly one advancing receiver');
            const {peer, row: initial, stats} = active[0];
            const track = peer.getReceivers().find(receiver => receiver.track.id === initial.trackIdentifier)?.track;
            if (!track || track.readyState !== 'live') throw Error('Receiver is not live');
            for (const key of ['timestamp', 'packetsReceived', 'packetsLost',
                'concealedSamples', 'silentConcealedSamples', 'totalSamplesReceived'])
                if (typeof initial[key] !== 'number') throw Error('Required quality counter unavailable');
            const codec = stats.get(initial.codecId);
            data.clockRate = codec?.clockRate || 48000;
            data.availableCounters = fields.filter(key => typeof initial[key] === 'number');
            data.missingCounters = fields.filter(key => typeof initial[key] !== 'number');
            data.receiverIdentity = {id: initial.id, ssrc: initial.ssrc, trackIdentifier: initial.trackIdentifier};
            data.initial = counters(initial);
            measuredStart = performance.now();
            data.startedAt = new Date().toISOString();
            data.status = 'running';
            const listen = (target, type, read) => {
                const listener = () => {
                    if (data.events.length < 32)
                        data.events.push({kind: type, ms: performance.now() - measuredStart, state: read()});
                    else data.eventOverflow = true;
                };
                target.addEventListener(type, listener);
                removals.push(() => target.removeEventListener(type, listener));
            };
            listen(peer, 'connectionstatechange', () => peer.connectionState);
            listen(peer, 'iceconnectionstatechange', () => peer.iceConnectionState);
            listen(track, 'ended', () => track.readyState);
            await sleep(seconds * 1000);
            const final = (await peer.getStats()).get(initial.id);
            if (!final || final.ssrc !== initial.ssrc || final.trackIdentifier !== initial.trackIdentifier)
                throw Error('Receiver identity changed');
            if (peer.connectionState !== 'connected' || track.readyState !== 'live')
                throw Error('Receiver is no longer live');
            if (data.availableCounters.some(key => typeof final[key] !== 'number'))
                throw Error('Receiver counter disappeared');
            data.current = counters(final);
            for (const key of data.availableCounters.filter(key => key !== 'packetsLost'))
                if (data.current[key] < data.initial[key]) throw Error('Receiver counter reset');
            data.delta = Object.fromEntries(data.availableCounters.map(key => [key, data.current[key] - data.initial[key]]));
            data.elapsedSeconds = data.delta.timestamp / 1000;
            if (!(data.elapsedSeconds >= seconds - 1) || data.delta.packetsReceived <= 0)
                throw Error('Receiver observation did not advance for the requested duration');
            data.concealmentMs = data.delta.concealedSamples * 1000 / data.clockRate;
            data.silentConcealmentMs = data.delta.silentConcealedSamples * 1000 / data.clockRate;
            data.uninterruptedConnection = !data.eventOverflow && !data.events.some(event =>
                ['disconnected', 'failed', 'closed', 'ended'].includes(event.state));
            data.status = 'completed';
        } catch (error) {
            data.status = 'failed'; data.error = String(error);
        } finally {
            for (const remove of removals) remove();
            data.finishedAt = new Date().toISOString();
            data.observationWallSeconds = measuredStart === undefined ? null : (performance.now() - measuredStart) / 1000;
            api.running = false;
        }
        return data;
    };
    return {installed: true};
})();
