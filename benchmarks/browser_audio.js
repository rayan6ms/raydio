// Controlled Discord browser audit, explicit live-test authorization required.
// Install before reconnecting the browser listener. Collects aggregate counters
// and sample statistics only; no recordings, URLs, credentials, or track data.
const installRaydioAudioAudit = () => {
    if (window.__raydioRtcAudit) return;
    const Native = window.RTCPeerConnection;
    const peers = [];
    class Observed extends Native {
        constructor(...args) {
            super(...args);
            if (peers.length < 8) peers.push(this);
        }
    }
    window.RTCPeerConnection = Observed;
    window.__raydioRtcAudit = {Native, Observed, peers};
};

const startRaydioAudioAudit = async () =>{const a=window.__raydioRtcAudit;const p=a.peers.at(-1);const stats=await p.getStats();const r=Array.from(stats.values()).find(r=>r.type==='inbound-rtp'&&r.kind==='audio'&&r.packetsReceived>0);const receiver=p.getReceivers().find(x=>x.track.id===r.trackIdentifier);if(!receiver)return {error:'No matching active audio receiver'};const context=new AudioContext({sampleRate:48000});const source=context.createMediaStreamSource(new MediaStream([receiver.track]));const processor=context.createScriptProcessor(2048,2,2);const measured={samples:0,peak:0,squared:0,nearFullScale:0,nonFinite:0,zeroBlocks:0,blocks:0};processor.onaudioprocess=e=>{let silent=true;for(let c=0;c<e.inputBuffer.numberOfChannels;c++){const samples=e.inputBuffer.getChannelData(c);for(const x of samples){if(!Number.isFinite(x)){measured.nonFinite++;continue;}const v=Math.abs(x);measured.peak=Math.max(measured.peak,v);measured.squared+=x*x;measured.samples++;if(v>=0.99997)measured.nearFullScale++;if(v>0.00001)silent=false;}}measured.blocks++;if(silent)measured.zeroBlocks++;};source.connect(processor);processor.connect(context.destination);a.capture={context,source,processor,measured};a.initial=Object.fromEntries(['timestamp','packetsReceived','packetsLost','bytesReceived','jitter','concealedSamples','silentConcealedSamples','concealmentEvents','totalSamplesReceived','jitterBufferDelay','jitterBufferEmittedCount','totalAudioEnergy','totalSamplesDuration'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));return {state:context.state,initial:a.initial};};

const finishRaydioAudioAudit = async () =>{const a=window.__raydioRtcAudit;const stats=await a.peers.at(-1).getStats();const r=Array.from(stats.values()).find(r=>r.type==='inbound-rtp'&&r.kind==='audio'&&r.packetsReceived>0);const current=Object.fromEntries(Object.keys(a.initial).map(k=>[k,r[k]]));const delta=Object.fromEntries(Object.keys(a.initial).filter(k=>k!=='jitter').map(k=>[k,current[k]-a.initial[k]]));const c=a.capture;const m={...c.measured};c.processor.disconnect();c.source.disconnect();await c.context.close();return {initial:a.initial,current,delta,pcm:{...m,rms:Math.sqrt(m.squared/Math.max(1,m.samples))},receiverBufferMeanMs:1000*delta.jitterBufferDelay/delta.jitterBufferEmittedCount};};

const restoreRaydioAudioAudit = async () => {
    const audit = window.__raydioRtcAudit;
    if (!audit) return;
    const capture = audit.capture;
    if (capture && capture.context.state !== 'closed') {
        capture.processor.disconnect();
        capture.source.disconnect();
        await capture.context.close();
    }
    if (window.RTCPeerConnection === audit.Observed) window.RTCPeerConnection = audit.Native;
    delete window.__raydioRtcAudit;
};
