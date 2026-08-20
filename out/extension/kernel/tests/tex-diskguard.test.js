// Not losing somebody else's work.
//
//   node out/extension/kernel/tests/tex-diskguard.test.js
//
// A .tex here is a shared object: Dropbox syncs it, a collaborator or a git
// checkout rewrites it, and an agent can be holding content it read minutes
// ago. Two things must never happen — a change on disk vanishing under a save,
// and an edit computed against stale content being applied on top of it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); }
};

const {
    hashText, classifyExternalChange, checkWritable, DiskWatch, VERDICT,
} = require('../../tex/diskGuard');

// --- classifying a change on disk -------------------------------------------

test('our own save coming back is not an external change', () => {
    // The watcher fires on every write, including ours. Comparing CONTENT (not
    // mtime) is what stops a save looking like somebody else's edit.
    assert.strictEqual(
        classifyExternalChange({ diskText: 'same', docText: 'same', isDirty: false }),
        VERDICT.UNCHANGED);
    assert.strictEqual(
        classifyExternalChange({ diskText: 'same', docText: 'same', isDirty: true }),
        VERDICT.UNCHANGED, 'even with unsaved edits elsewhere in the buffer');
});

test('a clean buffer needs no prompt — VS Code reloads it', () => {
    assert.strictEqual(
        classifyExternalChange({ diskText: 'theirs', docText: 'ours', isDirty: false }),
        VERDICT.EXTERNAL_CLEAN);
});

test('a dirty buffer plus a changed disk is the case a human must decide', () => {
    assert.strictEqual(
        classifyExternalChange({ diskText: 'theirs', docText: 'ours', isDirty: true }),
        VERDICT.CONFLICT);
});

test('a deleted file is reported as deleted, not as a conflict', () => {
    assert.strictEqual(
        classifyExternalChange({ diskText: null, docText: 'ours', isDirty: true }),
        VERDICT.DELETED);
});

// --- refusing to write ------------------------------------------------------

test('an edit against current content is allowed', () => {
    assert.deepStrictEqual(checkWritable({ diskText: 'v1', baseText: 'v1' }), { ok: true });
});

test('AN EDIT AGAINST STALE CONTENT IS REFUSED', () => {
    // The one that matters: the agent read v1, someone else wrote v2, and the
    // edit would silently drop v2.
    const r = checkWritable({ diskText: 'v2', baseText: 'v1', isDirty: false });
    assert.strictEqual(r.ok, false);
    assert.ok(/changed on disk/.test(r.reason), r.reason);
    assert.strictEqual(r.diskHash, hashText('v2'), 'and says what disk holds now');
});

test('SAVING A DIRTY BUFFER OVER A CHANGED DISK IS REFUSED', () => {
    const r = checkWritable({ diskText: 'theirs', baseText: 'theirs', isDirty: true, willSave: true });
    assert.strictEqual(r.ok, true, 'writing into the buffer is fine…');
    const s = checkWritable({ diskText: 'theirs', baseText: 'what we read', isDirty: true, willSave: true });
    assert.strictEqual(s.ok, false, '…but not when disk moved away from what we read');
    assert.ok(/discard/.test(s.reason), s.reason);
});

test('editing a dirty buffer without saving is allowed', () => {
    // The user's own unsaved edits are why disk differs; that is not something
    // the file needs protecting from, and VS Code owns the save conflict.
    assert.strictEqual(
        checkWritable({ diskText: 'ondisk', baseText: 'ondisk', isDirty: true, willSave: false }).ok,
        true);
});

test('a document with no file on disk can always be written', () => {
    // Untitled, or deleted underneath us: the buffer is the only copy, so there
    // is nothing a write could destroy. Blocking here would be backwards.
    const r = checkWritable({ diskText: null, baseText: 'anything', isDirty: true, willSave: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.absent, true);
});

// --- one prompt per change --------------------------------------------------

test('a repeated event for the SAME disk content does not re-prompt', () => {
    // Dropbox fires several change events for a single write.
    const w = new DiskWatch();
    const args = { diskText: 'theirs', docText: 'ours', isDirty: true };
    const a = w.classify('/p/main.tex', args);
    assert.strictEqual(a.verdict, VERDICT.CONFLICT);
    assert.strictEqual(a.repeat, false, 'the first one asks');
    const b = w.classify('/p/main.tex', args);
    assert.strictEqual(b.repeat, true, 'the second stays quiet');
});

test('but a NEW change on disk asks again', () => {
    const w = new DiskWatch();
    w.classify('/p/main.tex', { diskText: 'theirs', docText: 'ours', isDirty: true });
    const c = w.classify('/p/main.tex', { diskText: 'theirs again', docText: 'ours', isDirty: true });
    assert.strictEqual(c.repeat, false);
});

test('accepting content up front suppresses the prompt for it', () => {
    const w = new DiskWatch();
    w.accept('/p/main.tex', 'theirs');
    const r = w.classify('/p/main.tex', { diskText: 'theirs', docText: 'ours', isDirty: true });
    assert.strictEqual(r.repeat, true, 'already known, so no prompt');
});

test('files are tracked independently', () => {
    const w = new DiskWatch();
    w.classify('/p/a.tex', { diskText: 'x', docText: 'y', isDirty: true });
    const r = w.classify('/p/b.tex', { diskText: 'x', docText: 'y', isDirty: true });
    assert.strictEqual(r.repeat, false, 'b.tex has not been reported');
});

// --- the compile must never touch the source --------------------------------

test('a live compile writes the overlay, NEVER the .tex', () => {
    // Live rendering compiles unsaved buffers. If that ever wrote back to the
    // user's file it would be the worst version of this bug, so it is asserted
    // against the real compileService rather than trusted.
    const { compile } = require('../../tex/compileService');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtex-guard-'));
    const root = path.join(dir, 'main.tex');
    const onDisk = '\\documentclass{article}\\begin{document}saved\\end{document}\n';
    fs.writeFileSync(root, onDisk);
    const before = fs.readFileSync(root, 'utf8');

    // Not awaited: the assertion is about what the SOURCE looks like, and the
    // overlay is written synchronously at the top of compile().
    const p = compile({
        root,
        sourceFiles: [root],
        overlay: new Map([[root, '\\documentclass{article}\\begin{document}TYPED\\end{document}\n']]),
        timeoutMs: 1,
    });
    assert.strictEqual(fs.readFileSync(root, 'utf8'), before,
        'the user file is byte-identical after a live compile started');
    p.catch(() => {}).then(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* fine */ }
    });
});

console.log('not losing somebody else\'s work\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
