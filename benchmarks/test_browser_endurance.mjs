// Deterministic diagnostic-harness tests; no Discord, network, or real sleeps.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('./browser_endurance.js', import.meta.url), 'utf8');
async function simulate(seconds, disconnect=false) {
    let now=0, removed=0;
    const listeners=new Map();
    const target={addEventListener(t,f){listeners.set(t,f);},removeEventListener(t){listeners.delete(t);removed++;}};
    const row={textContent:'bot1544468432907669644',className:'usernameSpeaking',isConnected:true,parentElement:{parentElement:{parentElement:{}}}};
    const peer={...target,connectionState:'connected',getReceivers:()=>[{track:{...target,id:'track',readyState:'live'}}],async getStats(){
        if(disconnect && now>7000)row.isConnected=false;
        return new Map([['rtp',{id:'rtp',type:'inbound-rtp',kind:'audio',trackIdentifier:'track',timestamp:now,
            packetsReceived:Math.floor(now/20),packetsLost:0,packetsDiscarded:0,nackCount:0,
            concealedSamples:Math.floor(now/3000)*2400,silentConcealedSamples:0,
            totalSamplesReceived:now*48,jitterBufferEmittedCount:now*48,jitterBufferDelay:now*.048,jitter:.003}]]);
    }};
    const window={...target,raydioEndurance:{peers:[peer],running:false},RTCPeerConnection:class{}};
    const sandbox={window,navigator:{onLine:true,mediaDevices:target},performance:{now:()=>now,timeOrigin:0},
        document:{...target,querySelectorAll:s=>s.includes('username')?[row]:[{innerText:'Raydio • Now Playing 1:00 / 3:33 Playing • Loop: ON'}]},
        MutationObserver:class {observe(){} disconnect(){}},
        setTimeout:f=>{now+=1000;queueMicrotask(f);}, Date,console};
    vm.runInNewContext(source,sandbox);
    await window.raydioEndurance.start({seconds,pcm:false,scheduling:false});
    return {report:window.raydioEndurance.report,listeners,removed};
}
const long=await simulate(21600);
assert.equal(long.report.status,'completed');
assert.equal(long.report.diagnosticWindows.length,128);
assert.ok(long.report.diagnosticWindowsDropped>0);
assert.equal(long.report.events.length,4096);
assert.ok(long.report.eventsDropped>0);
assert.ok(long.report.diagnosticWindows.every(w=>w.samples.length<=11&&w.triggers.length<=8));
assert.ok(long.report.diagnosticWindows.some(w=>w.remaining===0));
assert.ok(JSON.stringify(long.report).length < 4*1024*1024);
assert.equal(long.listeners.size,0);
assert.ok(long.removed>=7);
const failed=await simulate(10,true);
assert.equal(failed.report.status,'failed');
assert.match(failed.report.error,/replaced\/disconnected/);
assert.equal(failed.listeners.size,0);
console.log('PASS: six-hour simulated receiver, bounded before/after windows, truncation accounting, disconnect detection and listener cleanup');
