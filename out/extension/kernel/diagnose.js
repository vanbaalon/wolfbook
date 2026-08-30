"use strict";
/*
 * kernel/diagnose.js — post-mortem diagnostics for kernel launch failures.
 *
 * When the WSTP addon fails to launch/connect to WolframKernel, the raw error
 * ("WSOpenArgcArgv failed (code 7)", "WSActivate failed: …", "WSTP link is
 * dead") tells the user nothing actionable.  This module figures out WHY:
 *
 *   not-installed      no Wolfram/Mathematica installation found at all
 *   custom-path-missing wolfbook.systemKernel points at a non-existent file
 *   license            kernel binary runs but licensing fails (subtyped:
 *                      missing/expired/activation/seats/MathLM)
 *   kernel-crash       kernel exits immediately for a non-license reason
 *   kernel-hang        kernel starts but never becomes ready (no output)
 *   wstp-link          kernel evaluates fine standalone → the failure is in
 *                      the WSTP link layer (addon arch, firewall, stale addon)
 *   addon-missing      wstp.node itself failed to load (arch mismatch etc.)
 *
 * The classification probe spawns WolframKernel DIRECTLY as a child process
 * (no WSTP involved) with -noprompt and a sentinel Print, and pattern-matches
 * whatever the kernel says on stdout/stderr.  License errors are only ever
 * printed there — the WSTP layer just sees a dead link.
 *
 * NO vscode dependency — unit-testable; lifecycle.js renders the result.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ── addon load error relay ───────────────────────────────────────────────────
// controller.js records why require(wstp.node) failed; lifecycle.js reads it
// back when it finds WstpSession undefined.  Avoids a circular require.
let _addonLoadError = null;
function recordAddonLoadError(err) {
    _addonLoadError = err ? String(err.message || err) : null;
}
function getAddonLoadError() { return _addonLoadError; }

// ── license / failure classification ────────────────────────────────────────
// Ordered: first match wins.  Sources: classic Mathematica password messages,
// Wolfram Engine entitlement/activation flow, MathLM network licensing.
const LICENSE_PATTERNS = [
    { re: /no valid password found|cannot find a valid password/i,
      sub: 'mathpass-invalid',
      human: 'Wolfram could not find a valid MathPass license entry' },
    { re: /mathpass.*(?:missing|not found|invalid|corrupt|unreadable)|(?:missing|invalid|corrupt|unreadable).*mathpass/i,
      sub: 'mathpass-invalid',
      human: 'The Wolfram MathPass license file is missing, unreadable, or invalid' },
    { re: /cannot find a valid password|no valid password|invalid password/i,
      sub: 'license-missing',
      human: 'No valid license found (missing or invalid password/license file)' },
    { re: /has expired|license .*expired|expired .*license/i,
      sub: 'license-expired',
      human: 'The Wolfram license has expired' },
    { re: /not enough .*licens|too many .*(process|kernel)|licenses? in use|license limit/i,
      sub: 'license-seats',
      human: 'All license seats are in use (kernel-count limit reached)' },
    { re: /mathlm|license server|license manager/i,
      sub: 'license-server',
      human: 'Cannot obtain a license from the license server (MathLM)' },
    { re: /activat|wolfram id|entitlement/i,
      sub: 'activation-required',
      human: 'The product is not activated — activation required' },
    { re: /licens|password/i,
      sub: 'license-other',
      human: 'A licensing problem prevented the kernel from starting' },
];

/**
 * Classify captured kernel output.  Returns { sub, human, evidence } for a
 * license-family failure, or null when the text shows no licensing issue.
 * evidence = the first output line that triggered the match (for display).
 */
function classifyKernelOutput(text) {
    if (!text) return null;
    for (const p of LICENSE_PATTERNS) {
        if (!p.re.test(text)) continue;
        const evidence = text.split(/\r?\n/).find(l => p.re.test(l)) || '';
        return { sub: p.sub, human: p.human, evidence: evidence.trim() };
    }
    return null;
}

