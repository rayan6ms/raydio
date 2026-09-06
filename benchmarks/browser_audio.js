// Install before joining voice. Aggregate receiver counters only; no recording.
// Run timedRaydioAudioAudit() within the browser, so tool delays cannot extend
// the window past the song's end. Never infer active playback from old counters.
const installRaydioAudioAudit = () => {
    if (window.__raydioRtcAudit) return;
    const Native = window.RTCPeerConnection;
    const peers = [];
    class Observed extends Native {
        constructor(...args) {
            super(...args);
            peers.push(this);
            if (peers.length > 8) peers.shift();
        }
    }
    window.RTCPeerConnection = Observed;
    window.__raydioRtcAudit = {Native, Observed, peers};
};

const audioFields = ['timestamp','packetsReceived','packetsLost','bytesReceived','jitter',
    'concealedSamples','silentConcealedSamples','concealmentEvents','totalSamplesReceived',
    'jitterBufferDelay','jitterBufferEmittedCount','totalAudioEnergy','totalSamplesDuration'];
const audioCounters = r => Object.fromEntries(audioFields.filter(k => r[k] !== undefined).map(k => [k,r[k]]));
const auditSleep = ms => new Promise(resolve => setTimeout(resolve,ms));

const startRaydioAudioAudit = async () => {
    const a = window.__raydioRtcAudit;
    if (a.capture) throw Error('Capture already running');
    const candidates = [];
    for (const peer of a.peers) {
        if (peer.connectionState !== 'connected') continue;
        for (const report of (await peer.getStats()).values()) {
            if (report.type === 'inbound-rtp' && report.kind === 'audio') candidates.push({peer,report});
        }
    }
    await auditSleep(1000);
    const active = [];
    for (const {peer,report} of candidates) {
        const next = (await peer.getStats()).get(report.id);
        if (next && next.packetsReceived-report.packetsReceived >= 30) active.push({peer,report:next});
    }
    if (active.length !== 1) throw Error(`Expected one advancing audio stream, found ${active.length}`);
    const {peer,report} = active[0];
    const receiver = peer.getReceivers().find(r => r.track.id === report.trackIdentifier);
    if (!receiver || receiver.track.readyState !== 'live') throw Error('Receiver not live');
    const context = new AudioContext({sampleRate:48000});
    await context.resume();
    const source = context.createMediaStreamSource(new MediaStream([receiver.track]));
    const processor = context.createScriptProcessor(2048,2,2);
    const pcm = {samples:0,peak:0,squared:0,nearFullScale:0,nonFinite:0,zeroBlocks:0,blocks:0,
        longestQuietMs:0,quietRuns:[],quietRunsTruncated:false};
    let quietMs=0, processedMs=0;
    processor.onaudioprocess = e => {
        let silent = true;
        for (let c=0;c<e.inputBuffer.numberOfChannels;c++) for (const x of e.inputBuffer.getChannelData(c)) {
            if (!Number.isFinite(x)) { pcm.nonFinite++; continue; }
            const v=Math.abs(x); pcm.peak=Math.max(pcm.peak,v); pcm.squared+=x*x; pcm.samples++;
            if (v>=0.99997) pcm.nearFullScale++;
            if (v>0.00001) silent=false;
        }
        pcm.blocks++; if (silent) pcm.zeroBlocks++;
        const blockMs=1000*e.inputBuffer.length/e.inputBuffer.sampleRate;
        processedMs+=blockMs;
        if (silent) {
            quietMs+=blockMs;
            pcm.longestQuietMs=Math.max(pcm.longestQuietMs,quietMs);
        } else if (quietMs) {
            if (pcm.quietRuns.length<200) pcm.quietRuns.push({endMs:processedMs-blockMs,durationMs:quietMs});
            else pcm.quietRunsTruncated=true;
            quietMs=0;
        }
        // Output remains zero: this analysis tap does not duplicate playback.
    };
    source.connect(processor); processor.connect(context.destination);
    a.capture = {peer,id:report.id,context,source,processor,pcm,initial:audioCounters(report),windows:[]};
    return {state:context.state,initial:a.capture.initial};
};

