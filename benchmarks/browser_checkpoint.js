// Install before starting the audit. Saves aggregate diagnostics only, never PCM.
// Independent of the agent turn; at most one loopback request per minute.
(() => {
    if (window.raydioCheckpoint?.timer) throw Error('Checkpoint timer already active');
    const state = window.raydioCheckpoint = {saved:0, errors:0, maxSerializeMs:0, busy:false, lastSavedReport:null, lastSavedRevision:null};
    state.save = async () => {
        const data = window.raydioEndurance?.report;
        if (!data || data.requestedSeconds !== 21600 || state.busy) return;
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
            state.lastSavedReport = data; state.lastSavedRevision = revision;
        } catch (e) { state.errors++; state.lastError = String(e); }
        finally { state.busy = false; }
        // A failed preflight can be replaced by a real run. Keep observing
        // report identity until the collector's seven-hour lifetime expires.
        // Completed unchanged reports are deduplicated; failed writes retry.
    };
    state.timer = setInterval(state.save, 60000);
    state.stop = () => {
        clearInterval(state.timer); state.timer = null;
        clearTimeout(state.deadline);
    };
    state.deadline = setTimeout(state.stop, 25200000);
    return {installed:true};
})();
