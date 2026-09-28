'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
    classifyKernelOutput,
    diagnoseKernelLaunch,
    findMathPassCandidates,
    isInconclusiveLicenseCheck,
    licenseGate,
    probeKernelDirect,
    probeKernelLicense,
    PROBE_SENTINEL,
} = require('../diagnose');

function fakeSpawn(output, exitCode, signal = null) {
    return (_command, args) => {
        assert.deepEqual(args, ['-licenseinfo']);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        process.nextTick(() => {
            child.stderr.end(output);
            child.emit('close', exitCode, signal);
        });
        return child;
    };
}

async function main() {
    const noPassword = classifyKernelOutput('WolframKernel: No valid password found.');
    assert.equal(noPassword?.sub, 'mathpass-invalid');

    const corrupt = classifyKernelOutput('The MathPass file is invalid or corrupt');
    assert.equal(corrupt?.sub, 'mathpass-invalid');

    const expired = classifyKernelOutput('This license has expired');
    assert.equal(expired?.sub, 'license-expired');

    const preflightBad = await probeKernelLicense('/mock/WolframKernel', {
        spawnFn: fakeSpawn('No valid password found.\n', 1),
    });
    assert.equal(preflightBad.ok, false);
    assert.match(preflightBad.output, /No valid password/);

    const preflightGood = await probeKernelLicense('/mock/WolframKernel', {
        spawnFn: fakeSpawn('L1234-5678\t8\t8\n', 0),
    });
    assert.equal(preflightGood.ok, true);
    assert.equal(preflightGood.output, '', 'successful licence identifiers must not be retained');
    assert.equal(preflightGood.verified, true);
    for (const output of ['', 'new output format', 'warning words 0 extra words']) {
        const r = await probeKernelLicense('/mock/WolframKernel', { spawnFn: fakeSpawn(output, 0) });
        assert.equal(r.ok, true, 'clean exit with unknown output must not block work');
        assert.equal(r.verified, false);
        assert.equal(r.reason, 'unconfirmed-output');
    }
    const zero = await probeKernelLicense('/mock/WolframKernel', { spawnFn: fakeSpawn('0\t0\t0', 0) });
    assert.equal(zero.ok, false);
    const explicit = await probeKernelLicense('/mock/WolframKernel', { spawnFn: fakeSpawn('No valid password found.', 0) });
    assert.equal(explicit.ok, false, 'explicit failure is not ignored even on exit zero');
    for (const code of [1, null]) {
        const r = await probeKernelLicense('/mock/WolframKernel', { spawnFn: fakeSpawn('', code) });
        assert.equal(r.ok, false, 'failed or signal-terminated probe retains startup protection');
    }
    const kernel = 'C:\\Program Files\\Wolfram\\WolframKernel.exe';
    for (const sibling of ['wolfram.exe', 'math.exe', null]) {
        let launched;
        const r = await probeKernelLicense(kernel, {
            platform: 'win32', existsFn: p => sibling != null && p.endsWith('\\' + sibling),
            spawnFn: (command, args, opts) => {
                launched = command;
                assert.equal(opts.windowsHide, true);
                return fakeSpawn('', 0)(command, args);
            },
        });
        assert.equal(launched, sibling ? kernel.replace('WolframKernel.exe', sibling) : kernel);
        assert.equal(r.ok, true);
        assert.equal(r.probePath, launched);
    }

    const noSeats = await probeKernelLicense('/mock/WolframKernel', {
        spawnFn: fakeSpawn('L1234-5678\t4\t0\n', 0),
    });
    assert.equal(noSeats.ok, false);
    assert.equal(noSeats.reason, 'no-seats');
    assert.doesNotMatch(noSeats.output, /L1234-5678/, 'failed checks must redact licence identifiers');

    let killed = false;
    const wedged = await probeKernelLicense('/mock/WolframKernel', {
        timeoutMs: 5,
        spawnFn: () => {
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.kill = () => { killed = true; };
            return child; // deliberately never emits close
        },
    });
    assert.equal(wedged.ok, false);
    assert.equal(wedged.timedOut, true);
    assert.equal(wedged.reason, 'timeout');
    assert.equal(killed, true);

    const failed = await diagnoseKernelLaunch(process.execPath, {
        licensePreflight: {
            ok: false,
            timedOut: false,
            exitCode: 1,
            output: 'No valid password found.',
            spawnError: null,
            durationMs: 17,
        },
    });
    assert.equal(failed.cause, 'license');
    assert.equal(failed.sub, 'mathpass-invalid');
    assert.match(failed.summary, /MathPass/i);
    assert.match(failed.summary, /repair activation/i);
    assert.ok(Array.isArray(failed.mathPassCandidates));
    assert.ok(failed.detailLines.some(line => line.includes('license preflight')));
    assert.ok(failed.detailLines.some(line => line.includes('mathpass')));

    const timeout = await diagnoseKernelLaunch(process.execPath, {
        licensePreflight: {
            ok: false,
            timedOut: true,
            exitCode: null,
            output: '',
            spawnError: null,
            durationMs: 15000,
        },
    });
    assert.equal(timeout.cause, 'license');
    assert.equal(timeout.sub, 'license-check-timeout');
    assert.match(timeout.summary, /MathLM|activation/);
    const unknown = await diagnoseKernelLaunch(process.execPath, {
        licensePreflight: { ok: false, exitCode: 2, output: 'unsupported option', durationMs: 1 },
    });
    assert.equal(unknown.cause, 'unknown');
    assert.equal(unknown.sub, 'license-check-failed');

    const candidates = findMathPassCandidates(process.execPath);
    assert.ok(candidates.length >= 4);
    assert.ok(candidates.every(c => typeof c.path === 'string'));
    assert.ok(candidates.every(c => Object.hasOwn(c, 'exists') && Object.hasOwn(c, 'readable')));

    await signalAndGateTests();

    console.log('license diagnostics: ok');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

// ── signal capture + licenseGate (field report: macOS probe "exited with code null") ──
async function signalAndGateTests() {
    const K = '/Applications/Wolfram.app/Contents/MacOS/WolframKernel';

    // The probe records WHICH signal ended it, and still refuses to vouch for WSTP.
    const killed = await probeKernelLicense(K, { spawnFn: fakeSpawn('', null, 'SIGKILL') });
    assert.equal(killed.ok, false);
    assert.equal(killed.exitCode, null);
    assert.equal(killed.signal, 'SIGKILL');
    const exited = await probeKernelLicense(K, { spawnFn: fakeSpawn('', 3) });
    assert.equal(exited.signal, null);

    // What counts as inconclusive — ONLY "said nothing about the licence".
    const verdicts = {
        signalKill:  { r: { ok: false, exitCode: null, signal: 'SIGKILL', reason: null, output: '' }, inconclusive: true },
        unknownExit: { r: { ok: false, exitCode: 2, reason: null, output: 'unsupported option' },    inconclusive: true },
        good:        { r: { ok: true, exitCode: 0, reason: null, output: '' },                        inconclusive: false },
        zero:        { r: { ok: false, exitCode: 0, reason: 'no-valid-license', output: '0 0 0' },    inconclusive: false },
        noSeats:     { r: { ok: false, exitCode: 0, reason: 'no-seats', output: '' },                 inconclusive: false },
        licText:     { r: { ok: false, exitCode: 1, reason: null, output: 'No valid password found.' }, inconclusive: false },
        licSub:      { r: { ok: false, exitCode: 0, reason: 'license-expired', output: 'x' },         inconclusive: false },
        timeout:     { r: { ok: false, timedOut: true, exitCode: null, reason: 'timeout', output: '' }, inconclusive: false },
        spawnError:  { r: { ok: false, exitCode: null, spawnError: 'ENOENT', reason: null, output: '' }, inconclusive: false },
    };
    for (const [name, v] of Object.entries(verdicts)) {
        assert.equal(isInconclusiveLicenseCheck(v.r), v.inconclusive, `inconclusive(${name})`);
    }
    assert.equal(isInconclusiveLicenseCheck(null), false);

    // licenseGate: every DEFINITE verdict behaves exactly as before, and never
    // launches the kernel a second time (freeze protection unchanged).
    const directOk  = { ok: true,  timedOut: false, exitCode: 0, output: PROBE_SENTINEL, spawnError: null, durationMs: 5 };
    const directBad = { ok: false, timedOut: false, exitCode: null, signal: 'SIGKILL', output: '', spawnError: null, durationMs: 5 };
    for (const [name, v] of Object.entries(verdicts)) {
        let directCalls = 0;
        const g = await licenseGate(K, {
            licenseProbe: async () => v.r,
            directProbe: async () => { directCalls++; return directOk; },
        });
        if (v.inconclusive) {
            assert.equal(directCalls, 1, `${name}: second opinion taken`);
            assert.equal(g.proceed, true, `${name}: kernel that runs code is not blocked`);
        } else {
            assert.equal(directCalls, 0, `${name}: no extra kernel launch on a definite verdict`);
            assert.equal(g.proceed, !!v.r.ok, `${name}: verdict unchanged`);
            assert.equal(g.directProbe, null);
        }
        assert.equal(g.licensePreflight, v.r);
    }
    // Inconclusive + the kernel does NOT reach the sentinel → still blocked.
    for (const bad of [directBad,
                       { ...directBad, signal: null, exitCode: 1, output: 'No valid password found.' },
                       { ...directBad, signal: null, timedOut: true }]) {
        const g = await licenseGate(K, { licenseProbe: async () => verdicts.signalKill.r, directProbe: async () => bad });
        assert.equal(g.proceed, false);
        assert.equal(g.directProbe, bad);
    }
    // Throwing collaborators fail closed.
    const t1 = await licenseGate(K, { licenseProbe: async () => { throw new Error('boom'); },
                                      directProbe: async () => { throw new Error('must not run'); } });
    assert.equal(t1.proceed, false);
    assert.match(t1.licensePreflight.spawnError, /boom/);
    const t2 = await licenseGate(K, { licenseProbe: async () => verdicts.signalKill.r,
                                      directProbe: async () => { throw new Error('boom'); } });
    assert.equal(t2.proceed, false);

    // Diagnosis reuses the second opinion and never launches a third kernel.
    const noThird = async () => { throw new Error('diagnose must not re-probe'); };
    const pre = { ...verdicts.signalKill.r, timedOut: false, spawnError: null, durationMs: 9, probePath: K };
    const crash = await diagnoseKernelLaunch(process.execPath, {
        licensePreflight: pre, directProbeResult: directBad, probe: noThird, platform: 'darwin',
    });
    assert.equal(crash.cause, 'kernel-crash');
    assert.match(crash.summary, /terminated by signal SIGKILL/);
    assert.match(crash.summary, /xattr -dr com\.apple\.quarantine/);
    assert.ok(crash.detailLines.some(l => /signal=SIGKILL/.test(l)), 'preflight signal in details');
    assert.ok(crash.detailLines.some(l => /inconclusive/.test(l)));
    const lic = await diagnoseKernelLaunch(process.execPath, {
        licensePreflight: pre, probe: noThird,
        directProbeResult: { ...directBad, signal: null, exitCode: 1, output: 'WolframKernel: No valid password found.' },
    });
    assert.equal(lic.cause, 'license');
    assert.equal(lic.sub, 'mathpass-invalid');
    const hang = await diagnoseKernelLaunch(process.execPath, {
        licensePreflight: pre, probe: noThird, directProbeResult: { ...directBad, signal: 'SIGKILL', timedOut: true },
    });
    assert.equal(hang.cause, 'kernel-hang');
    // A DEFINITE preflight failure ignores any direct result (licence stays the diagnosis).
    const defin = await diagnoseKernelLaunch(process.execPath, {
        licensePreflight: { ok: false, exitCode: 1, output: 'No valid password found.', durationMs: 1 },
        directProbeResult: directBad, probe: noThird,
    });
    assert.equal(defin.cause, 'license');

    // No second opinion available → old message, now naming the signal.
    const old = await diagnoseKernelLaunch(process.execPath, { licensePreflight: pre, platform: 'darwin' });
    assert.equal(old.cause, 'unknown');
    assert.equal(old.sub, 'license-check-failed');
    assert.match(old.summary, /terminated by signal SIGKILL/);
    assert.doesNotMatch(old.summary, /code null/);
    assert.match(old.summary, /"\/Applications\/Wolfram\.app"/);
    const linux = await diagnoseKernelLaunch(process.execPath, { licensePreflight: pre, platform: 'linux' });
    assert.doesNotMatch(linux.summary, /xattr/, 'macOS hint only on macOS');
    const plainExit = await diagnoseKernelLaunch(process.execPath, {
        licensePreflight: { ok: false, exitCode: 2, output: 'unsupported option', durationMs: 1 }, platform: 'darwin' });
    assert.match(plainExit.summary, /exited with code 2/);
    assert.doesNotMatch(plainExit.summary, /xattr/, 'no Gatekeeper hint without a signal');

    // End to end with REAL processes (the field failure): -licenseinfo is killed
    // by SIGKILL, yet the kernel itself runs code → WSTP may start.
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lic-'));
    try {
        const mk = (name, body) => {
            const f = path.join(dir, name);
            fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n');
            fs.chmodSync(f, 0o755);
            return f;
        };
        const fieldCase = mk('kernel-ok', `case "$1" in -licenseinfo) kill -9 $$;; esac\necho ${PROBE_SENTINEL}\nsleep 5`);
        const deadKernel = mk('kernel-dead', 'kill -9 $$');
        const realKilled = await probeKernelLicense(fieldCase);
        assert.equal(realKilled.ok, false);
        assert.equal(realKilled.signal, 'SIGKILL', 'real signal is captured');
        const g1 = await licenseGate(fieldCase);
        assert.equal(g1.proceed, true, 'field case: working kernel is no longer blocked');
        assert.equal(g1.directProbe.ok, true);
        const realDead = await probeKernelDirect(deadKernel, { timeoutMs: 5000 });
        assert.equal(realDead.signal, 'SIGKILL');
        const g2 = await licenseGate(deadKernel);
        assert.equal(g2.proceed, false, 'a kernel that is killed on launch stays blocked');
        const d2 = await diagnoseKernelLaunch(deadKernel, {
            licensePreflight: g2.licensePreflight, directProbeResult: g2.directProbe, probe: noThird });
        assert.equal(d2.cause, 'kernel-crash');
        assert.match(d2.summary, /signal SIGKILL/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
