// Sequential observer comparison on an already-playing, unchanged receiver.
// Endpoint mode adds no interval polling or PCM sink. Persistence occurs only
// between windows; a failed/invalid window is saved and stops the comparison.
(() => {
    if (window.raydioObserverTrial?.running) throw Error('Observer trial already running');
    const api = window.raydioObserverTrial = {running: false, report: null};
    const endpoint = 'http://127.0.0.1:18766';
    api.start = async ({seconds = 180, modes = ['endpoint', 'pcm', 'pcm', 'endpoint']} = {}) => {
        if (api.running || window.raydioCounterAudit?.running || window.raydioEndurance?.running
            || window.raydioCheckpoint?.timer) throw Error('Another observer or checkpoint timer is active');
        if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600 || !Array.isArray(modes)
            || modes.length < 1 || modes.length > 8 || modes.length * seconds > 1800
            || modes.some(mode => !['endpoint', 'pcm', 'polling'].includes(mode)))
            throw Error('Invalid bounded observer comparison');
        api.running = true;
        const data = api.report = {requestedAt: new Date().toISOString(), seconds, modes,
            status: 'starting', windows: [], saved: 0};
        try {
            const response = await fetch(endpoint + '/health', {signal: AbortSignal.timeout(5000)});
            if (!response.ok) throw Error('Collector health HTTP ' + response.status);
            const health = await response.json();
            if (health.remainingSeconds < modes.length * (seconds + 5) + 30)
                throw Error('Collector lifetime insufficient');
            data.status = 'running';
            for (const mode of modes) {
                data.currentMode = mode;
                const report = mode === 'endpoint'
                    ? await window.raydioCounterAudit.start({seconds})
                    : await window.raydioEndurance.start({seconds, botName: 'Raydio', pcm: mode === 'pcm', scheduling: true});
                report.observer = mode;
                report.observerTrial = {requestedAt: data.requestedAt, index: data.windows.length};
                data.windows.push(report);
                const saved = await fetch(endpoint + '/checkpoint', {method: 'POST',
                    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(report),
                    signal: AbortSignal.timeout(5000)});
                if (!saved.ok) throw Error('Window persistence HTTP ' + saved.status);
                data.saved++;
                if (report.status !== 'completed') throw Error('Receiver window failed: ' + report.error);
                const continuous = mode === 'endpoint' ? report.uninterruptedConnection : report.coverage?.uninterruptedConnection;
                if (!continuous) throw Error('Receiver window contained a connection interruption');
            }
            data.status = 'completed';
        } catch (error) {
            data.status = 'failed'; data.error = String(error);
        } finally {
            data.finishedAt = new Date().toISOString(); api.running = false;
        }
        return data;
    };
    return {installed: true};
})();
