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
const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');

const { parseLog, needsRerun } = require('./texLog');
const { readPassLimit } = require('./livePolicy');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

let _generation = 0;
const nextGeneration = () => ++_generation;

/**
 * The latexmk initialisation code that caps a run to N engine passes.
 *
 * $max_repeat is latexmk's infinite-loop guard. At 1, pass one runs and a
 * request for a second trips it: latexmk warns on stderr, sets its failure
 * flag, and returns — leaving the pass-one PDF in place, which is exactly what
 * an editor wants while someone is typing.
 *
 * SAFE IF THE VARIABLE IS EVER RENAMED: latexmk evaluates -e as plain perl
 * with no strict-checking, so assigning to a name it does not know is a silent
 * no-op and the build is merely uncapped. Only a SYNTAX error is fatal, and
 * probeInitCode catches that in ~50 ms before any real build depends on it.
 */
const MAX_PASSES_CODE = (n) => `$max_repeat=${Number(n) || 1};`;

/**
 * ONE latexmk PER OUT DIR, EVER.
 *
 * renderUi aborts the in-flight compile before asking for the next one, and the
 * group kill is 45-80 ms (Spike D) — but abort() RETURNS IMMEDIATELY, and the
 * code then went straight on to delete the _wblive overlay and respawn into the
 * same directory while the dying pdflatex still held it. The .aux, the
 * .fdb_latexmk and the half-written .synctex.gz are all shared state.
 *
 * spawnCollect resolves on 'close', which is after every member of the process
 * group has dropped the pipe — so awaiting the previous run IS awaiting the
 * group's death, and no new API is needed for it.
 */
const _inFlight = new Map();   // outDir -> a promise that settles when its group is gone

/** Never let a stuck gate become a dead viewer: fall back to today's behaviour. */
const GATE_TIMEOUT_MS = 30000;

/** Which project each out dir's empty-directory skeleton was mirrored from. */
const _mirrored = new Map();   // outDir -> projectDir

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

/**
 * Page geometry from the PDF — and it is NOT in the plain bytes.
 *
 * MEASURED: pdfTeX writes PDF 1.5+, so the page tree lives inside a FlateDecode
 * /ObjStm and a byte scan for /MediaBox finds NOTHING AT ALL on an ordinary
 * article. The old reader scanned the first 200 KB, missed every time, and
 * silently returned the A4 default — which happens to be right for an A4 paper
 * and quietly wrong for a US-letter one, in a value the render map uses for
 * page occupancy and box sanity.
 *
 * So: try the plain scan (some producers do write it uncompressed), then
 * inflate the object streams. Z_SYNC_FLUSH is what lets one stream be decoded
 * out of the middle of a file without knowing its /Length, which is usually an
 * indirect reference — and the spike's rule is never to find the end by
 * searching for `endstream`, because binary stream data contains that too.
 */
