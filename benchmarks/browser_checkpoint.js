// Install before starting the audit. Saves aggregate diagnostics only, never PCM.
// Independent of the agent turn; at most one loopback request per minute.
(() => {
    if (window.raydioCheckpoint?.timer) throw Error('Checkpoint timer already active');
    const state = window.raydioCheckpoint = {saved:0, errors:0, maxSerializeMs:0, busy:false, lastSavedReport:null, lastSavedRevision:null};
    state.deadlineAt = Date.now() + 25200000;
    state.deadlineMonotonic = performance.now() + 25200000;
    state.save = async () => {
        const data = window.raydioEndurance?.report;
        if (!data || !Number.isInteger(data.requestedSeconds) || data.requestedSeconds < 10 || data.requestedSeconds > 21600 || state.busy) return;
        const revision = [data.status, data.lastProgressAt, data.finishedAt].join('|');
        if (state.lastSavedReport === data && state.lastSavedRevision === revision) return;
        state.busy = true;
        try {
            const started = performance.now();
            const body = JSON.stringify(data);
            state.maxSerializeMs = Math.max(state.maxSerializeMs, performance.now()-started);
            const response = await fetch('http://127.0.0.1:18766/checkpoint', {
                method:'POST', headers:{'Content-Type':'application/json'}, body,
                signal:AbortSignal.timeout(5000)
            });
            if (!response.ok) throw Error(`Checkpoint HTTP ${response.status}`);
            state.saved++; state.lastSavedAt = new Date().toISOString();
            state.lastSavedRequestedAt = data.requestedAt;
            state.lastSavedElapsedSeconds = data.elapsedSeconds;
            state.lastSavedReport = data; state.lastSavedRevision = revision;
        } catch (e) { state.errors++; state.lastError = String(e); }
        finally { state.busy = false; }
        // A failed preflight can be replaced by a real run. Keep observing
        // report identity until the collector's seven-hour lifetime expires.
        // Completed unchanged reports are deduplicated; failed writes retry.
    };
    state.verify = async () => {
        const data = window.raydioEndurance?.report;
        if (!data || data.status !== 'running' || !(data.elapsedSeconds > 0))
            throw Error('Start the actual advancing receiver audit before verifying persistence');
        await state.save();
        const response = await fetch('http://127.0.0.1:18766/health', {signal:AbortSignal.timeout(5000)});
        if (!response.ok) throw Error(`Checkpoint health HTTP ${response.status}`);
        const health = await response.json();
        const saved = health.lastReceiver;
        if (window.raydioEndurance?.report !== data || !data.requestedAt ||
            saved?.requestedAt !== data.requestedAt || saved?.status !== 'running' ||
            !(saved.elapsedSeconds > 0) || saved.elapsedSeconds < data.elapsedSeconds - 5)
            throw Error('Collector has not saved this running report recently');
        const remaining = data.requestedSeconds - data.elapsedSeconds + 60;
        if (!(health.hostSamples >= 2) || !(health.remainingSeconds >= remaining) ||
            !state.timer || (state.deadlineMonotonic - performance.now()) / 1000 < remaining)
            throw Error('Collector samples or remaining lifetime are insufficient');
        return {verified:true,requestedAt:data.requestedAt,elapsedSeconds:saved.elapsedSeconds,
            hostSamples:health.hostSamples,remainingSeconds:health.remainingSeconds};
    };
    state.timer = setInterval(state.save, 60000);
    state.stop = () => {
        clearInterval(state.timer); state.timer = null;
        clearTimeout(state.deadline);
    };
    state.deadline = setTimeout(state.stop, 25200000);
    return {installed:true};
})();
