'use strict';
/**
 * kernelAssist.js — optional exactness pass for imported .nb input cells.
 *
 * The JS box flattener in nbModel.js handles the common box heads. Cells that
 * contained something it does not model are marked `approx` and carry their
 * original box expression; this module hands those boxes to a real Wolfram
 * kernel, which converts them with ToExpression/ToString and therefore always
 * produces exactly the code Mathematica would show.
 *
 * Entirely optional: with no kernel installed the import still works, it just
 * keeps the approximate text. vscode-free so it can be tested headlessly.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const supervisor = require('./subprocessSupervisor');

const flights = new Map();

// ---------------------------------------------------------------------------
// Kernel discovery (no vscode — mirrors find-kernel.js's app scan)

function macWolframApps() {
    try {
        return fs.readdirSync('/Applications')
            .filter(e => /^(Wolfram( \d+)?|Wolfram Engine|Mathematica( \d+)?)\.app$/i.test(e))
            .sort((a, b) => {
                const na = parseInt((a.match(/^Wolfram (\d+)\.app$/i) || [])[1] || '-1', 10);
                const nb = parseInt((b.match(/^Wolfram (\d+)\.app$/i) || [])[1] || '-1', 10);
                if (na >= 0 && nb >= 0) return nb - na;
                if (na >= 0) return -1;
                if (nb >= 0) return 1;
                return 0;
            })
            .map(app => '/Applications/' + app + '/Contents/MacOS');
    } catch (_) { return []; }
}

/** Locate a runner. Returns {cmd, args} where args already select script mode. */
function findRunner(explicitKernelPath) {
    const candidates = [];

    if (explicitKernelPath) {
        const dir = path.dirname(explicitKernelPath);
        candidates.push(path.join(dir, 'wolframscript'));
        candidates.push(explicitKernelPath);
    }
    for (const dir of macWolframApps()) {
        candidates.push(path.join(dir, 'wolframscript'));
        candidates.push(path.join(dir, 'WolframKernel'));
    }
    candidates.push('/usr/local/bin/wolframscript', '/opt/homebrew/bin/wolframscript');

    for (const c of candidates) {
        try { if (fs.existsSync(c)) return { cmd: c, args: ['-script'] }; } catch (_) { /* keep looking */ }
    }
    // Last resort: rely on PATH.
    return { cmd: 'wolframscript', args: ['-script'], fromPath: true };
}

// ---------------------------------------------------------------------------
// The kernel-side script
//
// Reads an ASCII JSON payload, converts each box expression to InputForm source
// and writes an ASCII JSON result. Forcing ASCII on both sides sidesteps the
// double-UTF-8 mojibake that plagued the old wolframscript converter — the
// \[Name] escapes are decoded on the JS side.

const WL_SCRIPT = String.raw`
inFile = Environment["WB_NB_IN"];
outFile = Environment["WB_NB_OUT"];
payload = Quiet@Check[Import[inFile, "RawJSON"], $Failed];
If[payload === $Failed, Print["WBNB_ERROR: cannot read payload"]; Exit[2]];

codeOf[boxStr_String] := Module[{boxes, held, s},
  boxes = Quiet@Check[ToExpression[boxStr, InputForm], $Failed];
  If[boxes === $Failed, Return[$Failed]];
  held = Quiet@Check[ToExpression[boxes, StandardForm, HoldComplete], $Failed];
  If[Head[held] =!= HoldComplete, Return[$Failed]];
  s = ToString[held, InputForm, CharacterEncoding -> "ASCII"];
  If[! StringStartsQ[s, "HoldComplete["], Return[$Failed]];
  StringTake[s, {14, -2}]
];

results = Table[
  Module[{code},
    code = TimeConstrained[codeOf[Lookup[entry, "boxSource", ""]], 20, $Failed];
    If[StringQ[code],
      <|"index" -> Lookup[entry, "index", -1], "code" -> code|>,
      <|"index" -> Lookup[entry, "index", -1], "code" -> Null|>
    ]
  ],
  {entry, Lookup[payload, "cells", {}]}
];

stream = OpenWrite[outFile, CharacterEncoding -> "ASCII"];
WriteString[stream, ExportString[<|"results" -> results|>, "RawJSON", "Compact" -> True]];
Close[stream];
Print["WBNB_OK"];
`;

// ---------------------------------------------------------------------------