function pdfGeometry(buf) {
    const readBox = (s) => {
        const m = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(s);
        if (!m) return null;
        const w = Number(m[3]) - Number(m[1]);
        const h = Number(m[4]) - Number(m[2]);
        return (w > 0 && h > 0) ? { widthBp: w, heightBp: h } : null;
    };
    const s = buf.toString('latin1');
    let pageSize = readBox(s);
    let leaves = (s.match(/\/Type\s*\/Page(?![s\/])/g) || []).length;
    if (pageSize && leaves) return { pageSize, pageCount: leaves };

    const re = /\/Type\s*\/ObjStm/g;
    let m;
    let guard = 0;
    while ((m = re.exec(s)) && guard++ < 200) {
        const st = s.indexOf('stream', m.index);
        if (st < 0) continue;
        let p = st + 6;
        if (s[p] === '\r') p++;
        if (s[p] === '\n') p++;
        let out;
        try {
            out = zlib.inflateSync(buf.subarray(p), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
                .toString('latin1');
        } catch (_) { continue; }
        if (!pageSize) pageSize = readBox(out);
        leaves += (out.match(/\/Type\s*\/Page(?![s\/])/g) || []).length;
    }
    return { pageSize, pageCount: leaves || null };
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

/**
 * Per-file content hashes, keyed on (size, mtime).
 *
 * snapshotSources runs on every build and reads every source file. Caching is
 * safe in ONE DIRECTION and that is the direction Dropbox errs in: it touches
 * mtimes without changing bytes, which causes a needless re-read (right answer,
 * wasted work). The dangerous case — different bytes with size AND mtime
 * preserved — requires a write that deliberately restores both.
 */
const _fileHash = new Map();   // path -> {size, mtimeMs, hash}

function hashFileCached(f) {
    let stat = null;
    try { stat = fs.statSync(f); } catch (_) { return '\0missing'; }
    const hit = _fileHash.get(f);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.hash;
    let hash;
    try { hash = sha256(fs.readFileSync(f)); } catch (_) { return '\0missing'; }
    _fileHash.set(f, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
    return hash;
}

function snapshotSources(files, overlay) {
    const h = crypto.createHash('sha256');
    // The digest SHAPE changed when per-file hashing arrived, so say so: every
    // persisted generation record becomes non-current once, pays one compile,
    // and is warm again. Silently changing it would look like a corrupt cache.
    h.update('wb-snapshot-v2\0');
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
        if (dirty !== undefined) { h.update(sha256(Buffer.from(dirty, 'utf8'))); continue; }
        h.update(hashFileCached(f));
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
    const queuedAt = Date.now();
    const root = path.resolve(o.root);
    const projectDir = o.projectDir ? path.resolve(o.projectDir) : path.dirname(root);
    const outDir = o.outDir || defaultOutDir(root);
    const engine = o.engine || 'pdflatex';
    const job = path.basename(root).replace(/\.tex$/i, '');
    const timeoutMs = o.timeoutMs ?? 180000;
    const maxPasses = o.maxPasses || null;

    // Wait for any previous run in this out dir to be REALLY gone (see
    // _inFlight). A stuck gate must not become a dead viewer, so the wait is
    // bounded; past it we proceed exactly as the code used to.
    const prior = _inFlight.get(outDir);
    if (prior) {
        let timer = null;
        try {
            await Promise.race([
                prior,
                new Promise((r) => { timer = setTimeout(r, GATE_TIMEOUT_MS); }),
            ]);
        } catch (_) { /* the previous run's failure is its own */ }
        finally { if (timer) clearTimeout(timer); }
    }
    if (o.signal && o.signal.aborted) {
        return cancelledRecord({ root, projectDir, outDir, engine, queuedAt });
    }
    let release;
    const gate = new Promise((r) => { release = r; });
    _inFlight.set(outDir, gate);
    // Queue time is not compile time: the debounce is tuned from `ms`.
    const t0 = Date.now();
    try {
        return await _compileLocked(o, {
            root, projectDir, outDir, engine, job, timeoutMs, maxPasses, t0, queuedAt,
        });
    } finally {
        if (_inFlight.get(outDir) === gate) _inFlight.delete(outDir);
        release();
    }
}

/** A compile that never ran, in the shape of one that did. Never throws. */
function cancelledRecord({ root, projectDir, outDir, engine, queuedAt }) {
    return {
        ok: false, runner: 'latexmk', engine, root, projectDir, outDir,
        pdfPath: null, synctexPath: null, logPath: null,
        generation: nextGeneration(),
        sourceSnapshotHash: null, overlayDir: null, live: false,
        pdfHash: null, pdfBytes: null, synctexHash: null, glyphMapPath: null, glyphMapMetaPath: null, glyphMapHash: null, pageCount: null, pageSize: null,
        diagnostics: [], stopped: false, stopReason: null, errors: 0, warnings: 0,
        passes: null, maxPasses: null, passesLimited: false, rcUnsupported: false,
        ms: 0, queuedMs: Date.now() - queuedAt,
        exit: null, cancelled: true, timedOut: false, dviOnly: false,
        finishedAt: Date.now(),
    };
}

async function _compileLocked(o, ctx) {
    const { root, projectDir, outDir, engine, job, timeoutMs, maxPasses, t0, queuedAt } = ctx;

    fs.mkdirSync(outDir, { recursive: true });
    // The skeleton is only walked when it might have changed. A directory the
    // project GAINS mid-session is picked up by the next save or explicit
    // Compile (both mirror unconditionally), and if one slips through, pdftex
    // says "I can't write on file" and the arm below re-mirrors for next time.
    if (o.mirror === 'auto' && _mirrored.get(outDir) === projectDir) {
        /* already mirrored this session */
    } else {
        mirrorSkeleton(projectDir, outDir);
        _mirrored.set(outDir, projectDir);
    }

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
    // THE ENGINE EMITS THE MAP. With lualatex and the wbmap hook, every glyph
    // shipped is recorded with its exact box and source line into the out dir
    // (the hook writes by RELATIVE name: the engine's cwd is the out dir, and
    // `openout_any=p` allows nothing further away). See tex/glyphMap.js.
    const glyphMap = !!o.glyphMap && engine === 'lualatex';
    const glyphMapName = `${job}.glyphmap.jsonl`;
    const glyphMapMetaName = `${job}.glyphmap.meta.json`;
    if (glyphMap) {
        env.WB_GLYPHMAP_OUT = glyphMapName;
        env.WB_GLYPHMAP_META = glyphMapMetaName;
        // The previous map is KEPT: latexmk may decide nothing changed and not
        // run the engine at all, and then the PDF is the old one and so is its
        // map. Staleness is judged after the run instead (see below) — a map
        // older than a PDF that WAS rewritten is treated as absent.
    }
    const runStartedAt = Date.now();
    // latexmk skips the engine when the sources are up to date — right for the
    // PDF, wrong when the MAP is missing or older than that PDF (an earlier
    // build without the hook, or a deleted out file): then the engine must run
    // once more, so `-g` forces it.
    //
    // THE OTHER REASON TO FORCE IT, and the one that made a new \label print
    // `??` for ever: after a CAPPED build the sources have not changed, so the
    // follow-up build that exists to converge the cross-references is told
    // "Nothing to do — all targets are up-to-date" and does nothing at all.
    // Measured on a two-line paper: capped run leaves the unresolved
    // reference, the uncapped run that follows it is a no-op, and the page
    // stays wrong until the reader happens to type something. A caller that
    // knows it is correcting an unconverged build passes `force`.
    let forceRun = !!o.force;
    if (glyphMap && !forceRun) {
        try {
            const mapP = path.join(outDir, glyphMapName);
            const pdfP = path.join(outDir, job + '.pdf');
            if (!fs.existsSync(mapP)) forceRun = fs.existsSync(pdfP);
            else if (fs.existsSync(pdfP) && fs.statSync(mapP).mtimeMs < fs.statSync(pdfP).mtimeMs - 1500) forceRun = true;
        } catch (_) { forceRun = false; }
    }

    // SYNCTEX STAYS ON, EVEN THOUGH THE GLYPH MAP HAS REPLACED IT.
    //
    // Dropping it from live builds was tried and MEASURED: 1399 ms against
    // 1416 ms on the real paper, five runs each — 1.2%, which does not buy the
    // loss of the fallback a build whose Lua hook fails would need.
    const args = [
        `-${engine}`,
        '-interaction=nonstopmode',
        '-file-line-error',
        '-synctex=1',
        '-f',                      // NOT -halt-on-error; see the header
        `-outdir=${outDir}`,
        // Capped only when a caller asked; extraArgs still comes after, so a
        // caller can override anything we set here.
        ...(maxPasses ? ['-e', MAX_PASSES_CODE(maxPasses)] : []),
        // `[[ ]]` and forward slashes: latexmk strips double quotes on the way
        // to the engine, and a backslash is a TeX escape. `--lua=` cannot be
        // used instead — luatexbase does not exist yet when it runs.
        ...(glyphMap ? ['-usepretex', `-pretex=\\directlua{dofile([[${glyphMapHookPath().replace(/\\/g, '/')}]])}`] : []),
        ...(forceRun ? ['-g'] : []),
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

    let pdfHash = null; let pageCount = null; let pdfBytes = null; let pageSize = null;
    const hasPdf = fs.existsSync(pdfPath);
    if (hasPdf) {
        const buf = fs.readFileSync(pdfPath);
        pdfBytes = buf.length;
        pdfHash = pdfContentHash(buf);
        // Geometry, read while the buffer is already in hand — renderUi used to
        // re-read the whole PDF from disk for this, and got nothing back.
        const geo = pdfGeometry(buf);
        pageSize = geo.pageSize;
        pageCount = parsed.pages ?? geo.pageCount ?? pdfPageCount(buf);
    }
    // A directory the project gained since we last mirrored: re-arm the walk.
    if (/I can't write on file/.test(logText)) _mirrored.delete(outDir);
    // The GlyphMap the hook wrote, if it ran. Hashed like the synctex so a
    // rebuild with identical output can reuse the parsed map.
    const glyphMapPath = glyphMap ? path.join(outDir, glyphMapName) : null;
    const glyphMapMetaPath = glyphMap ? path.join(outDir, glyphMapMetaName) : null;
    let glyphMapHash = null;
    if (glyphMapPath && fs.existsSync(glyphMapPath)) {
        // Valid when written by THIS run, or when the PDF was not rewritten
        // either (latexmk had nothing to do — the old pair still agree).
        let fresh = true;
        try {
            const mapM = fs.statSync(glyphMapPath).mtimeMs;
            const pdfM = hasPdf ? fs.statSync(pdfPath).mtimeMs : 0;
            const pdfRewritten = pdfM >= runStartedAt - 1500;
            fresh = mapM >= runStartedAt - 1500 || !pdfRewritten;
        } catch (_) { fresh = false; }
        if (fresh) {
            try { glyphMapHash = sha256(fs.readFileSync(glyphMapPath)); } catch (_) { glyphMapHash = null; }
        }
    }
    let synctexHash = null;
    // A .synctex.gz OLDER THAN THIS RUN BELONGS TO AN EARLIER ONE.
    //
    // The engine writes it at the end; if this run died, or was killed, or
    // never reached the shipout, the file sitting in the out dir is the
    // PREVIOUS build's — and reporting it as this generation's hands the
    // reader a map of the paper as it used to be. The glyph map already had
    // this rule (see above); SyncTeX was trusted on existence alone.
    let synctexFresh = false;
    try {
        synctexFresh = fs.existsSync(synctexPath) &&
            fs.statSync(synctexPath).mtimeMs >= runStartedAt - 1500;
    } catch (_) { synctexFresh = false; }
    if (synctexFresh) {
        // pdftex writes a zero gzip mtime, so the .gz is byte-stable whenever
        // its content is — a plain byte hash is honest here.
        synctexHash = sha256(fs.readFileSync(synctexPath));
    }

    const passes = (run.stdout.match(/Run number \d+/g) || []).length ||
        (run.stdout.match(/^Latexmk: applying rule/gm) || []).length || null;

    // Did the cap actually bite? When one pass was enough — the common case
    // while typing inside a paragraph — passesLimited is false and this
    // generation is fully authoritative, so nothing needs correcting later.
    const { passesLimited, rcUnsupported } = readPassLimit({
        stdout: run.stdout, stderr: run.stderr, maxPasses,
    });

    // DID LATEX ITSELF ASK FOR ANOTHER PASS? A capped build is one way to be
    // one pass behind; the other is a build that ran to completion and still
    // wrote a .aux nobody has read yet — a brand new \label, which prints as
    // `??` until the next run. Reported exactly that way. Without this the
    // only trigger for the background convergence was latexmk's own cap
    // message, so a new label could sit unresolved for as long as the paper
    // stayed open.
    const rerunWanted = needsRerun(logText);

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
        // The caller may have computed this already — it reads and hashes every
        // source file, and renderUi needs the same answer a moment earlier to
        // decide whether to compile at all.
        sourceSnapshotHash: o.sourceSnapshotHash ??
            snapshotSources(o.sourceFiles && o.sourceFiles.length ? o.sourceFiles : [root], overlay),
        projectDir,
        overlayDir: (overlay && overlay.size) ? overlayDir : null,
        live: !!(overlay && overlay.size),
        pdfHash,
        pdfBytes,
        synctexHash,
        glyphMapPath: glyphMapHash ? glyphMapPath : null,
        glyphMapMetaPath: glyphMapHash ? glyphMapMetaPath : null,
        glyphMapHash,
        pageCount,
        pageSize,
        diagnostics: parsed.diagnostics,
        stopped: parsed.stopped,
        stopReason: parsed.stopReason,
        errors: parsed.errors,
        warnings: parsed.warnings,
        passes,
        maxPasses,
        passesLimited,
        rerunWanted,
        rcUnsupported,
        ms: Date.now() - t0,
        queuedMs: t0 - queuedAt,
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
/**
 * Will this latexmk accept our initialisation code?
 *
 * -e is executed while the command line is parsed, BEFORE --version prints, so
 * one ~50 ms run answers it for the session — and a live compile never has to
 * discover the answer by producing no PDF. Resolves false on any failure,
 * including latexmk being absent: the caller then simply never caps.
 */
function probeInitCode(code, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve) => {
        let out = '';
        let child;
        try {
            child = spawn('latexmk', ['-e', code, '--version'], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (_) { resolve(false); return; }
        const done = (v) => { if (timer) clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} done(false); }, timeoutMs);
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('error', () => done(false));
        child.on('close', (code2) => {
            done(code2 === 0 && !/Stopping because executing following code/.test(out));
        });
    });
}

function saveGeneration(gen) {
    if (!gen || !gen.outDir || !gen.ok) return false;
    // A CAPPED OR UNCONVERGED BUILD IS NOT A BASELINE. Its ink is current but
    // its cross-references may be one pass behind, and a record restored on the
    // next window open would present that as a finished compile — with the
    // background convergence never scheduled, because the record says there is
    // nothing to converge.
    if (gen.passesLimited || gen.rerunWanted) return false;
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

/**
 * Where the GlyphMap hook lives: resources/tex/wbmap.lua, resolved from this
 * file so it is right both in the repo and inside the installed extension.
 */
function glyphMapHookPath() {
    return path.resolve(__dirname, '..', '..', '..', 'resources', 'tex', 'wbmap.lua');
}

/**
 * Is lualatex on PATH? Asked once per process; the answer is cached. Never
 * throws — "no" is a perfectly good answer.
 */
let _luaOk = null;
function probeLualatex() {
    if (_luaOk !== null) return Promise.resolve(_luaOk);
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn('lualatex', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (_) { _luaOk = false; return resolve(false); }
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', () => { _luaOk = false; resolve(false); });
        child.on('close', (code) => { _luaOk = code === 0 && /LuaTeX|LuaHBTeX/i.test(out); resolve(_luaOk); });
        setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } }, 8000);
    });
}

module.exports = {
    glyphMapHookPath, probeLualatex,
    saveGeneration,
    loadGeneration,
    generationPath,
    compile,
    defaultOutDir,
    pdfContentHash,
    pdfPageCount,
    pdfGeometry,
    snapshotSources,
    generationIsCurrent,
    mirrorSkeleton,
    probeInitCode,
    MAX_PASSES_CODE,
};