// ── direct-spawn probe ──────────────────────────────────────────────────────
const PROBE_SENTINEL = 'WB_DIAG_KERNEL_OK';
const PROBE_TIMEOUT_MS = 30000;
const LICENSE_PROBE_TIMEOUT_MS = 15000;

/**
 * Return the standard MathPass locations without ever reading their contents.
 * Both current "Wolfram" and legacy "Mathematica" directories are included;
 * existing installations may legitimately use either after an upgrade.
 */
function findMathPassCandidates(kernelPath) {
    const home = os.homedir();
    const candidates = [];
    const add = (p, scope) => {
        if (!p || candidates.some(c => c.path === p)) return;
        let exists = false, readable = false;
        try {
            exists = fs.existsSync(p);
            if (exists) { fs.accessSync(p, fs.constants.R_OK); readable = true; }
        } catch (_) {}
        candidates.push({ path: p, scope, exists, readable });
    };

    if (process.platform === 'darwin') {
        add(path.join(home, 'Library', 'Wolfram', 'Licensing', 'mathpass'), 'user');
        add(path.join(home, 'Library', 'Mathematica', 'Licensing', 'mathpass'), 'user-legacy');
        add('/Library/Wolfram/Licensing/mathpass', 'system');
        add('/Library/Mathematica/Licensing/mathpass', 'system-legacy');
    } else if (process.platform === 'win32') {
        const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        const programData = process.env.ProgramData || 'C:\\ProgramData';
        add(path.join(roaming, 'Wolfram', 'Licensing', 'mathpass'), 'user');
        add(path.join(roaming, 'Mathematica', 'Licensing', 'mathpass'), 'user-legacy');
        add(path.join(programData, 'Wolfram', 'Licensing', 'mathpass'), 'system');
        add(path.join(programData, 'Mathematica', 'Licensing', 'mathpass'), 'system-legacy');
    } else {
        add(path.join(home, '.Wolfram', 'Licensing', 'mathpass'), 'user');
        add(path.join(home, '.Mathematica', 'Licensing', 'mathpass'), 'user-legacy');
        add('/usr/share/Wolfram/Licensing/mathpass', 'system');
        add('/usr/share/Mathematica/Licensing/mathpass', 'system-legacy');
    }

    // Wolfram also supports <installation>/Configuration/Licensing/mathpass.
    // The executable is normally one or two directories below that root.
    if (kernelPath && kernelPath !== 'kernel-not-found') {
        const exeDir = path.dirname(kernelPath);
        const roots = [path.dirname(exeDir), path.dirname(path.dirname(exeDir))];
        for (const root of roots) add(path.join(root, 'Configuration', 'Licensing', 'mathpass'), 'installation');
    }
    return candidates;
}

function _redactLicenseText(text) {
    return String(text || '')
        // Activation keys and conventional L-prefixed license IDs.
        .replace(/\b(?:[A-Z]\d{3,6}-\d{3,6}|\d{4}-\d{4}-[A-Z0-9]{4,})\b/gi, '[license-id]')
        // Password fields contain several colon-separated numeric groups.
        .replace(/\b\d{3,}-\d{3,}-\d{3,}(?::[^\s]+)+\b/g, '[license-password]');
}

/**
 * Cheap, asynchronous licence preflight used BEFORE entering WSTP.  Native
 * WSTP connect/open calls are synchronous and can block VS Code's extension
 * host indefinitely when the kernel exits during licence startup.  Wolfram's
 * documented -licenseinfo option exits non-zero when no valid licence exists.
 */