/** JSON with every non-ASCII character escaped, so encoding cannot go wrong. */
function asciiJson(obj) {
    return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, c =>
        '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * Refine approximate cells through a real kernel.
 *
 * @param {Array<{index:number, boxSource:string}>} payloads
 * @param {object} [opts] { timeoutMs = 120000, kernelPath, signal }
 * @returns {Promise<{ok:boolean, unavailable?:boolean, error?:string,
 *                    results:Array<{index:number, code:string}>}>}
 */
async function refineCellsOnce(payloads, opts) {
    opts = opts || {};
    const list = (payloads || []).filter(p => p && typeof p.boxSource === 'string' && p.boxSource);
    if (!list.length) return { ok: true, results: [] };

    const runner = opts.runner || findRunner(opts.kernelPath);
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-nbimport-'));
    const inFile  = path.join(tmpDir, 'payload.json');
    const outFile = path.join(tmpDir, 'result.json');
    const wlFile  = path.join(tmpDir, 'refine.wls');

    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };

    try {
        fs.writeFileSync(inFile, asciiJson({ cells: list }), 'ascii');
        fs.writeFileSync(wlFile, WL_SCRIPT, 'utf8');
    } catch (e) {
        cleanup();
        return { ok: false, error: 'could not stage temp files: ' + e.message, results: [] };
    }

    return new Promise((resolve) => {
        const subject = opts.notebook ? ` for ${opts.notebook}` : '';
        let child;
        try {
            child = supervisor.spawn(runner.cmd, runner.args.concat([wlFile]), {
                env: Object.assign({}, process.env, { WB_NB_IN: inFile, WB_NB_OUT: outFile }),
                stdio: ['ignore', 'pipe', 'pipe'],
            }, { stage: 'refine', notebook: opts.notebook, key: opts.key });
        } catch (e) {
            cleanup();
            resolve({ ok: false, unavailable: true, error: String(e.message || e), results: [] });
            return;
        }

        let stdout = '', stderr = '';
        let settled = false;
        let requestedResult = null;
        let abortListener = null;
        const finish = (res) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (opts.signal && abortListener) opts.signal.removeEventListener?.('abort', abortListener);
            cleanup();
            resolve(res);
        };
        const stop = (res) => {
            if (settled || requestedResult) return;
            requestedResult = res;
            clearTimeout(timer);
            supervisor.terminate(child).then(() => finish(res));
        };

        const timer = setTimeout(() => {
            stop({ ok: false, error: `kernel refinement${subject} timed out after ${opts.timeoutMs || 120000} ms`, results: [] });
        }, opts.timeoutMs || 120000);

        if (opts.signal) {
            abortListener = () => stop({ ok: false, error: `kernel refinement${subject} cancelled`, results: [] });
            if (opts.signal.aborted) abortListener();
            else opts.signal.addEventListener?.('abort', abortListener, { once: true });
        }

        child.stdout.on('data', d => { stdout = (stdout + String(d)).slice(-65536); });
        child.stderr.on('data', d => { stderr = (stderr + String(d)).slice(-65536); });
        child.on('error', (e) => {
            finish({ ok: false, unavailable: true, error: String(e.message || e), results: [] });
        });
        child.on('close', () => {
            if (requestedResult) { finish(requestedResult); return; }
            let parsed = null;
            try { parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (_) { /* handled below */ }
            if (!parsed || !Array.isArray(parsed.results)) {
                finish({ ok: false, error: (stderr.trim().split('\n').pop() || stdout.trim().split('\n').pop() || 'kernel produced no result'), results: [] });
                return;
            }
            const results = parsed.results
                .filter(r => r && typeof r.code === 'string' && r.code)
                .map(r => ({ index: r.index, code: r.code }));
            finish({ ok: true, results });
        });
    });
}

/** Coalesce duplicate refinement requests for the same notebook. */
function refineCells(payloads, opts = {}) {
    const key = opts.key ? `refine:${opts.key}` : null;
    if (key && flights.has(key)) return flights.get(key);
    const promise = refineCellsOnce(payloads, opts);
    if (key) {
        flights.set(key, promise);
        const forget = () => { if (flights.get(key) === promise) flights.delete(key); };
        promise.then(forget, forget);
    }
    return promise;
}

function cancel(key) {
    return supervisor.terminateKey(key);
}

/** True when some Wolfram runner appears to exist on this machine. */
function kernelAvailable(explicitKernelPath) {
    const r = findRunner(explicitKernelPath);
    if (r.fromPath) {
        const dirs = (process.env.PATH || '').split(path.delimiter);
        return dirs.some(d => { try { return fs.existsSync(path.join(d, 'wolframscript')); } catch (_) { return false; } });
    }
    return true;
}

module.exports = { refineCells, kernelAvailable, findRunner, cancel, dispose: supervisor.dispose };
