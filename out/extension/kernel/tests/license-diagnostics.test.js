'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
    classifyKernelOutput,
    diagnoseKernelLaunch,
    findMathPassCandidates,
    probeKernelLicense,
} = require('../diagnose');

function fakeSpawn(output, exitCode) {
    return (_command, args) => {
        assert.deepEqual(args, ['-licenseinfo']);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        process.nextTick(() => {
            child.stderr.end(output);
            child.emit('close', exitCode);
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

    const candidates = findMathPassCandidates(process.execPath);
    assert.ok(candidates.length >= 4);
    assert.ok(candidates.every(c => typeof c.path === 'string'));
    assert.ok(candidates.every(c => Object.hasOwn(c, 'exists') && Object.hasOwn(c, 'readable')));

    console.log('license diagnostics: ok');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
