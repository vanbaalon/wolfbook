// compileService.js — CompileGeneration: the authoritative compile.
//
// No vscode: node only (child_process, fs), so it is testable headlessly and
// reusable from a CLI. The vscode-facing scheduling lives in tex/index.js.
//
// Every decision here was measured in Stage 0 Spike D (288-cell sweep,
// 15 papers x 3 runners x 6 overlay strategies). See
// Experiments/wolfbook-tex/d-orchestration/VERDICT.md.
//
//   RUNNER: latexmk. A hand-rolled engine loop is 1.2-1.4x faster and gets
//     three things wrong that cost correctness: it runs bibtex because the
//     .aux says \bibdata (destroying an arXiv paper's shipped .bbl -> 50
//     undefined citations), it misses a document that silently switches the
//     engine to DVI mode, and it never runs makeindex.
//
//   OVERLAY: cwd-in-outdir. The ONLY one of six that is 14/14 on all three of
//     compiles / project byte-identical / SyncTeX naming the user's own files.
//     `-output-directory` alone is NOT out-of-tree: restricted \write18 runs
//     helpers with the ENGINE's cwd, so epstopdf writes converted figures into
//     the source directory. A symlink farm writes THROUGH its own links and
//     overwrote a user's PDF. A full copy is clean but costs 47 ms/compile on
//     a real 43 MB paper directory and loses SyncTeX entirely (0/14).
//
//   NO -halt-on-error. On a document with one recoverable error it produces no
//     PDF at all; with -f the same document ships 12 pages AND still logs the
//     error. An editor needs the best-effort PDF *and* the diagnostics.
//
//   pdfHash IS A CONTENT HASH. Bytes differ on every run (/CreationDate).
//     SOURCE_DATE_EPOCH fixes that but FORCE_SOURCE_DATE prints "January 1,
//     1970" on the title page, so we scrub the metadata and hash the rest.
//
//   NEVER SET TMPDIR. Giving biber a fresh one costs 5.2x (3.4 s -> 17.6 s):
//     it unpacks its Perl runtime there on first run.
//
//   outDir IS STABLE PER DOCUMENT. A fresh directory per compile discards the
//     .aux/.fdb_latexmk cache (712 ms and 2 passes, against 76 ms and 0) and
//     changes the .synctex for reasons unrelated to the source.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { parseLog } = require('./texLog');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

let _generation = 0;
const nextGeneration = () => ++_generation;

/** Stable, per-document scratch directory. Never inside the user's project. */
function defaultOutDir(root) {
    const key = sha256(path.resolve(root)).slice(0, 16);
    return path.join(os.tmpdir(), 'wolfbook-tex', key);
}

/** Every directory the project uses, mirrored EMPTY into the out dir. */
function mirrorSkeleton(projectDir, outDir, maxDirs = 400) {
    let made = 0;
    const walk = (rel, depth) => {
        if (depth > 6 || made >= maxDirs) return;
        let ents;
        try { ents = fs.readdirSync(path.join(projectDir, rel), { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
            if (!e.isDirectory()) continue;
            if (/^(\.|node_modules$)/.test(e.name)) continue;
            const sub = path.join(rel, e.name);
            try { fs.mkdirSync(path.join(outDir, sub), { recursive: true }); made++; } catch (_) { /* fine */ }
            walk(sub, depth + 1);
        }
    };
    walk('', 0);
    return made;
}

/**
 * Hash a PDF's CONTENT, ignoring the parts that move on every run.
 * Scrubs /CreationDate, /ModDate, the file /ID and the XMP packet.
 */
function pdfContentHash(buf) {
    let s = buf.toString('latin1');
    s = s
        .replace(/\/CreationDate\s*\([^)]*\)/g, '/CreationDate()')
        .replace(/\/ModDate\s*\([^)]*\)/g, '/ModDate()')
        .replace(/\/ID\s*\[[^\]]*\]/g, '/ID[]')
        .replace(/<\?xpacket begin[\s\S]*?<\?xpacket end[^>]*\?>/g, '')
        .replace(/<xmp:(CreateDate|ModifyDate|MetadataDate)>[^<]*<\/xmp:\1>/g, '');
    return sha256(Buffer.from(s, 'latin1'));
}

