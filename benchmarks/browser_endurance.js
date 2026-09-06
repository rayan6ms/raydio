// Controlled-browser receiver audit. No audio recording, network interception,
// or bot-side instrumentation. Install before joining voice. PCM aggregation
// runs on the audio thread; one-second receiver samples are retained by minute.
(() => {
    if (window.raydioEndurance?.running) throw Error('Endurance audit already running');
    const existing = window.raydioEndurance;
    const Native = window.RTCPeerConnection;
    const peers = existing?.peers || [];
    class Observed extends Native {
        constructor(...args) {
            super(...args);
            peers.push(this);
            if (peers.length > 8) peers.shift();
        }
    }
    if (!existing) window.RTCPeerConnection = Observed;
    const fields = ['timestamp', 'packetsReceived', 'packetsLost', 'bytesReceived',
        'concealedSamples', 'silentConcealedSamples', 'concealmentEvents',
        'totalSamplesReceived', 'jitterBufferDelay', 'jitterBufferEmittedCount'];
    const counters = r => Object.fromEntries(fields.map(k => [k, r[k] ?? 0]));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const worklet = `
    class RaydioMeter extends AudioWorkletProcessor {
        constructor() {
            super(); this.reset();
            this.port.onmessage=({data})=>{
                if(data==='reset'){this.reset();this.port.postMessage({ready:true});}
                else this.report();
            };
        }
        reset() {
            this.frames=0; this.lastReport=0; this.quiet=0;
            this.longestQuiet=0; this.samples=0; this.squared=0;
            this.peak=0; this.clipped=0; this.nonFinite=0; this.empty=0;
            this.quietRuns=[]; this.truncated=false;
        }
        report() {
            this.port.postMessage({audioSeconds:currentTime,frames:this.frames,
                samples:this.samples,squared:this.squared,peak:this.peak,
                clipped:this.clipped,nonFinite:this.nonFinite,empty:this.empty,
                longestQuietFrames:this.longestQuiet,ongoingQuietFrames:this.quiet,
                quietRuns:this.quietRuns,truncated:this.truncated});
            this.samples=0;this.squared=0;this.peak=0;this.clipped=0;
            this.nonFinite=0;this.empty=0;this.quietRuns=[];this.truncated=false;
            this.lastReport=this.frames;
        }
        process(inputs) {
            const channels=inputs[0]; const n=channels[0]?.length || 128;
            if (!channels.length) this.empty+=n;
            for (let i=0;i<n;i++) {
                let quiet=true;
                for (const channel of channels) {
                    const x=channel[i];
                    if (!Number.isFinite(x)) {this.nonFinite++;continue;}
                    const v=Math.abs(x);this.peak=Math.max(this.peak,v);
                    this.samples++;this.squared+=x*x;
                    if(v>=0.99997)this.clipped++;
                    if(v>0.00001)quiet=false;
                }
                this.frames++;
                if(quiet){this.quiet++;this.longestQuiet=Math.max(this.longestQuiet,this.quiet);}
                else if(this.quiet){
                    if(this.quiet>=sampleRate*.02){
                        if(this.quietRuns.length<32)this.quietRuns.push({endFrame:this.frames-1,frames:this.quiet});
                        else this.truncated=true;
                    }
                    this.quiet=0;
                }
            }
            if(this.frames-this.lastReport>=sampleRate/4)this.report();
            // Default output is zero; this tap never duplicates the audible stream.
            return true;
        }
    }
    registerProcessor('raydio-endurance-meter',RaydioMeter);`;
    const api = window.raydioEndurance = {peers, report:null, running:false};
    api.start = async ({seconds=21600, botName='bot1544468432907669644'}={}) => {
        if(api.running)throw Error('Audit already running');
        if(!Number.isInteger(seconds)||seconds<10||seconds>21600)throw Error('Duration must be 10..21600 seconds');
        api.running=true;
        const data=api.report={version:1,status:'starting',requestedSeconds:seconds,
            requestedAt:new Date().toISOString(),minutes:[],events:[],eventsTruncated:false,
            pcm:{samples:0,squared:0,peak:0,nearFullScale:0,nonFinite:0,emptyFrames:0,
                longestQuietMs:0,ongoingQuietMs:0,reports:0,frames:0},
            sampling:{polls:0,stalePolls:0,maxPollMs:0,positiveLossDeltas:0,negativeLossDeltas:0,
                maxConcealedMsPerPoll:0,pcmReportsMissing:0},
            limitations:['Finite receiver observation, not a guarantee of future network behavior',
                'Track phase comes from the once-per-second visible player; silence near track boundaries is retained for review, never silently excluded',
                'No PCM is recorded; source defects and perceptual quality need separate evidence']};
        let ctx,source,meter,observer,peer,stateListener,stopped=false;
        const started=performance.now();let audioStarted=started, priorPosition=null,minute,pcmLastAt=started;
        const panel=()=>[...document.querySelectorAll('main article')].filter(e=>e.innerText.includes('Raydio • Now Playing')).at(-1);
        const phase=()=>{
            const text=panel()?.innerText||'';
            const match=text.match(/(\d+):(\d+) \/ (\d+):(\d+)/);
            const position=match?Number(match[1])*60+Number(match[2]):null;
            const duration=match?Number(match[3])*60+Number(match[4]):null;
            return {positionSeconds:position,durationSeconds:duration,
                label:position===null?'unknown':position<2?'head':position>=duration-3?'tail':'middle',
                playing:text.includes('Playing •'),loop:text.includes('Loop: ON')};
        };
        const event=(kind,detail={})=>{
            if(data.events.length>=12000){data.eventsTruncated=true;return;}
            data.events.push({ms:performance.now()-audioStarted,kind,phase:phase(),...detail});
        };
        api.stop=()=>{stopped=true;};
        try {
            const candidates=[];
            for(const p of peers){
                if(p.connectionState!=='connected')continue;
                for(const r of(await p.getStats()).values())
                    if(r.type==='inbound-rtp'&&r.kind==='audio')candidates.push({p,r});
            }
            await sleep(1100);
            const active=[];
            for(const c of candidates){const r=(await c.p.getStats()).get(c.r.id);
                if(r&&r.packetsReceived-c.r.packetsReceived>=40)active.push({...c,r});}
            if(active.length!==1)throw Error('Expected exactly one advancing receiver');
            peer=active[0].p;
            const id=active[0].r.id;
            const receiver=peer.getReceivers().find(r=>r.track.id===active[0].r.trackIdentifier);
            if(!receiver||receiver.track.readyState!=='live')throw Error('Receiver is not live');
            const row=[...document.querySelectorAll('.username__07f91')].find(e=>e.textContent===botName);
            if(!row||!row.className.includes('usernameSpeaking'))throw Error('Bot is not visibly speaking');
            ctx=new AudioContext({sampleRate:48000});await ctx.resume();
            if(ctx.state!=='running')throw Error('Audio context is suspended');
            const moduleUrl=URL.createObjectURL(new Blob([worklet],{type:'application/javascript'}));
            try{await ctx.audioWorklet.addModule(moduleUrl);}finally{URL.revokeObjectURL(moduleUrl);}
            meter=new AudioWorkletNode(ctx,'raydio-endurance-meter',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});
            source=ctx.createMediaStreamSource(new MediaStream([receiver.track]));
            source.connect(meter);meter.connect(ctx.destination);
            // A newly connected analysis graph briefly outputs its own empty
            // startup buffer. Prime that graph before the measured interval.
            await sleep(1100);
            await new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>reject(Error('Audio meter reset timed out')),2000);
                meter.port.onmessage=({data:m})=>{if(m.ready){clearTimeout(timer);resolve();}};
                meter.port.postMessage('reset');
            });
            audioStarted=performance.now();pcmLastAt=audioStarted;
            data.startedAt=new Date().toISOString();data.status='running';data.sampleRate=ctx.sampleRate;data.graphWarmupMs=1100;
            let last=counters((await peer.getStats()).get(id));data.initial=last;
            let speaking=true;
            observer=new MutationObserver(()=>{
                const next=row.className.includes('usernameSpeaking');
                if(next!==speaking){event('speaking',{speaking:next});speaking=next;}
            });
            observer.observe(row.parentElement.parentElement.parentElement,{subtree:true,attributes:true,attributeFilter:['class']});
            stateListener=()=>event('connection',{state:peer.connectionState});
            peer.addEventListener('connectionstatechange',stateListener);
            meter.port.onmessage=({data:m})=>{
                pcmLastAt=performance.now();const p=data.pcm;
                p.samples+=m.samples;p.squared+=m.squared;p.peak=Math.max(p.peak,m.peak);
                p.nearFullScale+=m.clipped;p.nonFinite+=m.nonFinite;p.emptyFrames+=m.empty;
                p.longestQuietMs=Math.max(p.longestQuietMs,m.longestQuietFrames*1000/ctx.sampleRate);
                p.ongoingQuietMs=m.ongoingQuietFrames*1000/ctx.sampleRate;p.reports++;p.frames=m.frames;
                if(m.clipped||m.nonFinite||m.empty)event('pcm-anomaly',{clipped:m.clipped,nonFinite:m.nonFinite,emptyFrames:m.empty});
                for(const q of m.quietRuns)event('quiet',{durationMs:q.frames*1000/ctx.sampleRate,endFrame:q.endFrame,audioSeconds:m.audioSeconds});
                if(m.truncated){data.eventsTruncated=true;event('pcm-events-truncated');}
            };
            while(performance.now()-audioStarted<seconds*1000&&!stopped){
                await sleep(Math.min(1000,Math.max(1,seconds*1000-(performance.now()-audioStarted))));
                const raw=(await peer.getStats()).get(id);
                if(!raw||peer.connectionState==='closed'||!row.isConnected)throw Error('Receiver or voice row was replaced/disconnected');
                if(ctx.state!=='running')throw Error('Audio context stopped running');
                const now=counters(raw),dt=now.timestamp-last.timestamp;
                if(dt<=0){data.sampling.stalePolls++;continue;}
                const delta=Object.fromEntries(fields.map(k=>[k,now[k]-last[k]]));
                const elapsedMs=now.timestamp-data.initial.timestamp;
                const p=phase();
                if(p.positionSeconds!==null&&priorPosition!==null&&p.positionSeconds+5<priorPosition)event('track-restart',{priorPosition});
                if(p.positionSeconds!==null)priorPosition=p.positionSeconds;
                const index=Math.floor(elapsedMs/60000);
                if(!minute||minute.index!==index){minute={index,fromMs:elapsedMs-dt,toMs:elapsedMs,polls:0,packets:0,lostNet:0,positiveLoss:0,concealedSamples:0,silentConcealedSamples:0,concealmentEvents:0,maxJitterMs:0,maxPollMs:0,maxPcmSilenceMs:0};data.minutes.push(minute);}
                minute.toMs=elapsedMs;minute.polls++;minute.packets+=delta.packetsReceived;
                minute.lostNet+=delta.packetsLost;minute.positiveLoss+=Math.max(0,delta.packetsLost);
                minute.concealedSamples+=delta.concealedSamples;minute.silentConcealedSamples+=delta.silentConcealedSamples;
                minute.concealmentEvents+=delta.concealmentEvents;minute.maxJitterMs=Math.max(minute.maxJitterMs,raw.jitter*1000);
                minute.maxPollMs=Math.max(minute.maxPollMs,dt);minute.maxPcmSilenceMs=Math.max(minute.maxPcmSilenceMs,data.pcm.ongoingQuietMs);
                data.sampling.polls++;data.sampling.maxPollMs=Math.max(data.sampling.maxPollMs,dt);
                data.sampling.positiveLossDeltas+=Math.max(0,delta.packetsLost);data.sampling.negativeLossDeltas+=Math.min(0,delta.packetsLost);
                data.sampling.maxConcealedMsPerPoll=Math.max(data.sampling.maxConcealedMsPerPoll,delta.concealedSamples/48);
                if(delta.packetsLost||delta.concealedSamples||delta.packetsReceived===0||dt>2000)
                    event('receiver',{windowMs:dt,packets:delta.packetsReceived,lost:delta.packetsLost,concealedMs:delta.concealedSamples/48,silentConcealedMs:delta.silentConcealedSamples/48,jitterMs:raw.jitter*1000});
                if(performance.now()-pcmLastAt>2000){data.sampling.pcmReportsMissing++;event('pcm-report-gap');}
                data.current=now;data.elapsedSeconds=elapsedMs/1000;data.lastProgressAt=new Date().toISOString();data.currentPhase=p;
                last=now;
            }
            meter.port.postMessage('flush');await sleep(50);
            data.status=stopped?'stopped':'completed';
        }catch(e){data.status='failed';data.error=String(e);}
        finally{
            observer?.disconnect();if(peer&&stateListener)peer.removeEventListener('connectionstatechange',stateListener);
            meter?.disconnect();source?.disconnect();if(ctx)await ctx.close();api.running=false;
            data.finishedAt=new Date().toISOString();
            data.observationWallSeconds=(performance.now()-audioStarted)/1000;
            data.pcm.audioSeconds=data.pcm.frames/(data.sampleRate||48000);
            if(data.current&&data.initial)data.delta=Object.fromEntries(fields.map(k=>[k,data.current[k]-data.initial[k]]));
            data.pcm.rms=Math.sqrt(data.pcm.squared/Math.max(1,data.pcm.samples));
            if(data.pcm.ongoingQuietMs>=20)event('quiet-at-end',{durationMs:data.pcm.ongoingQuietMs});
        }
        return {status:data.status,elapsedSeconds:data.elapsedSeconds,error:data.error};
    };
    api.summary=()=>{
        const d=api.report;if(!d)return {status:'not-started'};
        return {status:d.status,startedAt:d.startedAt,elapsedSeconds:d.elapsedSeconds,lastProgressAt:d.lastProgressAt,
            minutes:d.minutes.length,events:d.events.length,eventsTruncated:d.eventsTruncated,
            pcm:d.pcm,sampling:d.sampling,currentPhase:d.currentPhase,error:d.error,
            delta:d.current&&d.initial?Object.fromEntries(fields.map(k=>[k,d.current[k]-d.initial[k]])):null};
    };
})();
