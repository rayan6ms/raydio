import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('./browser_buffer_trial.js', import.meta.url), 'utf8');
async function simulate({busy = false, shortLife = false, saveFails = false,
    coverageFails = false, identityChanges = false, setterFails = false} = {}) {
    let packets = 0, setting = null;
    const calls = [], saves = [];
    const identity = {id: 'rtp', ssrc: 1, trackIdentifier: 'track'};
    const receiver = {track: {id: 'track', readyState: 'live'},
        get jitterBufferTarget() {return setting;},
        set jitterBufferTarget(value) {if (setterFails && value === 120) throw Error('setter failed'); setting = value;}};
    const peer = {connectionState: 'connected', getReceivers: () => [receiver],
        getStats: async () => new Map([['rtp', {...identity, type: 'inbound-rtp', kind: 'audio', packetsReceived: packets += 60}]])};
    const window = {raydioEndurance: {running: busy, peers: [peer], start: async () => {
        calls.push(setting);
        return {version: 1, status: 'completed', receiverIdentity: {...identity, ssrc: identityChanges ? 2 : 1},
            coverage: {uninterruptedConnection: true, completePollCoverage: !coverageFails,
                completePcmCoverage: true, completeEventHistory: true}};
    }}};
    vm.runInNewContext(source, {window, Date, AbortSignal, JSON, setTimeout: f => queueMicrotask(f),
        fetch: async (url, options) => {
            if (url.endsWith('/health')) return {ok: true, json: async () => ({remainingSeconds: shortLife ? 1 : 1800})};
            saves.push(JSON.parse(options.body)); return {ok: !saveFails, status: saveFails ? 500 : 204};
        }});
    if (busy) {await assert.rejects(window.raydioBufferTrial.start({seconds: 10}), /Another observer/); return;}
    const result = await window.raydioBufferTrial.start({seconds: 10});
    assert.equal(window.raydioBufferTrial.running, false);
    assert.equal(setting, null, 'restore original setting after success or failure');
    if (shortLife) {assert.equal(calls.length, 0); assert.equal(result.status, 'failed');}
    else if (saveFails || coverageFails || identityChanges) {
        assert.equal(calls.length, 1); assert.equal(saves.length, 1);
        assert.equal(result.status, 'failed'); assert.equal(result.restored, true);
    } else if (setterFails) {
        assert.equal(calls.length, 1); assert.equal(result.status, 'failed'); assert.equal(result.restored, true);
    } else {
        assert.deepEqual(calls, [null, 120, null, 120]);
        assert.equal(result.status, 'completed'); assert.equal(result.saved, 4); assert.equal(result.restored, true);
        assert.ok(saves.every((r, i) => r.receiverBufferTrial.index === i));
    }
}
for (const options of [{}, {busy: true}, {shortLife: true}, {saveFails: true},
    {coverageFails: true}, {identityChanges: true}, {setterFails: true}]) await simulate(options);
console.log('PASS: repeated targets, persistence, strict coverage and identity guards, restoration on failures');
