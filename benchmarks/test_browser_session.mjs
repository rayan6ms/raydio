import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./browser_session.js',import.meta.url),'utf8');
function setup(){
    let time=0, launches=0, saved=[],sessions=[],fail=false;
    const peer={connectionState:'connected'};
    const audit={peers:[peer],running:false,report:null,start({seconds}){
        this.running=true;this.report={status:'running',requestedSeconds:seconds,requestedAt:`segment${++launches}`,
            startedAt:new Date(time).toISOString(),clock:{monotonicStartMs:time},elapsedSeconds:0};
        return new Promise(()=>{});
    },stop(){this.running=false;Object.assign(this.report,{status:'stopped',finishedAt:new Date(time).toISOString()});}};
    const checkpoint={timer:1,async save(){
        if(fail)return;
        saved.push(structuredClone(audit.report));this.lastSavedReport=audit.report;
        this.lastSavedRevision=[audit.report.status,audit.report.lastProgressAt,audit.report.finishedAt].join('|');
    },async saveSession(s){sessions.push(structuredClone(s));}};
    const window={raydioEndurance:audit,raydioCheckpoint:checkpoint};
    vm.runInNewContext(source,{window,Date,performance:{now:()=>time},setInterval:()=>1,clearInterval:()=>{}});
    const session=window.raydioSession;
    return {session,audit,peer,saved,sessions,checkpoint,get launches(){return launches;},
        async advance(t){time=t;await session.tick();},failureWrites(v){fail=v;},
        finish(status){audit.running=false;Object.assign(audit.report,{status,finishedAt:new Date(time).toISOString(),
            lastProgressAt:new Date(time).toISOString(),elapsedSeconds:time/1000,
            coverage:{uninterruptedConnection:status==='completed'},error:status==='failed'?'Voice peer failed':undefined});}};
}
const a=setup();a.session.start({seconds:120});await a.advance(1000);
a.finish('failed');a.peer.connectionState='failed';a.failureWrites(true);await a.advance(10000);
assert.equal(a.launches,1);assert.equal(a.session.report.segments.length,0);
a.failureWrites(false);await a.advance(15000);
assert.equal(a.session.report.segments.length,1);assert.equal(a.session.report.gaps.length,1);
await a.advance(25000);assert.equal(a.launches,1,'no UI operations or fake connected receiver');
a.peer.connectionState='connected';await a.advance(30000);assert.equal(a.launches,2);
await a.advance(31000);assert.ok(a.session.report.gaps[0].to);
assert.equal(a.saved[0].status,'failed','failure persisted before replacement');
a.finish('completed');await a.advance(120000);
assert.equal(a.session.report.status,'completed-with-gaps');assert.equal(a.session.active,false);
assert.equal(a.session.report.segments.length,2);
const b=setup();b.session.start({seconds:10});await b.advance(1000);b.finish('completed');await b.advance(10000);
assert.equal(b.session.report.status,'completed');assert.equal(b.session.report.gaps.length,0);
const c=setup();c.session.start({seconds:10});await c.advance(1000);c.finish('failed');c.peer.connectionState='failed';await c.advance(5000);await c.advance(11000);
assert.equal(c.session.report.status,'completed-with-gaps');assert.ok(c.session.report.gaps[0].to);
console.log('PASS: persist-before-rearm, no-peer wait, fixed deadline, preserved gaps and clean completion');

// A failed reattachment belongs to the original open gap, not a new overlapping gap.
const d=setup();d.session.start({seconds:120});await d.advance(1000);
d.finish('failed');await d.advance(10000);
const originalGapStart=d.session.report.gaps[0].from;
await d.advance(20000); // reattachment begins, but fails before PCM starts
// Model the recorder's failed preflight, which has no measurement start.
delete d.audit.report.startedAt;d.finish('failed');await d.advance(22000);
assert.equal(d.session.report.gaps.length,1);
assert.equal(d.session.report.gaps[0].from,originalGapStart);
d.peer.connectionState='failed';await d.advance(121000);
assert.ok(d.session.report.gaps[0].to);
console.log('PASS: repeated failed reattachment preserves one continuous open gap');