/** Page count from the PDF itself — the log's number is absent on a failure. */
function pdfPageCount(buf) {
    const s = buf.toString('latin1');
    // Count leaf /Type /Page objects; /Count can be wrong on a damaged file and
    // is absent when object streams hide the page tree.
    const leaves = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (leaves) return leaves;
    const m = /\/Count\s+(\d+)/.exec(s);
    return m ? Number(m[1]) : null;
}

function snapshotSources(files, overlay) {
    const h = crypto.createHash('sha256');
    for (const f of [...files].sort()) {
        h.update(f);
        // An unsaved buffer is the truth about what was compiled. Hashing the
        // file on disk instead would make a live compile look already-current
        // on the next keystroke, and nothing would ever recompile.
        // Hash the TEXT, with no marker for where it came from. Saving a
        // buffer whose live compile already ran must leave the generation
        // current — the bytes are identical, so recompiling would be work the
        // reader can see (a swap) for a result that cannot differ.
        const dirty = overlay instanceof Map ? overlay.get(f) : undefined;
        if (dirty !== undefined) { h.update(dirty); continue; }
        try { h.update(fs.readFileSync(f)); } catch (_) { h.update('\0missing'); }
    }
    return h.digest('hex');
}

/**
 * THE COMPILE. Never rejects on a failed compile — a broken paper is data.
 *
 * @param {object} o
 * @param {string} o.root          absolute path to the root .tex
 * @param {string} [o.outDir]      stable scratch dir; defaults per document
 * @param {string} [o.engine]      pdflatex | lualatex | xelatex
 * @param {AbortSignal} [o.signal]
 * @param {(line:string)=>void} [o.onLog]
 * @param {string[]} [o.sourceFiles] for sourceSnapshotHash (the include graph)
 * @returns {Promise<object>} the CompileGeneration record
 */
