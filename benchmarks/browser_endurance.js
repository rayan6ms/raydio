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
        'packetsDiscarded', 'nackCount', 'fecPacketsReceived', 'fecPacketsDiscarded',
        'concealedSamples', 'silentConcealedSamples', 'concealmentEvents',
        'totalSamplesReceived', 'jitterBufferDelay', 'jitterBufferEmittedCount',
        'insertedSamplesForDeceleration', 'removedSamplesForAcceleration',
        'jitterBufferTargetDelay', 'jitterBufferMinimumDelay'];
    const counters = r => Object.fromEntries(fields.map(k => [k, r[k] ?? 0]));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const worklet = `
    class RaydioMeter extends AudioWorkletProcessor {
        constructor() {
            super(); this.reset();
            this.port.onmessage=({data})=>{
                if(data==='reset'){this.reset();this.port.postMessage({ready:true,contextTime:currentTime});}
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
    api.start = async ({seconds=21600, botName='bot1544468432907669644', pcm=true, scheduling=false}={}) => {
        if(api.running)throw Error('Audit already running');
        if(!Number.isInteger(seconds)||seconds<10||seconds>21600)throw Error('Duration must be 10..21600 seconds');
        if(typeof pcm!=='boolean')throw Error('pcm must be boolean');
        if(typeof scheduling!=='boolean')throw Error('scheduling must be boolean');
        api.running=true;
        const data=api.report={version:1,status:'starting',requestedSeconds:seconds,pcmEnabled:pcm,
            requestedAt:new Date().toISOString(),minutes:[],events:[],eventsTruncated:false,eventsDropped:0,
            network:{onlineAtStart:navigator.onLine},
            diagnosticWindows:[],diagnosticWindowsDropped:0,
            diagnosticSampleFields:['elapsedMs','windowMs','packets','lost','discarded','concealedMs','silentMs','jitterMs','meanBufferMs','rttMs'],
            receiverScheduling:{enabled:scheduling,longTasksSupported:false,longTasks:0,
                totalLongTaskMs:0,maxLongTaskMs:0,initialVisibility:document.visibilityState},
            pcm:{samples:0,squared:0,peak:0,nearFullScale:0,nonFinite:0,emptyFrames:0,
                longestQuietMs:0,ongoingQuietMs:0,reports:0,frames:0},
            sampling:{polls:0,stalePolls:0,maxPollMs:0,positiveLossDeltas:0,negativeLossDeltas:0,
                maxConcealedMsPerPoll:0,pcmReportsMissing:0},
            limitations:['Finite receiver observation, not a guarantee of future network behavior',
                'Track phase comes from the once-per-second visible player; silence near track boundaries is retained for review, never silently excluded',
                'No PCM is recorded; source defects and perceptual quality need separate evidence']};
        let ctx,source,meter,observer,peer,stateListener,longTaskObserver,visibilityListener,stopped=false;
        const listeners=[];const history=[];
        const listen=(target,type,handler)=>{target.addEventListener(type,handler);listeners.push(()=>target.removeEventListener(type,handler));};
        const started=performance.now();let audioStarted=started, priorPosition=null,minute,pcmLastAt=started,resetSent=started,resetAck=started,eventSequence=0;
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
            if(data.events.length>=4096){data.eventsTruncated=true;data.eventsDropped++;data.events.shift();}
            const at=performance.now()-audioStarted, trackPhase=phase();
            data.events.push({sequence:++eventSequence,ms:at,kind,phase:trackPhase,...detail});
            const trigger=(kind==='speaking'&&!detail.speaking)
                ||(kind==='quiet'&&detail.durationMs>=100&&trackPhase.label==='middle')
                ||(kind==='receiver'&&(detail.packets===0||detail.windowMs>2000||detail.concealedMs>=40))
                ||['connection','ice','network-offline','audio-context','track-ended','track-muted'].includes(kind);
            if(trigger){
                const prior=data.diagnosticWindows.at(-1);
                if(prior&&prior.remaining>0){if(prior.triggers.length<8)prior.triggers.push({ms:at,kind});}
                else{
                    if(data.diagnosticWindows.length>=256){data.diagnosticWindows.shift();data.diagnosticWindowsDropped++;}
                    data.diagnosticWindows.push({ms:at,triggers:[{ms:at,kind}],samples:history.slice(),remaining:5});
                }
            }
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
            if(pcm){
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
                    meter.port.onmessage=({data:m})=>{if(m.ready){resetAck=performance.now();data.pcmResetContextTime=m.contextTime;clearTimeout(timer);resolve();}};
                    resetSent=performance.now();meter.port.postMessage('reset');
                });
            }
            audioStarted=performance.now();pcmLastAt=audioStarted;
            data.startedAt=new Date().toISOString();data.clock={wallStartMs:Date.now(),monotonicStartMs:audioStarted,timeOrigin:performance.timeOrigin};data.clock.pcmResetAckDelayMs=pcm?resetAck-resetSent:null;data.clock.pcmEpochUncertaintyMs=pcm?audioStarted-resetSent:null;data.status='running';data.sampleRate=ctx?.sampleRate||48000;data.graphWarmupMs=pcm?1100:0;
            if(scheduling){
                // Event-driven diagnostic only: no new polling timer, network
                // interception, raw audio, or changes to WebRTC buffering.
                const recordLongTasks=entries=>{
                    for(const entry of entries){
                        if(entry.startTime<audioStarted)continue;
                        const s=data.receiverScheduling;
                        s.longTasks++;s.totalLongTaskMs+=entry.duration;
                        s.maxLongTaskMs=Math.max(s.maxLongTaskMs,entry.duration);
                        event('receiver-long-task',{ms:entry.startTime-audioStarted+entry.duration,startMs:entry.startTime-audioStarted,
                            durationMs:entry.duration});
                    }
                };
                if(PerformanceObserver.supportedEntryTypes.includes('longtask')){
                    data.receiverScheduling.longTasksSupported=true;
                    longTaskObserver=new PerformanceObserver(list=>recordLongTasks(list.getEntries()));
                    longTaskObserver.observe({type:'longtask',buffered:false});
                    api.flushScheduling=()=>recordLongTasks(longTaskObserver.takeRecords());
                }
                visibilityListener=()=>event('receiver-visibility',{state:document.visibilityState});
                document.addEventListener('visibilitychange',visibilityListener);
            }
            const initialRaw=(await peer.getStats()).get(id);
            data.availableCounters=fields.filter(k=>typeof initialRaw[k]==='number');
            if(!initialRaw)throw Error('Receiver disappeared before baseline');
            if(['timestamp','packetsReceived','packetsLost','concealedSamples','silentConcealedSamples','totalSamplesReceived'].some(k=>typeof initialRaw[k]!=='number'))
                throw Error('Required receiver quality counters unavailable');
            data.receiverIdentity={id,ssrc:initialRaw.ssrc,trackIdentifier:initialRaw.trackIdentifier};
            data.missingCounters=fields.filter(k=>typeof initialRaw[k]!=='number');
            let last=counters(initialRaw);data.initial=last;
            let speaking=true;
            observer=new MutationObserver(()=>{
                const next=row.className.includes('usernameSpeaking');
                if(next!==speaking){event('speaking',{speaking:next});speaking=next;}
            });
            observer.observe(row.parentElement.parentElement.parentElement,{subtree:true,attributes:true,attributeFilter:['class']});
            stateListener=()=>event('connection',{state:peer.connectionState});
            peer.addEventListener('connectionstatechange',stateListener);
            listen(peer,'iceconnectionstatechange',()=>event('ice',{state:peer.iceConnectionState}));
            listen(window,'online',()=>event('network-online'));
            listen(window,'offline',()=>event('network-offline'));
            listen(receiver.track,'mute',()=>event('track-muted'));
            listen(receiver.track,'unmute',()=>event('track-unmuted'));
            listen(receiver.track,'ended',()=>event('track-ended'));
            if(ctx){
                data.audioContext={sampleRate:ctx.sampleRate,baseLatency:ctx.baseLatency,outputLatency:ctx.outputLatency};
                listen(ctx,'statechange',()=>event('audio-context',{state:ctx.state}));
            }
            if(navigator.mediaDevices)listen(navigator.mediaDevices,'devicechange',()=>event('audio-device-change'));
            const codec=initialRaw.codecId?(await peer.getStats()).get(initialRaw.codecId):null;
            if(codec)data.codec={mimeType:codec.mimeType,clockRate:codec.clockRate,channels:codec.channels};
            const samplesPerMs=(codec?.clockRate||48000)/1000;
            if(meter)meter.port.onmessage=({data:m})=>{
                pcmLastAt=performance.now();const p=data.pcm;
                // Re-anchor the audio clock on each report. This accounts for
                // long-run device-clock drift without using delayed receipt as
                // the quiet interval's timestamp. Accuracy is limited by one
                // AudioContext render quantum plus the measured reset delay.
                const contextNow=ctx.currentTime;
                const audioMs=frame=>(pcmLastAt-audioStarted)-(contextNow-data.pcmResetContextTime-frame/ctx.sampleRate)*1000;
                const drift=audioMs(m.frames)-m.frames*1000/ctx.sampleRate;
                data.clock.pcmWallDriftMinMs=Math.min(data.clock.pcmWallDriftMinMs??drift,drift);
                data.clock.pcmWallDriftMaxMs=Math.max(data.clock.pcmWallDriftMaxMs??drift,drift);
                p.endWallMs=audioMs(m.frames);
                p.samples+=m.samples;p.squared+=m.squared;p.peak=Math.max(p.peak,m.peak);
                p.nearFullScale+=m.clipped;p.nonFinite+=m.nonFinite;p.emptyFrames+=m.empty;
                p.longestQuietMs=Math.max(p.longestQuietMs,m.longestQuietFrames*1000/ctx.sampleRate);
                p.ongoingQuietMs=m.ongoingQuietFrames*1000/ctx.sampleRate;p.reports++;p.frames=m.frames;
                if(m.clipped||m.nonFinite||m.empty)event('pcm-anomaly',{clipped:m.clipped,nonFinite:m.nonFinite,emptyFrames:m.empty});
                // endFrame is measured on the audio thread from reset. A report
                // can arrive up to 250 ms later, or later still if UI work stalls.
                for(const q of m.quietRuns)event('quiet',{durationMs:q.frames*1000/ctx.sampleRate,
                    endFrame:q.endFrame,audioEndMs:audioMs(q.endFrame),
                    reportDelayMs:pcmLastAt-audioStarted-audioMs(q.endFrame),
                    audioSeconds:m.audioSeconds});
                if(m.truncated){data.eventsTruncated=true;event('pcm-events-truncated');}
            };
            while(performance.now()-audioStarted<seconds*1000&&!stopped){
                await sleep(Math.min(1000,Math.max(1,seconds*1000-(performance.now()-audioStarted))));
                const report=await peer.getStats();
                const raw=report.get(id);
                // Read only safe connection metrics, never candidate addresses.
                const transport=[...report.values()].find(r=>r.type==='transport'&&r.selectedCandidatePairId);
                const pair=transport?report.get(transport.selectedCandidatePairId):null;
                if(pair)data.network.current={rttMs:pair.currentRoundTripTime*1000,state:pair.state,
                    bytesReceived:pair.bytesReceived,bytesSent:pair.bytesSent};
                if(!raw||['closed','failed'].includes(peer.connectionState)||!row.isConnected)throw Error('Receiver or voice row was replaced/disconnected');
                if(ctx&&ctx.state!=='running')throw Error('Audio context stopped running');
                if(raw.ssrc!==data.receiverIdentity.ssrc||raw.trackIdentifier!==data.receiverIdentity.trackIdentifier)
                    throw Error('Receiver identity changed');
                if(data.availableCounters.some(k=>typeof raw[k]!=='number'))throw Error('Receiver counter disappeared');
                const now=counters(raw),dt=now.timestamp-last.timestamp;
                if(data.availableCounters.filter(k=>k!=='packetsLost'&&k!=='timestamp').some(k=>now[k]<last[k]))
                    throw Error('Receiver cumulative counter reset');
                if(dt<=0){data.sampling.stalePolls++;continue;}
                const delta=Object.fromEntries(fields.map(k=>[k,now[k]-last[k]]));
                const elapsedMs=now.timestamp-data.initial.timestamp;
                const sample=[elapsedMs,dt,delta.packetsReceived,delta.packetsLost,delta.packetsDiscarded,
                    delta.concealedSamples/samplesPerMs,delta.silentConcealedSamples/samplesPerMs,raw.jitter*1000,
                    delta.jitterBufferEmittedCount?delta.jitterBufferDelay*1000/delta.jitterBufferEmittedCount:null, data.network.current?.rttMs??null];
                for(const window of data.diagnosticWindows)if(window.remaining>0){window.samples.push(sample);window.remaining--;}
                history.push(sample);if(history.length>6)history.shift();
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
                data.sampling.maxConcealedMsPerPoll=Math.max(data.sampling.maxConcealedMsPerPoll,delta.concealedSamples/samplesPerMs);
                if(delta.packetsLost||delta.packetsDiscarded||delta.nackCount||delta.concealedSamples||delta.packetsReceived===0||dt>2000)
                    event('receiver',{windowMs:dt,packets:delta.packetsReceived,lost:delta.packetsLost,concealedMs:delta.concealedSamples/samplesPerMs,silentConcealedMs:delta.silentConcealedSamples/samplesPerMs,jitterMs:raw.jitter*1000,
                        discarded:delta.packetsDiscarded,nacks:delta.nackCount,
                        fecReceived:delta.fecPacketsReceived,fecDiscarded:delta.fecPacketsDiscarded,
                        insertedMs:delta.insertedSamplesForDeceleration/samplesPerMs,removedMs:delta.removedSamplesForAcceleration/samplesPerMs,
                        emittedSamples:delta.jitterBufferEmittedCount,receivedSamples:delta.totalSamplesReceived,
                        meanBufferMs:delta.jitterBufferEmittedCount?delta.jitterBufferDelay*1000/delta.jitterBufferEmittedCount:null});
                if(pcm&&performance.now()-pcmLastAt>2000){data.sampling.pcmReportsMissing++;event('pcm-report-gap');}
                data.current=now;data.elapsedSeconds=elapsedMs/1000;data.lastProgressAt=new Date().toISOString();data.currentPhase=p;
                last=now;
            }
            meter?.port.postMessage('flush');await sleep(50);
            data.status=stopped?'stopped':'completed';
        }catch(e){data.status='failed';data.error=String(e);}
        finally{
            api.flushScheduling?.();delete api.flushScheduling;
            longTaskObserver?.disconnect();
            if(visibilityListener)document.removeEventListener('visibilitychange',visibilityListener);
            for(const remove of listeners)remove();
            observer?.disconnect();if(peer&&stateListener)peer.removeEventListener('connectionstatechange',stateListener);
            meter?.disconnect();source?.disconnect();if(ctx)await ctx.close();api.running=false;
            data.finishedAt=new Date().toISOString();
            data.observationWallSeconds=(performance.now()-audioStarted)/1000;
            data.pcm.audioSeconds=data.pcm.frames/(data.sampleRate||48000);
            if(data.current&&data.initial)data.delta=Object.fromEntries(fields.map(k=>[k,data.current[k]-data.initial[k]]));
            data.pcm.rms=Math.sqrt(data.pcm.squared/Math.max(1,data.pcm.samples));
            if(data.pcm.ongoingQuietMs>=20)event('quiet-at-end',{durationMs:data.pcm.ongoingQuietMs,audioEndMs:data.pcm.endWallMs??data.pcm.frames*1000/data.sampleRate});
            data.coverage={
                receiverSeconds:data.elapsedSeconds||0,pcmSeconds:data.pcm.audioSeconds,
                completePollCoverage:data.status==='completed' && data.elapsedSeconds>=seconds-.1
                    && data.sampling.stalePolls===0 && data.sampling.maxPollMs<=2000,
                completePcmCoverage:pcm ? data.pcm.audioSeconds>=seconds-.1
                    && data.sampling.pcmReportsMissing===0 && data.pcm.emptyFrames===0 : null,
                // Completing the observation does not imply uninterrupted
                // transport: a peer can disconnect and recover during the run.
                uninterruptedConnection:data.status==='completed' && !data.eventsTruncated
                    && !data.events.some(e=>['ice','connection'].includes(e.kind)
                        && ['disconnected','failed','closed'].includes(e.state)),
                completeEventHistory:!data.eventsTruncated,
                retainedDiagnosticWindows:data.diagnosticWindows.length,
                droppedDiagnosticWindows:data.diagnosticWindowsDropped,
            };
        }
        return {status:data.status,elapsedSeconds:data.elapsedSeconds,error:data.error};
    };
    api.summary=()=>{
        const d=api.report;if(!d)return {status:'not-started'};
        return {status:d.status,startedAt:d.startedAt,elapsedSeconds:d.elapsedSeconds,lastProgressAt:d.lastProgressAt,
            minutes:d.minutes.length,events:d.events.length,eventsTruncated:d.eventsTruncated,
            pcmEnabled:d.pcmEnabled,pcm:d.pcmEnabled?d.pcm:null,sampling:d.sampling,
            receiverScheduling:d.receiverScheduling,currentPhase:d.currentPhase,error:d.error,
            delta:d.current&&d.initial?Object.fromEntries(fields.map(k=>[k,d.current[k]-d.initial[k]])):null};
    };
})();