function probeKernelLicense(kernelPath,
                            { timeoutMs = LICENSE_PROBE_TIMEOUT_MS, spawnFn = spawn } = {}) {
    return new Promise((resolve) => {
        const started = Date.now();
        let out = '', done = false, timedOut = false;
        const finish = (r) => {
            if (done) return;
            done = true;
            // A successful response contains the user's licence identifier.
            // Wolfbook only needs the exit status, so do not retain it at all.
            const safeOutput = r.ok ? '' : _redactLicenseText(out);
            resolve({ ...r, output: safeOutput, durationMs: Date.now() - started });
        };
        let child;
        try {
            child = spawnFn(kernelPath, ['-licenseinfo'], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            return finish({ ok: false, timedOut: false, exitCode: null,
                            spawnError: String(e.message || e) });
        }
        const collect = (d) => {
            // Licence diagnostics are tiny. Bound captured output in case a
            // broken launcher unexpectedly writes without exiting.
            if (out.length < 65536) out += d.toString().slice(0, 65536 - out.length);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch (_) {}
            // Resolve independently of the child's eventual `close` event. A
            // wedged launcher must not turn the safety preflight into a new
            // extension-host wait of its own.
            finish({ ok: false, timedOut: true, exitCode: null,
                     reason: 'timeout', spawnError: null });
        }, timeoutMs);
        child.on('error', (e) => {
            clearTimeout(timer);
            finish({ ok: false, timedOut: false, exitCode: null,
                     spawnError: String(e.message || e) });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            // Wolfram documents a non-zero status (and normally 0/0/0 fields)
            // when no valid licence is available.
            const fields = out.trim().split(/\s+/);
            const looksLikeInfo = fields.length >= 3;
            const zeroInfo = looksLikeInfo && fields.slice(0, 3).every(v => v === '0');
            // Field 3 is the number of currently available kernel processes.
            // Avoid entering blocking WSTP startup when it is exactly zero.
            // "Infinity" and positive integers are both healthy.
            const noSeats = looksLikeInfo && fields[2] === '0' && !zeroInfo;
            finish({ ok: code === 0 && looksLikeInfo && !zeroInfo && !noSeats,
                     reason: noSeats ? 'no-seats' : zeroInfo ? 'no-valid-license' : null,
                     timedOut, exitCode: code, spawnError: null });
        });
    });
}

/**
 * Launch the kernel directly (no WSTP) and capture everything it says.
 * Resolves { ok, timedOut, exitCode, output, spawnError, durationMs }.
 * ok=true ⇔ the sentinel was printed, i.e. licensing and startup are fine.
 */
function probeKernelDirect(kernelPath, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        const started = Date.now();
        let out = '', done = false, timedOut = false;
        const finish = (r) => { if (!done) { done = true; resolve(r); } };
        let child;
        try {
            child = spawn(kernelPath,
                ['-noinit', '-noprompt', '-run', `Print["${PROBE_SENTINEL}"];Exit[0]`],
                { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            return finish({ ok: false, timedOut: false, exitCode: null,
                            output: '', spawnError: String(e.message || e),
                            durationMs: Date.now() - started });
        }
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch (_) {}
        }, timeoutMs);
        const collect = (d) => {
            out += d.toString();
            // Sentinel seen → kernel is healthy; don't wait for exit.
            if (out.includes(PROBE_SENTINEL)) {
                clearTimeout(timer);
                try { child.kill('SIGKILL'); } catch (_) {}
                finish({ ok: true, timedOut: false, exitCode: 0, output: out,
                         spawnError: null, durationMs: Date.now() - started });
            }
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', (e) => {
            clearTimeout(timer);
            finish({ ok: false, timedOut: false, exitCode: null, output: out,
                     spawnError: String(e.message || e),
                     durationMs: Date.now() - started });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            finish({ ok: out.includes(PROBE_SENTINEL), timedOut, exitCode: code,
                     output: out, spawnError: null,
                     durationMs: Date.now() - started });
        });
    });
}

// ── main entry ──────────────────────────────────────────────────────────────
/**
 * Diagnose a kernel launch failure.
 *
 * @param kernelPath  path resolveKernel() returned ('kernel-not-found' allowed)
 * @param opts        { wstpError?: string        — message from the failed launch
 *                      customPath?: boolean      — user set wolfbook.systemKernel
 *                      discovered?: [{label,description,path}]  — FindKernel.discoverKernels()
 *                      addonLoaded?: boolean     — WstpSession was available
 *                      skipProbe?: boolean, timeoutMs?: number,
 *                      probe?: fn                — injectable for tests }
 * @returns { cause, sub?, summary, detailLines: string[] }
 */
