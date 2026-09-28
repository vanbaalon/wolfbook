'use strict';
// What a FAILED WPaper compile is allowed to say.
//
// GitHub issue #21: a Windows user got
//     lualatex produced no PDF (unknown reason) — trying pdflatex
//     FAILED · ? pages · 0 error(s) · 0 warning(s) · ? pass(es) · 112 ms
// while we were holding exit code 3221226505 and the whole of stderr. He found
// the cause — `detached: true` kills latexmk on Windows — by patching our
// source. Both halves of that are guarded here: the spawn options, and the
// rule that "no evidence" must never render as "evidence of success".

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SERVICE = path.join(__dirname, '..', '..', 'tex', 'compileService.js');
const RENDERUI = path.join(__dirname, '..', '..', 'tex', 'renderUi.js');
const { describeExit, describeCompileFailure } = require('../../tex/compileService');

let pass = 0;
function t(name, fn) {
    try { fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('spawn options (issue #21)');

t('latexmk is never detached on Windows', () => {
    const src = fs.readFileSync(SERVICE, 'utf8');
    const i = src.indexOf('function spawnCollect');
    const body = src.slice(i, src.indexOf('\nfunction ', i + 10));
    assert.ok(!/detached:\s*true/.test(body),
        'detached:true — on Windows this gives the child its own console and ' +
        'latexmk dies with 0xC0000409 before writing a log');
    assert.ok(/detached:\s*!_WIN|detached:\s*process\.platform\s*!==\s*'win32'/.test(body),
        'the detach must be guarded by platform');
});

t('the group kill uses a mechanism that exists on the platform', () => {
    const src = fs.readFileSync(SERVICE, 'utf8');
    const i = src.indexOf('const killGroup');
    const body = src.slice(i, i + 700);
    assert.ok(/taskkill/.test(body),
        'process.kill(-pid) is POSIX-only; Windows needs taskkill /T, or a ' +
        'cancelled compile leaves a pdflatex holding the out dir');
    assert.ok(/process\.kill\(-child\.pid/.test(body), 'POSIX must still get the group kill');
});

console.log('exit codes are named, not just printed');

t('a Windows NTSTATUS is decoded', () => {
    // The exact code from the report.
    const s = describeExit(3221226505, 'win32');
    assert.ok(/0xC0000409/.test(s), `no hex in: ${s}`);
    assert.ok(/STATUS_STACK_BUFFER_OVERRUN/.test(s), `no name in: ${s}`);
});

t('ordinary codes stay readable', () => {
    assert.strictEqual(describeExit(0, 'win32'), '0');
    assert.strictEqual(describeExit(1, 'linux'), '1');
    assert.strictEqual(describeExit('ETIMEDOUT', 'linux'), 'ETIMEDOUT');
    assert.match(describeExit(null, 'linux'), /no exit code/);
    // A large code on POSIX is not an NTSTATUS and must not be dressed as one.
    assert.strictEqual(describeExit(3221226505, 'linux'), '3221226505');
});

console.log('"no evidence" never renders as "evidence of success"');

const DIED = {
    ok: false, exit: 3221226505, ms: 112, logWritten: false, pdfPath: null,
    errors: 0, warnings: 0, stderr: '', command: 'latexmk -pdf Test.tex', commandCwd: 'C:\\tmp',
};

t('a compile that never started says so', () => {
    const lines = describeCompileFailure(DIED, 'win32').join('\n');
    assert.match(lines, /engine never ran/);
    assert.match(lines, /0xC0000409/, 'the decoded exit code must be in the report');
    assert.match(lines, /not a problem with the document/,
        'the user must be told where NOT to look');
    assert.match(lines, /latexmk -pdf Test\.tex/, 'the spawn line is what he had to add by hand');
});

t('an empty stderr is reported as empty, not omitted', () => {
    const lines = describeCompileFailure(DIED, 'win32').join('\n');
    assert.match(lines, /stderr was empty/,
        'silence from a LaTeX run is itself a strong signal — say it');
});

t('stderr is surfaced when there is any', () => {
    const lines = describeCompileFailure({ ...DIED, stderr: "perl: can't locate Foo.pm" }, 'win32');
    assert.ok(lines.some(l => /can't locate Foo\.pm/.test(l)), 'stderr was captured and dropped');
});

t('an ordinary LaTeX error adds nothing — the diagnostics list already explains it', () => {
    const rejected = { ok: false, exit: 12, ms: 4200, logWritten: true,
        pdfPath: null, errors: 3, warnings: 1, stderr: '' };
    assert.deepStrictEqual(describeCompileFailure(rejected, 'linux'), [],
        'do not editorialise over a real error list');
});

t('a successful or cancelled compile is never described as a failure', () => {
    assert.deepStrictEqual(describeCompileFailure({ ...DIED, ok: true }, 'win32'), []);
    assert.deepStrictEqual(describeCompileFailure({ ...DIED, cancelled: true }, 'win32'), []);
    assert.deepStrictEqual(describeCompileFailure(null, 'win32'), []);
});

console.log('the output channel');

t('the failure line does not claim 0 errors when no log was written', () => {
    const src = fs.readFileSync(RENDERUI, 'utf8');
    const i = src.indexOf("`  ${gen.ok ? 'ok' : 'FAILED'}");
    assert.ok(i > 0, 'the compile summary line was not found');
    const body = src.slice(Math.max(0, i - 700), i + 700);
    assert.ok(/no log written/.test(body),
        '"0 error(s)" is a claim about the document; it needs a log to stand on');
    assert.ok(/describeCompileFailure\(gen\)/.test(src),
        'the exit code and stderr must reach the channel');
});

t('nothing still prints "unknown reason" while holding an exit code', () => {
    const src = fs.readFileSync(RENDERUI, 'utf8');
    const i = src.indexOf('produced no PDF (');
    assert.ok(i > 0, 'the fallback line was not found');
    const body = src.slice(i, i + 400);
    assert.ok(!/unknown reason/.test(body), 'we know the reason — print it');
    assert.ok(/describeExit\(gen\.exit\)/.test(body), 'the exit code belongs in that line');
});

if (!process.exitCode) console.log(`\n${pass} assertions passed`);
