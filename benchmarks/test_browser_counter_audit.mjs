import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./browser_counter_audit.js',import.meta.url),'utf8');
async function simulate(mode='normal') {
    let now=0,reads=0;
    const listeners=new Map();
    const target={addEventListener(k,v){listeners.set(k,v)},removeEventListener(k){listeners.delete(k)}};
    const track={...target,id:'track',readyState:'live'};
    const peer={...target,connectionState:'connected',iceConnectionState:'connected',getReceivers:()=>[{track}],getStats:async()=>{
        reads++;
        const final=now>2000;
        if(final&&mode==='disconnect'){peer.connectionState='disconnected';listeners.get('connectionstatechange')?.();peer.connectionState='connected';}
        const row={id:'rtp',type:'inbound-rtp',kind:'audio',ssrc:final&&mode==='identity'?2:1,
            trackIdentifier:'track',codecId:'codec',timestamp:mode==='stale'&&final?1100:now,
            packetsReceived:mode==='reset'&&final?0:Math.floor(now/20),packetsLost:final?-1:0,
            packetsDiscarded:0,concealedSamples:final?480:0,silentConcealedSamples:0,totalSamplesReceived:now*48};
        if(mode==='missing'&&final)delete row.concealedSamples;
        return new Map([['rtp',row],['codec',{clockRate:48000}]]);
    }};
    const window={raydioEndurance:{peers:[peer],running:false}};
    vm.runInNewContext(source,{window,performance:{now:()=>now},setTimeout:(f,ms)=>{now+=ms;queueMicrotask(f)},Date});
    const report=await window.raydioCounterAudit.start({seconds:10});
    assert.equal(reads,3,'selection read, advancing baseline, final read only');
    assert.equal(listeners.size,0,'event listeners removed');
    assert.equal(window.raydioCounterAudit.running,false);
    return report;
}
const normal=await simulate();
assert.equal(normal.status,'completed');assert.equal(normal.elapsedSeconds,10);
assert.equal(normal.delta.packetsLost,-1,'late loss corrections remain signed');
assert.equal(normal.concealmentMs,10);assert.equal(normal.uninterruptedConnection,true);
assert.equal(normal.pcmEnabled,false);assert.ok(normal.missingCounters.includes('nackCount'));
assert.equal(normal.delta.nackCount,undefined,'unsupported optional counter is not invented as zero');
for(const mode of ['identity','reset','missing','stale']) assert.equal((await simulate(mode)).status,'failed',mode);
assert.equal((await simulate('disconnect')).uninterruptedConnection,false);
console.log('PASS: endpoint-only observer, signed corrections, identity/counter/stale validation and cleanup');
