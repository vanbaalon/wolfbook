'use strict';

// NOTHING MAY REGISTER THE `type` COMMAND.
//
//   node out/extension/kernel/tests/no-type-hijack.test.js
//
// VS Code allows exactly ONE registration of `type` in the whole editor. The
// first extension to activate wins; every other registration fails. VSCodeVim
// is built on `type`, so an extension that takes it disables Vim ENTIRELY — in
// every file type, including plain text files this extension has no interest
// in, and whether or not the handler politely forwards to `default:type`. The
// damage is done by taking the registration, not by what is done with it.
//
// Reported as vanbaalon/wolfbook#17. escape-mode.js had one, and it turned out
// to do nothing at all: it appended to a buffer nothing read, refreshed a
// highlight the selection listener already refreshes, and ended every branch in
// `default:type`.
//
// This guard is cheap and the failure it prevents is invisible from inside this
// extension — everything here keeps working perfectly while another extension
// silently dies.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const EXT = path.join(__dirname, '..', '..');

/** Every .js file under out/extension, excluding tests and vendored code. */
function sourceFiles(dir, out = []) {
    for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === 'tests') continue;
        const full = path.join(dir, name);
        let st;
        try { st = fs.statSync(full); } catch (_) { continue; }
        if (st.isDirectory()) sourceFiles(full, out);
        else if (name.endsWith('.js')) out.push(full);
    }
    return out;
}

const FILES = sourceFiles(EXT);
const rel = (f) => path.relative(EXT, f);

console.log('the global `type` command');

t('there is source to scan at all', () => {
    assert.ok(FILES.length > 50, `only ${FILES.length} files found — the walk is wrong`);
});

t('no file registers the `type` command', () => {
    // Both spellings, and the TextEditor variant.
    const re = /register(?:TextEditor)?Command\(\s*['"`]type['"`]/;
    const offenders = FILES.filter(f => {
        const src = fs.readFileSync(f, 'utf8');
        return src.split('\n').some(line => !/^\s*(\/\/|\*)/.test(line) && re.test(line));
    }).map(rel);
    assert.deepStrictEqual(offenders, [],
        `these take the global \`type\` command and will disable VSCodeVim: ${offenders.join(', ')}`);
});

t('nor the `replacePreviousChar` / `compositionType` siblings', () => {
    // Same one-owner rule, same consequence for IME and Vim users.
    const re = /register(?:TextEditor)?Command\(\s*['"`](replacePreviousChar|compositionType|compositionStart|compositionEnd|paste|cut)['"`]/;
    const offenders = FILES.filter(f => {
        const src = fs.readFileSync(f, 'utf8');
        return src.split('\n').some(line => !/^\s*(\/\/|\*)/.test(line) && re.test(line));
    }).map(rel);
    assert.deepStrictEqual(offenders, [],
        `these take a single-owner editor command: ${offenders.join(', ')}`);
});

t('escape mode still exists, and still updates its highlight', () => {
    // The fix was to DELETE the interception, so check the feature it belonged
    // to is intact rather than that the file is merely quiet.
    const src = fs.readFileSync(path.join(EXT, 'escape-mode.js'), 'utf8');
    assert.ok(/registerEscapeMode/.test(src), 'the feature is still registered');
    assert.ok(/onDidChangeTextEditorSelection/.test(src),
        'the selection listener is what keeps the highlight current — typing moves the cursor');
    assert.ok(/updateEscapeModeHighlight\(event\.textEditor\)/.test(src),
        'and it must actually refresh the highlight');
    assert.ok(/const docText = editor\.document\.getText\(range\)/.test(src),
        'the alias is read from the DOCUMENT, which is why no keystroke buffer is needed');
});

t('the reason is written down where the next person will look', () => {
    // A deletion with no explanation invites the same code back.
    const src = fs.readFileSync(path.join(EXT, 'escape-mode.js'), 'utf8');
    assert.ok(/NO `type` COMMAND\. THIS IS NOT AN OVERSIGHT/.test(src));
    assert.ok(/VSCodeVim/.test(src), 'naming what it broke is the whole point');
});

console.log(`\n${pass} assertions passed`);