async function compile(o = {}) {
    const t0 = Date.now();
    const root = path.resolve(o.root);
    const projectDir = o.projectDir ? path.resolve(o.projectDir) : path.dirname(root);
    const outDir = o.outDir || defaultOutDir(root);
    const engine = o.engine || 'pdflatex';
    const job = path.basename(root).replace(/\.tex$/i, '');
    const timeoutMs = o.timeoutMs ?? 180000;

    fs.mkdirSync(outDir, { recursive: true });
    mirrorSkeleton(projectDir, outDir);

    // COMPILING WHAT IS ON SCREEN, NOT WHAT IS ON DISK.
    //
    // Waiting for a save to see the typeset result breaks the loop this whole
    // feature exists for. But writing the editor's buffer back to the user's
    // .tex to compile it would be a lie about what they saved, so the dirty
    // buffers are written into a private overlay tree that comes FIRST on
    // TEXINPUTS. Clean files still resolve to the real project, so only what
    // is actually unsaved is shadowed.
    //
    // The tree is rebuilt from scratch each time: a file that was dirty and
    // has since been saved must stop shadowing the real one, and deleting the
    // directory is the only way to be sure of that without bookkeeping.
    const overlayDir = path.join(outDir, '_wblive');
    const overlay = o.overlay instanceof Map ? o.overlay : null;
    try { fs.rmSync(overlayDir, { recursive: true, force: true }); } catch (_) { /* fine */ }
    let overlayRoot = null;
    if (overlay && overlay.size) {
        for (const [abs, text] of overlay) {
            const rel = path.relative(projectDir, path.resolve(abs));
            if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
            const dst = path.join(overlayDir, rel);
            try {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.writeFileSync(dst, text, 'utf8');
                if (path.resolve(abs) === root) overlayRoot = dst;
            } catch (_) { /* a file we cannot shadow just compiles from disk */ }
        }
    }
    // The root is passed to latexmk by absolute path, so TEXINPUTS cannot
    // shadow it — it has to be named directly.
    const compileRoot = overlayRoot || root;

    const sep = process.platform === 'win32' ? ';' : ':';
    const env = {
        ...process.env,
        // `//` = search recursively; the trailing separator keeps the system
        // trees. TMPDIR is deliberately untouched (biber, 5.2x).
        TEXINPUTS: `${overlayDir}${path.sep}${path.sep}${sep}` +
            `${projectDir}${path.sep}${path.sep}${sep}${outDir}${sep}`,
        BIBINPUTS: `${overlayDir}${path.sep}${path.sep}${sep}${projectDir}${path.sep}${path.sep}${sep}`,
        BSTINPUTS: `${projectDir}${path.sep}${path.sep}${sep}`,
        TEXMFOUTPUT: outDir,
        max_print_line: '1000',   // stop TeX hard-wrapping paths mid-token
    };

    const args = [
        `-${engine}`,
        '-interaction=nonstopmode',
        '-file-line-error',
        '-synctex=1',
        '-f',                      // NOT -halt-on-error; see the header
        `-outdir=${outDir}`,
        ...(o.extraArgs || []),
        compileRoot,
    ];

    const logLines = [];
    const run = await spawnCollect('latexmk', args, {
        cwd: outDir,               // <- the overlay: cwd is NEVER the project
        env,
        signal: o.signal,
        timeoutMs,
        onLine: (l) => { logLines.push(l); if (o.onLog) o.onLog(l); },
    });

    const pdfPath = path.join(outDir, job + '.pdf');
    const synctexPath = path.join(outDir, job + '.synctex.gz');
    const logPath = path.join(outDir, job + '.log');

    let logText = '';
    try { logText = fs.readFileSync(logPath, 'utf8'); } catch (_) { logText = run.stdout; }
    const parsed = parseLog(logText, { file: root });

    let pdfHash = null; let pageCount = null; let pdfBytes = null;
    const hasPdf = fs.existsSync(pdfPath);
    if (hasPdf) {
        const buf = fs.readFileSync(pdfPath);
        pdfBytes = buf.length;
        pdfHash = pdfContentHash(buf);
        pageCount = parsed.pages ?? pdfPageCount(buf);
    }
    let synctexHash = null;
    if (fs.existsSync(synctexPath)) {
        // pdftex writes a zero gzip mtime, so the .gz is byte-stable whenever
        // its content is — a plain byte hash is honest here.
        synctexHash = sha256(fs.readFileSync(synctexPath));
    }

    const passes = (run.stdout.match(/Run number \d+/g) || []).length ||
        (run.stdout.match(/^Latexmk: applying rule/gm) || []).length || null;

    return {
        ok: hasPdf && !run.cancelled,
        runner: 'latexmk',
        engine,
        root,
        projectDir,
        outDir,
        pdfPath: hasPdf ? pdfPath : null,
        synctexPath: synctexHash ? synctexPath : null,
        logPath: fs.existsSync(logPath) ? logPath : null,
        generation: nextGeneration(),
        sourceSnapshotHash: snapshotSources(o.sourceFiles && o.sourceFiles.length ? o.sourceFiles : [root],
            overlay),
        projectDir,
        overlayDir: (overlay && overlay.size) ? overlayDir : null,
        live: !!(overlay && overlay.size),
        pdfHash,
        pdfBytes,
        synctexHash,
        pageCount,
        diagnostics: parsed.diagnostics,
        stopped: parsed.stopped,
        stopReason: parsed.stopReason,
        errors: parsed.errors,
        warnings: parsed.warnings,
        passes,
        ms: Date.now() - t0,
        exit: run.code,
        cancelled: run.cancelled,
        timedOut: run.timedOut,
        // pdflatex can be pushed into DVI mode by a 2009-era class; it exits 0,
        // logs nothing wrong, and produces no PDF. Naming it beats "ok: false".
        dviOnly: !hasPdf && parsed.outputFormat === 'dvi',
        finishedAt: Date.now(),
    };
}

