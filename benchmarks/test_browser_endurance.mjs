// Deterministic diagnostic-harness tests; no Discord, network, or real sleeps.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('./browser_endurance.js', import.meta.url), 'utf8');
async function simulate(seconds, mode='normal') {
    let now=0, removed=0;
    const listeners=new Map();
    const target={addEventListener(t,f){listeners.set(t,f);},removeEventListener(t){listeners.delete(t);removed++;}};
    const newRow=()=>({textContent:'bot1544468432907669644',className:'usernameSpeaking',isConnected:true,parentElement:{parentElement:{parentElement:{}}}});
    let row=newRow(), replaced=false;
    const track={...target,id:'track',readyState:'live'};
    const peer={...target,connectionState:'connected',getReceivers:()=>[{track}],async getStats(){
        if(now>7000){
            if(mode==='closed')peer.connectionState='closed';
            if(mode==='track-ended')track.readyState='ended';
            if(mode==='stats-missing')return new Map();
            if(mode==='row-replaced'&&!replaced){row.isConnected=false;row=newRow();replaced=true;}
            if(mode==='row-missing')row.isConnected=now>13000;
        }
        return new Map([['rtp',{id:'rtp',type:'inbound-rtp',kind:'audio',trackIdentifier:'track',timestamp:now,
            ssrc:mode==='identity-change'&&now>7000?2:1,
            packetsReceived:mode==='counter-reset'&&now>7000?0:Math.floor(now/20),packetsLost:0,packetsDiscarded:0,nackCount:0,
            concealedSamples:Math.floor(now/3000)*2400,silentConcealedSamples:0,
            totalSamplesReceived:now*48,jitterBufferEmittedCount:now*48,jitterBufferDelay:now*.048,jitter:.003}]]);
    }};
    const window={...target,raydioEndurance:{peers:[peer],running:false},RTCPeerConnection:class{}};
    const sandbox={window,navigator:{onLine:true,mediaDevices:target},performance:{now:()=>now,timeOrigin:0},
        document:{...target,querySelectorAll:s=>s.includes('username')?(row.isConnected?[row]:[]):(mode==='row-missing'&&now>7000&&now<=13000?[]:[{innerText:'Raydio • Now Playing 1:00 / 3:33 Playing • Loop: ON'}])},
        MutationObserver:class {observe(){} disconnect(){}},
        setTimeout:f=>{now+=1000;queueMicrotask(f);}, Date,console};
    vm.runInNewContext(source,sandbox);
    await window.raydioEndurance.start({seconds,pcm:false,scheduling:false});
    return {report:window.raydioEndurance.report,listeners,removed};
}
const long=await simulate(21600);
assert.equal(long.report.status,'completed');
assert.equal(long.report.diagnosticWindows.length,256);
assert.ok(long.report.diagnosticWindowsDropped>0);
assert.equal(long.report.events.length,4096);
assert.ok(long.report.eventsDropped>0);
assert.ok(long.report.diagnosticWindows.every(w=>w.samples.length<=11&&w.triggers.length<=8));
assert.ok(long.report.diagnosticWindows.some(w=>w.remaining===0));
assert.ok(JSON.stringify(long.report).length < 4*1024*1024);
assert.equal(long.report.coverage.uninterruptedConnection,false); // dropped history cannot prove continuity
assert.equal(long.listeners.size,0);
assert.ok(long.removed>=7);
for(const [mode,message] of [['closed',/Voice peer closed/],['stats-missing',/Receiver stats disappeared/],['track-ended',/Receiver track ended/],['identity-change',/Receiver identity changed/],['counter-reset',/counter reset/]]){
    const failed=await simulate(10,mode);
    assert.equal(failed.report.status,'failed',mode);
    assert.match(failed.report.error,message);
    assert.equal(failed.listeners.size,0);
    assert.equal(failed.report.coverage.uninterruptedConnection,false);
}
for(const mode of ['row-replaced','row-missing']){
    const rebound=await simulate(20,mode);
    const control=await simulate(20);
    assert.equal(rebound.report.status,'completed');
    assert.equal(rebound.report.coverage.uninterruptedConnection,true);
    assert.equal(rebound.report.coverage.completeSpeakingObservation,false);
    assert.ok(rebound.report.events.some(e=>e.kind==='voice-row-rebound'&&e.speakingHistoryGap));
    assert.equal(JSON.stringify(rebound.report.delta),JSON.stringify(control.report.delta));
    assert.equal(rebound.listeners.size,0);
    if(mode==='row-missing'){
        assert.ok(rebound.report.uiObservation.missingRowPolls>0);
        assert.equal(rebound.report.coverage.completeTrackPhaseObservation,false);
    }
}
const short=await simulate(10);
assert.equal(short.report.coverage.uninterruptedConnection,true);
console.log('PASS: six-hour simulation, UI replacement/absence preserves receiver counters, true disconnect/identity/reset failures, bounded diagnostics and cleanup');
