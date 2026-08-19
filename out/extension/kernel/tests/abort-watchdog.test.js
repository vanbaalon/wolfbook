'use strict';

// Phase 2.7: _abortUncertain must not be sticky.  The watchdog probes the link
// and either clears the flag (healthy) or resolves to a definite 'error'.

const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
const { makeVscodeStub } = require('./_stub-vscode');
const stub = makeVscodeStub();
Module._load = function (request) {
    if (request === 'vscode') return stub;
    return originalLoad.apply(this, arguments);
};

// Drive the watchdog method against a minimal fake controller — the method only
// touches flags, executionQueue, session.subAuto, arbiter._record, scrollLog.
const { WolframNotebookKernel } = require('../../controller');
const watchdog = WolframNotebookKernel.prototype._startAbortUncertaintyWatchdog;

function fakeCtrl({ subAutoOk }) {
    return {
        _abortUncertain: true,
        _abortWatchdogActive: false,
        isAborting: false,
        _abortPending: false,
        _evalDispatched: false,
        kernelStatusString: 'resolved',
        executionQueue: { queueLength: () => 0 },
        session: { subAuto: async () => { if (!subAutoOk) throw new Error('link dead'); return { value: '1' }; } },
        arbiter: { _record: (kind) => { fakeCtrl.recorded = kind; } },
    };
}

(async () => {
    // Healthy link: flag clears within one probe cycle.
    const healthy = fakeCtrl({ subAutoOk: true });
    watchdog.call(healthy);
    await new Promise(r => setTimeout(r, 2600));
    assert.strictEqual(healthy._abortUncertain, false, 'flag must clear when the link answers');
    assert.strictEqual(healthy._abortWatchdogActive, false);
    assert.strictEqual(healthy.kernelStatusString, 'resolved');

    // Flag cleared externally (e.g. new dispatch): watchdog stands down.
    const cleared = fakeCtrl({ subAutoOk: false });
    watchdog.call(cleared);
    cleared._abortUncertain = false;
    await new Promise(r => setTimeout(r, 2600));
    assert.strictEqual(cleared._abortWatchdogActive, false);
    assert.strictEqual(cleared.kernelStatusString, 'resolved', 'no error verdict once uncertainty is gone');

    // Re-entrancy: starting twice does not double-arm.
    const twice = fakeCtrl({ subAutoOk: true });
    watchdog.call(twice);
    watchdog.call(twice);
    assert.strictEqual(twice._abortWatchdogActive, true);
    await new Promise(r => setTimeout(r, 2600));

    console.log('abort-watchdog tests: OK');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