/**
 * spawn + collect, with a PROCESS-GROUP kill. Killing the latexmk pid alone
 * leaves a pdflatex holding the output directory; Spike D measured the group
 * kill at 45-80 ms with zero orphans across 8 configurations.
 */
function spawnCollect(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(cmd, args, {
                cwd: opts.cwd, env: opts.env,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true,
            });
        } catch (e) { reject(e); return; }

        let stdout = ''; let stderr = ''; let pending = '';
        let cancelled = false; let timedOut = false; let settled = false;

        const killGroup = (sig) => {
            try { process.kill(-child.pid, sig); }
            catch (_) { try { child.kill(sig); } catch (_) { /* gone */ } }
        };
        const timer = opts.timeoutMs > 0 ? setTimeout(() => {
            timedOut = true; killGroup('SIGTERM');
            setTimeout(() => killGroup('SIGKILL'), 2000);
        }, opts.timeoutMs) : null;

        const onAbort = () => { cancelled = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 500); };
        if (opts.signal) {
            if (opts.signal.aborted) onAbort();
            else opts.signal.addEventListener('abort', onAbort, { once: true });
        }

        child.stdout.on('data', (d) => {
            stdout += d;
            if (opts.onLine) {
                pending += d;
                const ls = pending.split('\n');
                pending = ls.pop();
                ls.forEach(opts.onLine);
            }
        });
        child.stderr.on('data', (d) => { stderr += d; });

        child.on('error', (e) => {
            if (settled) return; settled = true;
            if (timer) clearTimeout(timer);
            if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
            reject(e);
        });
        child.on('close', (code) => {
            if (settled) return; settled = true;
            if (timer) clearTimeout(timer);
            if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
            if (opts.onLine && pending) opts.onLine(pending);
            resolve({ code, stdout, stderr, cancelled, timedOut });
        });
    });
}

/** Is a generation still describing the current source? */
/** Where a generation record is parked between sessions. */
function generationPath(outDir) { return path.join(outDir, 'wolfbook-generation.json'); }

/**
 * Remember a finished compile, so reopening the paper does not repeat it.
 *
 * The compile is the slow part of first load — minutes on a real paper — and
 * the out dir already holds the PDF and the .synctex.gz when VS Code restarts.
 * Only the in-memory record was being lost, so the work was redone for nothing.
 */
function saveGeneration(gen) {
    if (!gen || !gen.outDir || !gen.ok) return false;
    try {
        fs.writeFileSync(generationPath(gen.outDir), JSON.stringify(gen), 'utf8');
        return true;
    } catch (_) { return false; }
}

/**
 * The remembered compile, if it is still true of the sources on disk.
 *
 * Returns null unless the record parses, its snapshot still matches, and the
 * PDF and SyncTeX it names are both still there — a cache that hands back a
 * generation whose files have been swept is worse than no cache.
 */
function loadGeneration(root, { outDir, sourceFiles, overlay } = {}) {
    const dir = outDir || defaultOutDir(root);
    let gen;
    try { gen = JSON.parse(fs.readFileSync(generationPath(dir), 'utf8')); }
    catch (_) { return null; }
    if (!gen || !gen.ok || !gen.pdfPath) return null;
    try {
        if (!fs.existsSync(gen.pdfPath)) return null;
        if (gen.synctexPath && !fs.existsSync(gen.synctexPath)) return null;
    } catch (_) { return null; }
    const files = sourceFiles && sourceFiles.length ? sourceFiles : [root];
    if (!generationIsCurrent(gen, files, overlay)) return null;
    return { ...gen, restored: true };
}

function generationIsCurrent(gen, sourceFiles, overlay) {
    if (!gen || !gen.sourceSnapshotHash) return false;
    return gen.sourceSnapshotHash === snapshotSources(sourceFiles, overlay);
}

module.exports = {
    saveGeneration,
    loadGeneration,
    generationPath,
    compile,
    defaultOutDir,
    pdfContentHash,
    pdfPageCount,
    snapshotSources,
    generationIsCurrent,
    mirrorSkeleton,
};
