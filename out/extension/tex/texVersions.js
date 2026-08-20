// texVersions.js — where the OTHER version of a paper comes from.
//
// No vscode: the process runner is injected, so the suites drive it without a
// repository and the extension can hand it either a spawn or the built-in git
// extension's API.
//
// WHY THE RUNNER IS INJECTED AT ALL. `git` is frequently absent from a VS Code
// extension host's PATH on macOS — ours lives at /opt/homebrew/bin/git, which
// a GUI-launched process does not inherit — so the extension prefers VS Code's
// own git integration and keeps spawning as the fallback. Tests inject a fake
// and never touch a real repository.
//
// Arguments are always an ARGV ARRAY, never a shell string: these paths contain
// spaces, live under Dropbox, and on macOS arrive in NFD while git may hold
// NFC. That last one is why the path git actually knows is asked for with
// `ls-files` rather than assumed from the filesystem.

const path = require('path');

/** The default runner: spawn git and collect its output. */
function spawnRunner(cwd) {
    const { spawnSync } = require('child_process');
    return (args) => {
        const r = spawnSync('git', args, {
            cwd, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 20000,
        });
        return {
            code: r.status == null ? 1 : r.status,
            stdout: r.stdout || '',
            stderr: r.stderr || (r.error ? r.error.message : ''),
        };
    };
}

/**
 * The repository a file belongs to, or null.
 *
 * NEVER THROWS AND NEVER REPORTS AN ERROR. Most papers are not in a repository
 * — the reference paper in this workspace is not — and "there is no git here"
 * is an ordinary answer, not a failure the reader should be told about.
 */
function gitRepoFor(fsPath, opts = {}) {
    const dir = path.dirname(fsPath);
    const run = opts.run || spawnRunner(dir);
    try {
        const top = run(['rev-parse', '--show-toplevel']);
        if (top.code !== 0) return null;
        const root = top.stdout.trim();
        if (!root) return null;
        // ASK GIT WHAT IT CALLS THE FILE. A path built by string arithmetic
        // differs from git's own whenever unicode normalisation does — routine
        // on macOS, where the filesystem hands back NFD.
        const ls = run(['ls-files', '--full-name', '--', fsPath]);
        const rel = ls.code === 0 ? ls.stdout.split('\n')[0].trim() : '';
        // BIND THE RUNNER TO THE REPOSITORY ROOT, not to the file's folder.
        //
        // git resolves a pathspec against the CURRENT DIRECTORY, while
        // `--full-name` reports it relative to the ROOT. Run
        // `log -- "Clean Notes/Clean.tex"` from inside `Clean Notes/` and git
        // matches nothing, exits 0, and prints nothing — so revisions came back
        // empty and the file looked clean no matter what had changed. Silent,
        // and indistinguishable from "no history".
        const atRoot = opts.run || spawnRunner(root);
        return { root, relPath: rel || path.relative(root, fsPath), tracked: !!rel, run: atRoot };
    } catch (_) { return null; }
}

/** Is this file different from what git has committed? */
function gitIsDirty(repo, opts = {}) {
    if (!repo || !repo.tracked) return false;
    const run = opts.run || repo.run;
    try {
        const r = run(['status', '--porcelain', '--', repo.relPath]);
        return r.code === 0 && r.stdout.trim().length > 0;
    } catch (_) { return false; }
}

/**
 * Revisions that touched this file, newest first.
 *
 * MEASURED, and it shapes the picker: the Overleaf mirrors in this workspace
 * commit on autosave, so consecutive revisions differ by one or two lines and
 * "compare with HEAD" is nearly always empty. What a reader wants is a revision
 * from BEFORE their session, so each entry carries a date and an author and the
 * caller shows them.
 */
function gitRevisions(repo, opts = {}) {
    if (!repo || !repo.tracked) return [];
    const run = opts.run || repo.run;
    const limit = Number.isFinite(opts.limit) ? opts.limit : 40;
    try {
        // A unit separator, written as an ESCAPE. A raw control byte in
        // source makes the whole file BINARY to grep and git, which cost
        // an afternoon earlier in this workstream.
        const SEP = '\u001f';
        const r = run([
            'log', `-${limit}`, `--format=%h${SEP}%an${SEP}%ad${SEP}%s`,
            '--date=short', '--', repo.relPath,
        ]);
        if (r.code !== 0) return [];
        return r.stdout.split('\n').filter(Boolean).map((line) => {
            const [rev, author, date, subject] = line.split(SEP);
            return { rev, author, date, subject: subject || '' };
        });
    } catch (_) { return []; }
}

/**
 * The file's content at a revision, or null.
 *
 * `HEAD` is the useful default: it answers "what have I changed since my last
 * commit", which is the question VS Code's own gutter is already showing.
 */
function gitVersion(repo, rev, opts = {}) {
    if (!repo || !repo.tracked) return null;
    const run = opts.run || repo.run;
    try {
        const r = run(['show', `${rev || 'HEAD'}:${repo.relPath}`]);
        if (r.code !== 0) return null;
        return { text: r.stdout, rev: rev || 'HEAD' };
    } catch (_) { return null; }
}

/** A label a reader recognises: `HEAD (Nikolay, 2026-08-14)`. */
function describeRevision(entry) {
    if (!entry) return 'HEAD';
    const who = [entry.author, entry.date].filter(Boolean).join(', ');
    return `${entry.rev}${who ? ` (${who})` : ''}${entry.subject ? ` — ${entry.subject}` : ''}`;
}

module.exports = {
    gitRepoFor, gitRevisions, gitVersion, gitIsDirty, describeRevision, spawnRunner,
};
