// Controlled Discord UI only. Install before preparing a new test command.
// Keep prepare(), submit(), enableLoop(), and startAudit() in separate calls:
// Discord needs a render turn to parse its editor and apply each interaction.
(() => {
    if (window.raydioEndurance?.running) throw Error('Do not replace setup during an audit');
    const clean = s => (s || '').replace(/[\u200b\ufeff]/g, '').trim();
    const articles = () => [...document.querySelectorAll('main [role="article"]')];
    const identity = a => a.getAttribute('data-list-item-id');
    const snowflake = a => identity(a)?.match(/-(\d+)$/)?.[1];
    const idle = () => {
        if (window.raydioEndurance?.running) throw Error('No controls during an audit');
    };
    const box = () => {
        const e = document.querySelector('[role="textbox"][aria-label="Message #chat"]');
        if (!e) throw Error('Open test → #chat');
        return e;
    };
    let state;
    const panel = () => {
        if (!state?.submitted) throw Error('Submit the prepared command first');
        const matches = articles().filter(a => a.innerText.includes('Raydio • Now Playing')
            && a.innerText.includes(state.botName) && snowflake(a)
            && BigInt(snowflake(a)) > state.lastMessage);
        if (matches.length !== 1) throw Error('Expected one fresh bot player; old panels are not playback');
        return matches[0];
    };
    const api = window.raydioPlaybackSetup = {};
    api.prepare = ({request='https://youtu.be/dQw4w9WgXcQ', botName='bot1544468432907669644'}={}) => {
        idle();
        if (state?.submitted) throw Error('Existing submitted trial; reinstall setup for a new trial');
        if (typeof request !== 'string' || !request.trim() || request.length > 1000 || /[\r\n]/.test(request))
            throw Error('Use one nonempty request');
        const ids = articles().map(snowflake).filter(Boolean).map(BigInt);
        if (!ids.length) throw Error('Message identities unavailable; cannot check response freshness');
        state = {request:request.trim(), botName, lastMessage:ids.reduce((a,b)=>a>b?a:b), submitted:false};
        const e = box(); e.focus();
        const range = document.createRange(), selection = window.getSelection();
        range.selectNodeContents(e); selection.removeAllRanges(); selection.addRange(range);
        document.execCommand('delete');
        const data = new DataTransfer(); data.setData('text/plain', '/play ' + state.request);
        e.dispatchEvent(new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true}));
        return {prepared:true};
    };
    api.submit = () => {
        idle();
        if (!state || state.submitted) throw Error('Prepare once before submitting');
        const e = box();
        if (clean(e.querySelector('[class*="commandName"]')?.textContent) !== '/play'
            || clean(e.querySelector('[class*="optionPillKey"]')?.textContent) !== 'request'
            || clean(e.querySelector('[class*="optionPillValue"]')?.textContent) !== state.request)
            throw Error('Discord has not parsed /play and its request field; do not submit raw editor text');
        if (!window.raydioEndurance?.peers.some(p=>p.connectionState==='connected'))
            throw Error('Install receiver observer before joining General');
        const button = document.querySelector('[aria-label="Send Message"]');
        if (!button || button.getAttribute('aria-disabled') !== 'false') throw Error('Send unavailable');
        // Consume before the click so a retry cannot send a duplicate command.
        state.submitted = true; button.click();
        return {submitted:true};
    };
    api.enableLoop = () => {
        idle(); const a = panel();
        if (a.innerText.includes('Playing • Loop: ON')) return {loop:true};
        const b = [...a.querySelectorAll('button')].find(e=>e.textContent.trim()==='Loop: OFF');
        if (!b) throw Error('Fresh player has no loop control');
        b.click(); return {loopRequested:true};
    };
    api.startAudit = ({seconds=300}={}) => {
        idle(); const a = panel();
        if (!a.innerText.includes('Playing • Loop: ON')) throw Error('Verify Loop ON before recording');
        if (!window.raydioCheckpoint?.timer) throw Error('Install persistence first');
        // The recorder independently requires one advancing inbound receiver.
        // It returns a status on preflight failure; never label promise resolution success.
        void window.raydioEndurance.start({seconds,pcm:true,scheduling:true})
            .then(()=>window.raydioCheckpoint.save());
        return {auditRequested:true, messageId:identity(a)};
    };
    return {installed:true};
})();
