'use strict';
const { Worker } = require('node:worker_threads');

// JavaScript regex execution cannot be interrupted on the extension thread.
// Keep agent-supplied patterns in a disposable worker so a pathological
// search cannot stall the preview watchdog, MCP or the user's editor.
function regexPositions(pattern, texts, timeoutMs = 1000) {
    if (pattern.length > 2000) return Promise.reject(Error('regex exceeds 2000 characters; narrow the query'));
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const {parentPort, workerData} = require('node:worker_threads');
            try { const re = new RegExp(workerData.pattern, 'i');
                parentPort.postMessage({positions:workerData.texts.map(text => text.search(re))});
            } catch (error) { parentPort.postMessage({error:error.message}); }
        `, {eval:true, workerData:{pattern,texts}, resourceLimits:{maxOldGenerationSizeMb:64}});
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true; clearTimeout(timer); worker.terminate().catch(() => {});
            if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => finish(Error('regex search exceeded 1 second; use a literal query or a simpler pattern')), timeoutMs);
        worker.on('message', result => finish(result.error ? Error(result.error) : null, result.positions));
        worker.on('error', error => finish(error));
        worker.on('exit', code => { if (!settled) finish(Error(`regex worker exited (${code})`)); });
    });
}
module.exports = {regexPositions};