const finishRaydioAudioAudit = async () => {
    const a=window.__raydioRtcAudit, c=a.capture;
    try {
        const report=(await c.peer.getStats()).get(c.id);
        if (!report) throw Error('Instrumented inbound stream disappeared');
        const current=audioCounters(report);
        const delta=Object.fromEntries(Object.keys(c.initial).filter(k=>k!=='jitter').map(k=>[k,current[k]-c.initial[k]]));
        const elapsedSeconds=delta.timestamp/1000;
        return {initial:c.initial,current,delta,elapsedSeconds,windows:c.windows,
            valid:c.windows.length>0 && c.windows.every(w=>w.packetRate>=40 && w.packetRate<=60),
            pcm:{...c.pcm,rms:Math.sqrt(c.pcm.squared/Math.max(1,c.pcm.samples))},
            receiverBufferMeanMs:delta.jitterBufferEmittedCount>0?1000*delta.jitterBufferDelay/delta.jitterBufferEmittedCount:null};
    } finally {
        c.processor.disconnect(); c.source.disconnect(); await c.context.close(); delete a.capture;
    }
};

const timedRaydioAudioAudit = async (seconds=60) => {
    await startRaydioAudioAudit();
    const c=window.__raydioRtcAudit.capture;
    let last=c.initial;
    for (let elapsed=0;elapsed<seconds;elapsed+=5) {
        await auditSleep(5000);
        const r=(await c.peer.getStats()).get(c.id);
        if (!r) break;
        c.windows.push({elapsedSeconds:(r.timestamp-c.initial.timestamp)/1000,
            packetRate:(r.packetsReceived-last.packetsReceived)*1000/(r.timestamp-last.timestamp),
            packetsLost:r.packetsLost-last.packetsLost,jitter:r.jitter});
        last=audioCounters(r);
    }
    return finishRaydioAudioAudit();
};

const restoreRaydioAudioAudit = async () => {
    const a=window.__raydioRtcAudit;
    if (!a) return;
    if (a.capture) await finishRaydioAudioAudit();
    if (window.RTCPeerConnection===a.Observed) window.RTCPeerConnection=a.Native;
    delete window.__raydioRtcAudit;
};

// Short-dropout audit. Poll actual receiver counters every 100 ms; retain all
// anomalies (bounded) and one-second totals. A low packet count alone is not a
// dropout: correlate it with newly concealed samples and PCM silence runs.
const fineRaydioAudioAudit = async (seconds=180) => {
    if (seconds < 1 || seconds > 600) throw Error('Duration must be 1..600 seconds');
    await startRaydioAudioAudit();
    const c=window.__raydioRtcAudit.capture;
    const fine={polls:0,stalePolls:0,maxPollMs:0,concealmentWindows:0,
        emptyPacketWindows:0,maxConcealedMs:0,anomalies:[],truncated:false};
    let last=c.initial, windowStart=last, started=performance.now();
    try {
        while (performance.now()-started < seconds*1000) {
            await auditSleep(100);
            const r=(await c.peer.getStats()).get(c.id);
            if (!r || c.peer.connectionState !== 'connected') throw Error('Receiver replaced or disconnected');
            const dt=r.timestamp-last.timestamp;
            if (dt<=0) { fine.stalePolls++; continue; }
            fine.polls++; fine.maxPollMs=Math.max(fine.maxPollMs,dt);
            const packets=r.packetsReceived-last.packetsReceived;
            const concealed=(r.concealedSamples||0)-(last.concealedSamples||0);
            if (concealed>0) fine.concealmentWindows++;
            if (packets===0) fine.emptyPacketWindows++;
            fine.maxConcealedMs=Math.max(fine.maxConcealedMs,concealed/48);
            if (concealed>0 || packets===0 || dt>250) {
                if (fine.anomalies.length<200) fine.anomalies.push({
                    elapsedMs:r.timestamp-c.initial.timestamp,windowMs:dt,packets,
                    lost:r.packetsLost-last.packetsLost,concealedMs:concealed/48,
                    concealmentEvents:(r.concealmentEvents||0)-(last.concealmentEvents||0),jitterMs:r.jitter*1000});
                else fine.truncated=true;
            }
            if (r.timestamp-windowStart.timestamp>=1000) {
                c.windows.push({elapsedSeconds:(r.timestamp-c.initial.timestamp)/1000,
                    packetRate:(r.packetsReceived-windowStart.packetsReceived)*1000/(r.timestamp-windowStart.timestamp),
                    packetsLost:r.packetsLost-windowStart.packetsLost,
                    concealedMs:((r.concealedSamples||0)-(windowStart.concealedSamples||0))/48,jitter:r.jitter});
                windowStart=audioCounters(r);
            }
            last=audioCounters(r);
        }
        return {...await finishRaydioAudioAudit(),fine,
            qualification:'Counters sampled at 100 ms; source silence and listening quality require independent confirmation. This does not prove gapless playback.'};
    } catch (error) {
        if (window.__raydioRtcAudit.capture) await finishRaydioAudioAudit();
        throw error;
    }
};
