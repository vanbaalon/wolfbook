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

    // 2. Binary exists — run it directly and let it tell us what is wrong.
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
    classifyKernelOutput,
    recordAddonLoadError,
    getAddonLoadError,
    PROBE_SENTINEL,
};