async function diagnoseKernelLaunch(kernelPath, opts = {}) {
    const detail = [];
    const push = (s) => detail.push(s);
    const probe = opts.probe || probeKernelDirect;
    const discovered = opts.discovered || [];

    push(`time            : ${new Date().toISOString()}`);
    push(`platform / arch : ${process.platform} / ${process.arch}`);
    push(`kernel path     : ${kernelPath}`);
    if (opts.wstpError) push(`wstp error      : ${opts.wstpError}`);
    if (discovered.length) {
        push('installations   : ' + discovered.map(d =>
            `${d.label}${d.description ? ' ' + d.description : ''}`).join(', '));
    }

    // 0. The addon itself never loaded — nothing kernel-side to diagnose.
    if (opts.addonLoaded === false) {
        const le = getAddonLoadError();
        push(`addon error     : ${le || 'unknown'}`);
        const archHint = le && /incompatible architecture|not a mach-o|invalid ELF|%1 is not a valid/i.test(le)
            ? ` The addon binary does not match this machine (${process.arch}) — reinstall/rebuild the extension for this platform.`
            : '';
        return { cause: 'addon-missing',
                 summary: `The WSTP addon (wstp.node) failed to load, so no kernel can be launched.${archHint}`,
                 detailLines: detail };
    }

    // 1. No kernel binary at all.
    const missing = !kernelPath || kernelPath === 'kernel-not-found' || !fs.existsSync(kernelPath);
    if (missing) {
        if (opts.customPath) {
            return { cause: 'custom-path-missing',
                     summary: `The kernel path in the "wolfbook.systemKernel" setting does not exist: ${kernelPath}`,
                     detailLines: detail };
        }
        const where = process.platform === 'darwin' ? '/Applications (Wolfram*.app, Mathematica.app, Wolfram Engine.app)'
                    : process.platform === 'win32' ? 'C:\\Program Files\\Wolfram Research\\…'
                    : '/usr/local/Wolfram/…';
        return { cause: 'not-installed',
                 summary: `No Wolfram/Mathematica installation found (searched ${where}). ` +
                          `Install Wolfram, or point "wolfbook.systemKernel" at your WolframKernel binary.`,
                 detailLines: detail };
    }

    // 2. A pre-WSTP licence check already failed. Do not launch another kernel:
    // retrying here can prompt again or stall on the same licence server.
    if (opts.licensePreflight && !opts.licensePreflight.ok) {
        const r = opts.licensePreflight;
        push(`license preflight: ok=false timedOut=${r.timedOut} exit=${r.exitCode} ` +
             `spawnError=${r.spawnError || 'none'} (${r.durationMs} ms)`);
        if (r.output && r.output.trim()) {
            push('── licence-check output (secrets redacted) ─────────');
            for (const line of r.output.trim().split(/\r?\n/).slice(0, 20)) push('  ' + line);
            push('───────────────────────────────────────────────');
        }
        const mathpass = findMathPassCandidates(kernelPath);
        for (const c of mathpass) {
            push(`mathpass        : ${c.path} [${c.exists ? (c.readable ? 'present/readable' : 'present/unreadable') : 'not found'}]`);
        }
        const lic = classifyKernelOutput(r.output);
        if (r.reason === 'no-seats') {
            return { cause: 'license', sub: 'license-seats',
                     summary: 'All Wolfram kernel processes allowed by the licence are currently in use. Close another Wolfram kernel or ask the MathLM administrator for an available seat, then try again.',
                     detailLines: detail, mathPassCandidates: mathpass };
        }
        if (lic) {
            const present = mathpass.filter(c => c.exists);
            const locationNote = present.length === 0
                ? ' No MathPass file was found in the standard locations.'
                : present.every(c => !c.readable)
                    ? ' The detected MathPass file is not readable.'
                    : '';
            return { cause: 'license', sub: lic.sub,
                     summary: `${lic.human}.${locationNote} Open Mathematica/Wolfram once to repair activation, then try again.`,
                     detailLines: detail, mathPassCandidates: mathpass };
        }
        if (r.timedOut) {
            return { cause: 'license', sub: 'license-check-timeout',
                     summary: 'Wolfram did not finish its licence check in time. It may be waiting for activation or an unavailable MathLM server. Open Mathematica/Wolfram to repair or verify the licence, then try again.',
                     detailLines: detail, mathPassCandidates: mathpass };
        }
        if (r.spawnError) {
            return { cause: 'kernel-crash',
                     summary: `The kernel binary could not be started for its licence check: ${r.spawnError}`,
                     detailLines: detail };
        }
        return { cause: 'license', sub: 'license-invalid',
                 summary: `Wolfram's licence check failed (exit code ${r.exitCode}). Open Mathematica/Wolfram to repair activation or MathPass, then try again.`,
                 detailLines: detail, mathPassCandidates: mathpass };
    }

    // 3. Binary exists — run it directly and let it tell us what is wrong.
    if (opts.skipProbe) {
        return { cause: 'unknown',
                 summary: `Failed to launch the Wolfram kernel: ${opts.wstpError || 'unknown error'}`,
                 detailLines: detail };
    }
    push('probe           : launching kernel directly (no WSTP) …');
    const r = await probe(kernelPath, { timeoutMs: opts.timeoutMs });
    push(`probe result    : ok=${r.ok} timedOut=${r.timedOut} exit=${r.exitCode} ` +
         `spawnError=${r.spawnError || 'none'} (${r.durationMs} ms)`);
    if (r.output && r.output.trim()) {
        push('── kernel output ──────────────────────────────');
        for (const line of r.output.trim().split(/\r?\n/).slice(0, 40)) push('  ' + line);
        push('───────────────────────────────────────────────');
    }

    if (r.spawnError) {
        const archHint = /EBADARCH|Bad CPU type/i.test(r.spawnError)
            ? ' (the kernel binary is built for a different CPU architecture)' : '';
        return { cause: 'kernel-crash',
                 summary: `The kernel binary could not be started: ${r.spawnError}${archHint}`,
                 detailLines: detail };
    }

    const lic = classifyKernelOutput(r.output);
    if (lic) {
        const ev = lic.evidence ? ` Kernel says: "${lic.evidence}"` : '';
        return { cause: 'license', sub: lic.sub,
                 summary: `${lic.human}.${ev}`,
                 detailLines: detail };
    }

    if (r.ok) {
        // Kernel is perfectly healthy standalone → the WSTP layer is at fault.
        return { cause: 'wstp-link',
                 summary: 'The kernel itself runs and is licensed — the failure is in the ' +
                          'WSTP connection layer. Common causes: a stale/mismatched wstp.node ' +
                          'addon, or a firewall blocking local TCP loopback.' +
                          (opts.wstpError ? ` Original error: ${opts.wstpError}` : ''),
                 detailLines: detail };
    }

    if (r.timedOut) {
        return { cause: 'kernel-hang',
                 summary: `The kernel started but produced no response within ${Math.round((opts.timeoutMs || PROBE_TIMEOUT_MS) / 1000)} s ` +
                          '— it may be waiting for interactive activation, a license-server ' +
                          'reply, or first-run initialisation.',
                 detailLines: detail };
    }

    const tail = (r.output || '').trim().split(/\r?\n/).slice(-3).join(' | ');
    return { cause: 'kernel-crash',
             summary: `The kernel exited immediately (code ${r.exitCode}) without a license message.` +
                      (tail ? ` Last output: ${tail}` : ' It produced no output.'),
             detailLines: detail };
}

module.exports = {
    diagnoseKernelLaunch,
    probeKernelDirect,
    probeKernelLicense,
    classifyKernelOutput,
    findMathPassCandidates,
    recordAddonLoadError,
    getAddonLoadError,
    PROBE_SENTINEL,
    LICENSE_PROBE_TIMEOUT_MS,
};
