import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../clients/discord-receiver/receiver_buffer.js', import.meta.url), 'utf8');
class Events {
    listeners = new Map();
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) {this.listeners.get(type)?.delete(listener);}
    dispatch(type, extra = {}) {for (const listener of this.listeners.get(type) || []) listener({type, ...extra});}
    get listenerCount() {return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);}
}
let nextId = 0;
const makeReceiver = ({kind = 'audio', original = null, supported = true, fails = false} = {}) => {
    const track = Object.assign(new Events(), {id: 'track-' + ++nextId, kind, readyState: 'live'});
    const receiver = {track};
    let value = original;
    if (supported) Object.defineProperty(receiver, 'jitterBufferTarget', {
        get: () => value,
        set: target => {if (fails && target === 120) throw Error('Unsupported target'); value = target;}
    });
    return receiver;
};
function setup(existing = []) {
    class Peer extends Events {
        static staticValue = 42;
        connectionState = 'connected';
        receivers = [];
        constructor(...args) {super(); this.args = args; this.newTarget = new.target;}
        getReceivers() {return this.receivers;}
        setRemoteDescription(...args) {
            if (!(this instanceof Peer)) throw TypeError('Illegal invocation');
            if (args[0] === 'throw') throw Error('native description error');
            this.descriptionArgs = args;
            this.promise = Promise.resolve('native result');
            return this.promise;
        }
        add(receiver) {this.receivers.push(receiver); this.dispatch('track', {receiver});}
        close() {
            if (!(this instanceof Peer)) throw TypeError('Illegal close');
            this.connectionState = 'closed';
            // Real native close need not dispatch connectionstatechange.
            return 'native close result';
        }
    }
    const method = Peer.prototype.setRemoteDescription, closeMethod = Peer.prototype.close;
    const current = new Peer(); current.receivers = existing;
    const window = {RTCPeerConnection: Peer, raydioEndurance: {peers: [current]}};
    const context = vm.createContext({window, setTimeout() {throw Error('No polling allowed');}});
    const install = () => vm.runInContext(source, context);
    install();
    return {window, Peer, current, method, closeMethod, api: window.raydioReceiverBuffer, install};
}

// Existing receivers, idempotent installation, update and exact restoration.
{
    const audio = makeReceiver({original: 45}), video = makeReceiver({kind: 'video'});
    const unsupported = makeReceiver({supported: false}), rejected = makeReceiver({fails: true});
    const {api, current, window, Peer, method, install} = setup([audio, video, unsupported, rejected]);
    assert.equal(audio.jitterBufferTarget, 120);
    assert.equal(video.jitterBufferTarget, null);
    assert.equal(rejected.jitterBufferTarget, null);
    assert.equal(api.status().unsupportedCount, 1);
    assert.equal(api.status().failedApplications, 1);
    assert.equal(api.status().receivers.length, 1);
    const hook = window.RTCPeerConnection;
    install(); assert.equal(window.RTCPeerConnection, hook);
    api.enable(150); assert.equal(audio.jitterBufferTarget, 150);
    assert.equal(api.status().unsupportedCount, 1);
    api.disable(); assert.equal(audio.jitterBufferTarget, 45);
    assert.equal(current.listenerCount, 0); assert.equal(audio.track.listenerCount, 0);
    assert.equal(window.RTCPeerConnection, Peer);
    assert.equal(Peer.prototype.setRemoteDescription, method);
    assert.equal(api.status().peers, 0); assert.equal(api.status().receivers.length, 0);
    assert.throws(() => api.enable(-1), /0 to 300/);
    assert.throws(() => api.enable(120.1), /0 to 300/);
    window.raydioBufferTrial = {running: true};
    assert.throws(() => api.enable(), /comparison/);
    assert.equal(api.status().enabled, false);
}
// Future connections and cached constructors; preserve native construction,
// instanceof, subclassing, static methods, arguments, errors and Promise identity.
{
    const {window, Peer, api, method, closeMethod} = setup();
    const peer = new window.RTCPeerConnection({example: 1});
    assert.ok(peer instanceof Peer && peer instanceof window.RTCPeerConnection);
    assert.equal(window.RTCPeerConnection.staticValue, 42);
    assert.equal(peer.args[0].example, 1);
    class Subclass extends window.RTCPeerConnection {}
    const sub = new Subclass(); assert.equal(sub.newTarget, Subclass);
    assert.throws(() => window.RTCPeerConnection(), TypeError);
    const audio = makeReceiver(); peer.add(audio); assert.equal(audio.jitterBufferTarget, 120);
    const cached = new Peer(), other = makeReceiver();
    const returned = cached.setRemoteDescription('description', 2);
    assert.equal(returned, cached.promise); assert.equal(await returned, 'native result');
    assert.deepEqual(cached.descriptionArgs, ['description', 2]);
    cached.add(other); assert.equal(other.jitterBufferTarget, 120);
    assert.throws(() => cached.setRemoteDescription('throw'), /native description error/);
    assert.throws(() => Peer.prototype.setRemoteDescription.call({}), /Illegal invocation/);
    audio.track.readyState = 'ended'; audio.track.dispatch('ended');
    assert.ok(api.status().receivers.every(r => r.trackId !== audio.track.id));
    assert.equal(audio.track.listenerCount, 0);
    assert.equal(peer.close(), 'native close result'); assert.equal(peer.listenerCount, 0);
    assert.throws(() => Peer.prototype.close.call({}), /Illegal close/);
    assert.equal(cached.close(), 'native close result'); assert.equal(other.jitterBufferTarget, null);
    assert.equal(cached.listenerCount, 0);
    api.disable(); assert.equal(Peer.prototype.setRemoteDescription, method);
    assert.equal(Peer.prototype.close, closeMethod);
    api.enable();
    const reconnect = new window.RTCPeerConnection(), fresh = makeReceiver();
    reconnect.add(fresh); assert.equal(fresh.jitterBufferTarget, 120);
    api.disable(); assert.equal(fresh.jitterBufferTarget, null);
}
// Do not erase a third-party setting or wrapper during cleanup/re-enable.
{
    const audio = makeReceiver();
    const {api, window, Peer} = setup([audio]);
    audio.jitterBufferTarget = 175;
    const installed = window.RTCPeerConnection;
    class ThirdParty extends installed {}
    window.RTCPeerConnection = ThirdParty;
    api.disable(); assert.equal(audio.jitterBufferTarget, 175);
    assert.equal(window.RTCPeerConnection, ThirdParty);
    api.enable(); api.disable(); assert.equal(window.RTCPeerConnection, ThirdParty);
    assert.ok(new window.RTCPeerConnection() instanceof Peer);
}
const manifest = JSON.parse(readFileSync(new URL('../clients/discord-receiver/manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.content_scripts[0].world, 'MAIN');
assert.equal(manifest.content_scripts[0].run_at, 'document_start');
assert.deepEqual(manifest.content_scripts[0].matches, ['https://discord.com/*']);
assert.equal(manifest.permissions, undefined);
console.log('PASS: existing/future/cached peers, reconnects, unsupported settings, native semantics, exact restoration, cleanup and extension scope');
