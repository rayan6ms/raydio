// Supervise recorder segments without operating Discord or restarting playback.
// Failed peers and missing time remain visible; a replacement never resets history.
(() => {
    if (window.raydioSession?.active) throw Error('Receiver session already active');
    const api = window.raydioSession = {active:false};
    const now = () => performance.now();
    const utc = () => new Date().toISOString();
    api.start = ({seconds=21600}={}) => {
        if (api.active || window.raydioEndurance.running) throw Error('Recorder already running');
        if (!Number.isInteger(seconds) || seconds<10 || seconds>21600) throw Error('Invalid session duration');
        if (!window.raydioCheckpoint?.timer) throw Error('Persistence must be active');
        api.active=true;
        const s=api.report={version:1,kind:'receiver-session',requestedSeconds:seconds,
            requestedAt:utc(),status:'starting',segments:[],gaps:[],attempts:0,
            note:'Peer rearming is observation only; gaps and failed segments invalidate uninterrupted coverage.'};
        let busy=false, deadline=null, launchAt=now(), lastSessionSave=-Infinity;
        let handled=null, nextAttempt=0, pendingGap=null, stopped=false;
        const persist = async () => {
            await window.raydioCheckpoint.saveSession(s);
            lastSessionSave=now();
        };
        const launch = () => {
            s.attempts++;
            // Reattachment has graph warmup; the outer deadline prevents it extending the session.
            const remaining=deadline===null?seconds:Math.ceil((deadline-now())/1000);
            void window.raydioEndurance.start({seconds:remaining,pcm:true,scheduling:true})
                .catch(e=>{s.launchError=String(e);stopped=true;});
        };
        api.stop = () => {stopped=true;window.raydioEndurance.stop?.();};
        api.tick = async () => {
            if (busy || !api.active) return;
            busy=true;
            try {
                const d=window.raydioEndurance.report;
                if (d?.startedAt && deadline===null) {
                    s.startedAt=d.startedAt;
                    deadline=d.clock.monotonicStartMs+seconds*1000;
                    s.expectedEndAt=new Date(Date.parse(d.startedAt)+seconds*1000).toISOString();
                }
                if (d?.status==='running') {
                    s.status='recording';
                    s.current={requestedAt:d.requestedAt,startedAt:d.startedAt,elapsedSeconds:d.elapsedSeconds};
                    if (pendingGap) {pendingGap.to=d.startedAt;pendingGap=null;await persist();}
                }
                if (d && ['failed','stopped','completed'].includes(d.status) && handled!==d) {
                    // Do not replace the report until durable archival succeeds.
                    await window.raydioCheckpoint.save();
                    if (window.raydioCheckpoint.lastSavedReport!==d ||
                        window.raydioCheckpoint.lastSavedRevision!==[d.status,d.lastProgressAt,d.finishedAt].join('|'))
                        throw Error('Terminal receiver report not persisted; holding rearm');
                    s.segments.push({requestedAt:d.requestedAt,startedAt:d.startedAt,
                        finishedAt:d.finishedAt,status:d.status,error:d.error,
                        receiverSeconds:d.elapsedSeconds||0,pcmSeconds:d.pcm?.audioSeconds||0,
                        coverage:d.coverage});
                    handled=d;delete s.current;
                    if(d.status!=='completed' && !pendingGap) {
                        pendingGap={from:d.lastProgressAt||d.finishedAt,to:null,reason:d.error||d.status};
                        s.gaps.push(pendingGap);
                    }
                    nextAttempt=Math.max(nextAttempt,now()+5000);
                    await persist();
                }
                if ((deadline!==null && now()>=deadline) || stopped ||
                    (deadline===null && now()-launchAt>120000)) {
                    if (window.raydioEndurance.running) {
                        if(stopped || deadline===null || now()>=deadline+2000)window.raydioEndurance.stop();
                        return;
                    }
                    s.status=stopped?'stopped':deadline===null?'failed-to-start':
                        s.segments.length===1 && s.segments[0].status==='completed' &&
                        s.segments[0].coverage?.uninterruptedConnection?'completed':'completed-with-gaps';
                    s.finishedAt=utc();s.elapsedWallSeconds=deadline===null?0:(now()-(deadline-seconds*1000))/1000;
                    if(pendingGap){pendingGap.to=s.finishedAt;pendingGap=null;}
                    await persist();clearInterval(api.timer);api.timer=null;api.active=false;return;
                }
                if (!window.raydioEndurance.running && handled===d) {
                    s.status='waiting-for-receiver';
                    const enoughTime=deadline===null||deadline-now()>=12000;
                    if (s.attempts<32 && enoughTime && now()>=nextAttempt &&
                        window.raydioEndurance.peers.some(p=>p.connectionState==='connected')) {
                        // Failed preflight attempts are bounded and do not operate the voice UI.
                        nextAttempt=now()+60000;launch();
                    }
                }
                if(now()-lastSessionSave>=60000)await persist();
            } catch(e) {s.persistenceError=String(e);s.persistenceErrors=(s.persistenceErrors||0)+1;}
            finally {busy=false;}
        };
        launch();api.timer=setInterval(api.tick,5000);void api.tick();
        return {started:true,requestedAt:s.requestedAt,requestedSeconds:seconds};
    };
})();
