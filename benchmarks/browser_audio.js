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
    const pcm = {samples:0,peak:0,squared:0,nearFullScale:0,nonFinite:0,zeroBlocks:0,blocks:0};
    processor.onaudioprocess = e => {
        let silent = true;
        for (let c=0;c<e.inputBuffer.numberOfChannels;c++) for (const x of e.inputBuffer.getChannelData(c)) {
            if (!Number.isFinite(x)) { pcm.nonFinite++; continue; }
            const v=Math.abs(x); pcm.peak=Math.max(pcm.peak,v); pcm.squared+=x*x; pcm.samples++;
            if (v>=0.99997) pcm.nearFullScale++;
            if (v>0.00001) silent=false;
        }
        pcm.blocks++; if (silent) pcm.zeroBlocks++;
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
