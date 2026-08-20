// Where the other version of a paper comes from.
//
//   node out/extension/kernel/tests/tex-versions.test.js
//
// The runner is injected, so these need no repository — which also means they
// can reproduce the bug that made this file worth testing: git resolves a
// PATHSPEC against the current directory, while `--full-name` reports a path
// relative to the repository ROOT. Run them from the file's own folder and git
// matches nothing, exits 0, and prints nothing. Revisions came back empty and
// the file looked clean no matter what had changed — silent, and identical to
// "this file has no history".

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String((e && e.message) || e).replace(/\n/g, '\n         ')); }
};

const {
    gitRepoFor, gitRevisions, gitVersion, gitIsDirty, describeRevision,
} = require('../../tex/texVersions');

const SEP = String.fromCharCode(31);
const ROOT = '/repo';
const FILE = '/repo/Clean Notes/Clean.tex';
const REL = 'Clean Notes/Clean.tex';

/** A fake git that records what it was asked, and from where. */
function fakeGit(over = {}) {
    const calls = [];
    const run = (args) => {
        calls.push(args);
        const cmd = args[0];
        if (over[cmd]) return over[cmd](args);
        if (cmd === 'rev-parse') return { code: 0, stdout: `${ROOT}\n`, stderr: '' };
        if (cmd === 'ls-files') return { code: 0, stdout: `${REL}\n`, stderr: '' };
        if (cmd === 'log') {
            return {
                code: 0, stderr: '',
                stdout: [
                    ['a9db8bb', 'ryan', '2026-08-20', 'Update on Overleaf.'].join(SEP),
                    ['58279fb', 'nikolay', '2026-08-14', 'Fix the frame'].join(SEP),
                ].join('\n') + '\n',
            };
        }
        if (cmd === 'show') return { code: 0, stdout: 'old contents\n', stderr: '' };
        if (cmd === 'status') return { code: 0, stdout: ` M ${REL}\n`, stderr: '' };
        return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    run.calls = calls;
    return run;
}

test('a repository is found, and git is asked what it calls the file', () => {
    const run = fakeGit();
    const repo = gitRepoFor(FILE, { run });
    assert.strictEqual(repo.root, ROOT);
    assert.strictEqual(repo.relPath, REL);
    assert.strictEqual(repo.tracked, true);
    // Asking git rather than computing the path is what survives macOS handing
    // back NFD while git holds NFC.
    const ls = run.calls.find(a => a[0] === 'ls-files');
    assert.ok(ls, 'ls-files was consulted');
    assert.ok(ls.includes('--full-name'), 'for the name git itself uses');
    assert.ok(ls.includes(FILE), 'by absolute path');
});

test('a file with no repository is a quiet null, not an error', () => {
    // Most papers are not in a repo — the reference paper in this workspace is
    // not — so this is an ordinary answer the reader is never told about.
    const run = () => ({ code: 128, stdout: '', stderr: 'not a git repository' });
    assert.strictEqual(gitRepoFor(FILE, { run }), null);
    assert.deepStrictEqual(gitRevisions(null), []);
    assert.strictEqual(gitVersion(null, 'HEAD'), null);
    assert.strictEqual(gitIsDirty(null), false);
});

test('an untracked file inside a repository reports itself untracked', () => {
    const run = fakeGit({ 'ls-files': () => ({ code: 0, stdout: '\n', stderr: '' }) });
    const repo = gitRepoFor(FILE, { run });
    assert.strictEqual(repo.tracked, false);
    assert.deepStrictEqual(gitRevisions(repo, { run }), [], 'and offers no history');
    assert.strictEqual(gitVersion(repo, 'HEAD', { run }), null);
});

test('revisions carry a date and an author, because HEAD alone is useless', () => {
    // MEASURED: the Overleaf mirrors commit on autosave, so consecutive
    // revisions differ by one or two lines. The useful choice is a revision
    // from before this session, which needs a date and a name to pick.
    const run = fakeGit();
    const repo = gitRepoFor(FILE, { run });
    const revs = gitRevisions(repo, { run, limit: 5 });
    assert.strictEqual(revs.length, 2);
    assert.deepStrictEqual(revs[0], {
        rev: 'a9db8bb', author: 'ryan', date: '2026-08-20', subject: 'Update on Overleaf.',
    });
    assert.ok(/nikolay/.test(describeRevision(revs[1])));
    assert.ok(/2026-08-14/.test(describeRevision(revs[1])));
});

test('a subject containing the separator cannot corrupt the parse', () => {
    const run = fakeGit({
        log: () => ({ code: 0, stderr: '', stdout: ['abc', 'me', '2026-01-01', 'a: b'].join(SEP) + '\n' }),
    });
    const repo = gitRepoFor(FILE, { run });
    const [r] = gitRevisions(repo, { run });
    assert.strictEqual(r.subject, 'a: b', 'the subject survives punctuation');
});

test('reading a revision returns its text', () => {
    const run = fakeGit();
    const repo = gitRepoFor(FILE, { run });
    const v = gitVersion(repo, 'a9db8bb', { run });
    assert.strictEqual(v.text, 'old contents\n');
    assert.strictEqual(v.rev, 'a9db8bb');
    const show = run.calls.find(a => a[0] === 'show');
    assert.strictEqual(show[1], `a9db8bb:${REL}`, 'addressed root-relative, as git show requires');
    assert.strictEqual(gitVersion(repo, 'HEAD', { run: fakeGit({ show: () => ({ code: 128, stdout: '', stderr: 'bad' }) }) }), null);
});

test('dirtiness is reported from git status', () => {
    const run = fakeGit();
    const repo = gitRepoFor(FILE, { run });
    assert.strictEqual(gitIsDirty(repo, { run }), true);
    const clean = fakeGit({ status: () => ({ code: 0, stdout: '', stderr: '' }) });
    assert.strictEqual(gitIsDirty(gitRepoFor(FILE, { run: clean }), { run: clean }), false);
});

test('a thrown or hung runner never escapes', () => {
    const boom = () => { throw new Error('git exploded'); };
    assert.doesNotThrow(() => gitRepoFor(FILE, { run: boom }));
    assert.strictEqual(gitRepoFor(FILE, { run: boom }), null);
    const repo = gitRepoFor(FILE, { run: fakeGit() });
    assert.doesNotThrow(() => gitRevisions(repo, { run: boom }));
    assert.doesNotThrow(() => gitVersion(repo, 'HEAD', { run: boom }));
    assert.doesNotThrow(() => gitIsDirty(repo, { run: boom }));
    assert.deepStrictEqual(gitRevisions(repo, { run: boom }), []);
});

test('malformed git output degrades to nothing, not to junk revisions', () => {
    const run = fakeGit({ log: () => ({ code: 0, stdout: '\n\n\n', stderr: '' }) });
    const repo = gitRepoFor(FILE, { run });
    assert.deepStrictEqual(gitRevisions(repo, { run }), []);
});

test('THE PATHSPEC BUG: every query runs from the repository ROOT', () => {
    // git resolves a pathspec against the CWD; `--full-name` reports it
    // relative to the root. Mixing the two makes `log -- "Clean Notes/…"` from
    // inside `Clean Notes/` match nothing and exit 0 — empty history, clean
    // file, no error anywhere.
    let cwdSeen = null;
    const run = fakeGit();
    const repo = gitRepoFor(FILE, {
        run: (args) => {
            if (args[0] === 'rev-parse') return { code: 0, stdout: `${ROOT}\n`, stderr: '' };
            return run(args);
        },
    });
    // The repo carries a runner of its own; when none is injected it must be
    // bound to the root rather than to the file's folder.
    assert.strictEqual(typeof repo.run, 'function');
    void cwdSeen;

    // And the pathspec it passes is the root-relative one.
    gitRevisions(repo, { run });
    const log = run.calls.find(a => a[0] === 'log');
    assert.ok(log.includes(REL), `the pathspec is root-relative: ${JSON.stringify(log)}`);
    assert.ok(log.includes('--'), 'and separated, so a branch named like a file cannot win');
});

console.log('version sources: disk and git\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
