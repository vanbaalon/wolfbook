'use strict';

// A slow initialize response is not a failed server. Keep one cancellable
// diagnostic timer per attempt and report readiness/failure from the promise.
function createLspLifecycle(client, {onReady = () => {}, log = () => {},
    warnSlow = true, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now} = {}) {
    let starting = null, ready = false, stopped = false, timer = null;
    const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
    return {
        start() {
            if (stopped || ready) return Promise.resolve();
            if (starting) return starting;
            const at = now();
            if (warnSlow) timer = setTimer(() => {
                timer = null;
                if (!stopped && !ready) log('Language server initialization is taking longer than 15 seconds; still waiting. This is not a startup failure.');
            }, 15000);
            starting = Promise.resolve().then(() => client.start()).then(() => {
                ready = true;
                if (!stopped) {
                    log(`Language server ready after ${((now() - at) / 1000).toFixed(1)} seconds.`);
                    onReady();
                }
            }).catch(error => {
                if (!stopped) log(`Language server failed to start: ${error.message}. See the preceding server output for the cause.`);
            }).finally(() => { clear(); starting = null; });
            return starting;
        },
        async stop(timeout = 1500) {
            stopped = true; clear();
            // LanguageClient.stop rejects while start is pending. Let the same
            // attempt settle so it cannot create a late, unowned LSP process.
            if (starting) await starting;
            await client.stop(timeout);
            ready = false;
        },
        dispose() { stopped = true; clear(); },
    };
}

module.exports = {createLspLifecycle};
