#!/usr/bin/env node
'use strict';
// Direct and inverse search on real papers, through WPaper's own WLaTeX path:
// NativeBuildLane (cold build, publish, page views), NativeMap (what the
// viewer asks on a click, `renderToSource`, and on a cursor move,
// `forwardAt`), and the live map of pages the incremental engine drew.
// Ground truth is Poppler's words (`pdftotext -bbox`) of the PDF the page
// shows.
//
//   node verifyNativeSearch.cjs WLATEX_CHECKOUT PAPER_DIR MAIN [--sample N] [--json FILE]
//   node verifyNativeSearch.cjs WLATEX_CHECKOUT --corpus CORPUS_DIR [--only ID,...] [--json FILE]
//
// Three states, as a writer meets them:
//   settled  the cold build's map;
//   edited   a line inserted above (unsaved): the map re-read from the
//            worker, which translates every position through the edit;
//   live     a word typed into a paragraph: the pages the incremental
//            engine redrew, with their own maps; ground truth is a cold
//            build of the edited text (live pages equal cold ones).
//
// A word counts only when it is prose (three or more ASCII letters, after
// ligatures and a line-end hyphen are undone) that occurs in the project's
// sources; others (numbers, labels, generated text, math) are counted apart.
//   inverse: the word's centre -> (file, line, column); right when that line
//            holds the word within a word's length of the column; "line"
//            when it holds it elsewhere; "near" within two lines.
//   direct:  a source word's middle -> rectangles; right when one of them
//            covers a Poppler word of the same text on its page.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); if (i < 0) return fallback; const v = args[i + 1]; args.splice(i, 2); return v; };
const SAMPLE = Number(flag('--sample', 200));
const JSON_OUT = flag('--json');
const CORPUS = flag('--corpus');
const ONLY = flag('--only')?.split(',');
const CHECKOUT = path.resolve(args[0] || '');
const { NativeBuildLane } = require('./nativeCompileService');
const { NativeMap } = require('./nativeMap');
const { FLAG } = require('./renderMap');

const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', '’': "'" };
/** Poppler's word as prose: { word, fragment } or null. */
function prose(text) {
    let t = text.replace(/[ﬀ-ﬄ’]/g, c => LIGATURES[c]);
    const fragment = /[A-Za-z]-$/.test(t);
    t = t.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    return /^[A-Za-z]{3,}$/.test(t) ? { word: t.toLowerCase(), fragment } : null;
}

const tokens = text => text.replace(/[\ufb00-\ufb04\u2019]/g, c => LIGATURES[c]).toLowerCase().match(/[a-z]+/g) || [];

function popplerWords(pdf) {
    const xml = execFileSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const pages = [];
    let page = null;
    for (const line of xml.split('\n')) {
        if (line.includes('<page ')) pages.push(page = []);
        const m = /<word xMin="([^"]+)" yMin="([^"]+)" xMax="([^"]+)" yMax="([^"]+)">(.*)<\/word>/.exec(line);
        if (m && page) page.push({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4],
            text: m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") });
    }
    return pages;
}

/** Project sources: absolute path -> lines, and every prose word in them. */
function readSources(dir) {
    // `typed`: words of the .tex files, what the writer typed; `vocabulary`
    // adds generated sources (.bbl) and packages.
    const files = new Map(), vocabulary = new Set(), typed = new Set();
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith('.')) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(tex|sty|cls|bbl|ltx)$/i.test(e.name)) {
                let text; try { text = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
                files.set(p, text.split('\n'));
                for (const w of text.toLowerCase().match(/[a-z]{3,}/g) || []) {
                    vocabulary.add(w);
                    if (/\.tex$/i.test(e.name)) typed.add(w);
                }
            }
        }
    };
    walk(dir);
    return { files, vocabulary, typed };
}

const quantile = (values, q) => { const v = [...values].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : null; };
function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }
function sample(list, n, random) {
    if (list.length <= n) return list;
    const out = list.slice(), pick = [];
    for (let i = 0; i < n; i++) pick.push(out.splice(Math.floor(random() * out.length), 1)[0]);
    return pick;
}

/** Inverse search for every prose word of `pages` (Poppler words by page). */
function inverse(map, pages, pageNumbers, sources, textOf, generatedTextOf = () => null) {
    // `words`, `right` … `unmapped`: prose the writer typed (in a .tex file).
    // `generated`: prose TeX wrote from elsewhere (citation labels, contents
    // entries), `generatedMapped` of it answered with some source.
    // `figure`: words Poppler finds with no TeX glyph under them (text inside
    // an included PDF figure).
    const out = { words: 0, right: 0, line: 0, near: 0, wrong: 0, unmapped: 0, unmatchable: 0,
        generated: 0, generatedMapped: 0, figure: 0, ms: [], examples: [] };
    const known = (set, p) => set.has(p.word) || (p.fragment && [...set].some(v => v.startsWith(p.word)));
    for (const n of pageNumbers) {
        const entries = map._pages.get(n) || [];
        for (const w of pages[n - 1] || []) {
            const p = prose(w.text);
            if (!p) continue;
            if (!known(sources.vocabulary, p)) { out.unmatchable++; continue; }
            const x = (w.x0 + w.x1) / 2, y = (w.y0 + w.y1) / 2;
            if (!entries.some(e => e.x <= w.x1 && e.x + e.w >= w.x0 && e.y <= w.y1 && e.y + e.boxHeight >= w.y0)) { out.figure++; continue; }
            if (!known(sources.typed, p)) {
                out.generated++;
                const r = map.renderToSource(n, x, y);
                if (r && r.flag !== FLAG.UNMAPPED && r.file) out.generatedMapped++;
                continue;
            }
            out.words++;
            const t0 = performance.now();
            const r = map.renderToSource(n, x, y);
            out.ms.push(performance.now() - t0);
            if (!r || r.flag === FLAG.UNMAPPED || !r.file) {
                out.unmapped++;
                // Why: the glyphs under the word carry no project source (a
                // .bbl entry, a contents line), or they do and the click at the
                // word's centre misses their boxes (geometry off, as in a
                // scaled box).
                const sourced = entries.some(e => e.file && e.x <= w.x1 && e.x + e.w >= w.x0 && e.y <= w.y1 && e.y + e.boxHeight >= w.y0);
                if (sourced) out.missed = (out.missed || 0) + 1; else out.unsourced = (out.unsourced || 0) + 1;
                if (out.examples.length < 12) out.examples.push({ kind: sourced ? 'missed' : 'unsourced', page: n, word: w.text });
                continue;
            }
            if (r.generated) {
                // Followed from the .bbl or .toc to the .bib record or the
                // heading. A style prints what the record does not hold ("and",
                // abbreviations), so the question is whether the click was on
                // this entry: right when the word is in the record (up to the
                // next @) or heading line, or in the generated entry it came
                // from (the .bbl block from its \bibitem, or the .toc line).
                out.followed = (out.followed || 0) + 1;
                const lines = textOf(r.file) || (fs.existsSync(r.file) ? fs.readFileSync(r.file, 'utf8').split('\n') : []);
                let block = lines[r.line - 1] || '';
                if (/\.bib$/i.test(r.file)) for (let i = r.line; i < lines.length && !/^\s*@/.test(lines[i]); i++) block += '\n' + lines[i];
                const generatedLines = generatedTextOf(r.generated.file) || [];
                const entry = /\.bbl$/i.test(r.generated.file) ? (() => {
                    const item = l => /\\bibitem|\\bib\s*\{/.test(l);
                    let a = r.generated.line - 1, b = r.generated.line;
                    while (a > 0 && !item(generatedLines[a])) a--;
                    while (b < generatedLines.length && !item(generatedLines[b])) b++;
                    return generatedLines.slice(a, b).join('\n');
                })() : (generatedLines[r.generated.line - 1] || '');
                if (block.toLowerCase().includes(p.word) || entry.toLowerCase().includes(p.word)) { out.right++; out.followedRight = (out.followedRight || 0) + 1; }
                else { out.wrong++; if (out.examples.length < 12) out.examples.push({ kind: 'followed-wrong', page: n, word: w.text, file: path.basename(r.file), line: r.line }); }
                continue;
            }
            const lines = textOf(r.file);
            const at = k => (lines?.[r.line - 1 + k] || '').toLowerCase();
            const own = at(0), window = own.slice(Math.max(0, r.column - p.word.length - 2), r.column + p.word.length + 2);
            if (window.includes(p.word)) out.right++;
            else if (own.includes(p.word)) out.line++;
            else if ([-2, -1, 1, 2].some(k => at(k).includes(p.word))) out.near++;
            else {
                out.wrong++;
                // How far off: lines from where it landed to the nearest line of
                // that file holding the word (Infinity: not in that file).
                let distance = Infinity;
                (lines || []).forEach((l, i) => { if (l.toLowerCase().includes(p.word)) distance = Math.min(distance, Math.abs(i - (r.line - 1))); });
                (out.missLines ||= []).push(distance);
                if (out.examples.length < 12) out.examples.push({ kind: 'wrong', page: n, word: w.text, file: path.basename(r.file), line: r.line, column: r.column, off: distance, source: (lines?.[r.line - 1] || '').slice(0, 100) });
            }
        }
    }
    return out;
}

// Commands whose braced argument does not print as written.
const SILENT = /\\(?:label|bibitem|ref|eqref|cref|Cref|autoref|pageref|nameref|cite[a-zA-Z]*|input|include|includegraphics|usepackage|RequirePackage|documentclass|begin|end|bibliography|bibliographystyle|newcommand|renewcommand|DeclareMathOperator|def|let|url|href|hypersetup|setlength|addtolength|vspace|hspace|color|textcolor|definecolor|newtheorem|theoremstyle|pgfplotsset|tikzset|graphicspath)\*?\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g;

/** Source positions of prose words in `file`'s body: [{ line, column, word }]. */
function sourceWords(lines) {
    const begin = lines.findIndex(l => l.includes('\\begin{document}'));
    const out = [];
    let math = 0;
    for (let i = Math.max(0, begin + 1); i < lines.length; i++) {
        const raw = lines[i];
        if (/\\begin\{(equation|align|gather|multline|eqnarray|tikzpicture|verbatim|lstlisting|minted|tabular|table|figure|algorithm|algorithmic)/.test(raw)) math++;
        if (/\\end\{(equation|align|gather|multline|eqnarray|tikzpicture|verbatim|lstlisting|minted|tabular|table|figure|algorithm|algorithmic)/.test(raw)) { math = Math.max(0, math - 1); continue; }
        if (math || raw.includes('\\end{document}')) continue;
        // Blank what does not print: comments, silent arguments, inline math.
        let line = raw.replace(/(^|[^\\])%.*$/, '$1');
        // Also optional arguments (options, tikz-cd arrows) and \input file names.
        line = line.replace(SILENT, m => ' '.repeat(m.length)).replace(/\$[^$]*\$|\\\([^)]*\\\)/g, m => ' '.repeat(m.length))
            .replace(/\\[a-zA-Z]+\*?\s*\[[^\]]*\]/g, m => ' '.repeat(m.length)).replace(/\\(?:input|include)\s+\S+/g, m => ' '.repeat(m.length))
            .replace(/\\[a-zA-Z]+\*?/g, m => ' '.repeat(m.length));
        for (const m of line.matchAll(/[A-Za-z]{4,}/g)) out.push({ line: i + 1, column: m.index + Math.floor(m[0].length / 2), word: m[0].toLowerCase() });
    }
    return out;
}

/** Direct search from sampled source words of `file`. */
async function direct(map, file, lines, pages, random, { pageFilter = null } = {}) {
    const out = { words: 0, right: 0, empty: 0, wrong: 0, ms: [], examples: [] };
    for (const s of sample(sourceWords(lines), SAMPLE, random)) {
        const t0 = performance.now();
        let rects;
        try { rects = await map.forwardAt(file, s.line, s.column); } catch (error) { rects = null; }
        out.ms.push(performance.now() - t0);
        if (rects === null) { out.empty++; continue; }
        if (pageFilter) rects = rects.filter(r => pageFilter(r.page));
        if (pageFilter && !rects.length) continue; // not on a page this map describes
        out.words++;
        if (!rects.length) { out.empty++; if (out.examples.length < 12) out.examples.push({ kind: 'empty', line: s.line, word: s.word, source: lines[s.line - 1].slice(0, 100) }); continue; }
        // The page word may be a compound ("black-hole"), a possessive or
        // hyphenated at the line end: any of its letter runs will do.
        // Poppler splits slanted text into fragments ("nte" of "slanted").
        const same = w => tokens(w.text).some(t => t.length >= 2 && (t.startsWith(s.word) || s.word.startsWith(t) || (t.length >= 3 && s.word.includes(t))));
        const hit = rects.some(r => {
            const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
            return (pages[r.page - 1] || []).some(w => cx >= w.x0 - 1 && cx <= w.x1 + 1 && cy >= w.y0 - 1 && cy <= w.y1 + 1 && same(w));
        });
        if (hit) out.right++;
        else {
            out.wrong++;
            // How far off: points from the highlight to the nearest page word
            // of the same text on its page (Infinity: none there).
            let distance = Infinity;
            for (const r of rects) for (const w of pages[r.page - 1] || []) if (same(w)) {
                const dx = Math.max(0, w.x0 - (r.x + r.w), r.x - w.x1), dy = Math.max(0, w.y0 - (r.y + r.h), r.y - w.y1);
                distance = Math.min(distance, Math.hypot(dx, dy));
            }
            (out.missPoints ||= []).push(distance);
            if (out.examples.length < 12) {
                const r = rects[0], cx = r.x + r.w / 2, cy = r.y + r.h / 2;
                const under = (pages[r.page - 1] || []).find(w => cx >= w.x0 - 1 && cx <= w.x1 + 1 && cy >= w.y0 - 1 && cy <= w.y1 + 1);
                out.examples.push({ kind: 'wrong', line: s.line, word: s.word, page: r.page, under: under?.text || null });
            }
        }
    }
    return out;
}

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '-';
/** Misses by distance: `limits` ascending, then beyond, then nowhere near (Infinity). */
function buckets(values = [], limits) {
    const out = limits.map(() => 0); let beyond = 0, nowhere = 0;
    for (const v of values) { const i = limits.findIndex(l => v <= l); if (i >= 0) out[i]++; else if (Number.isFinite(v)) beyond++; else nowhere++; }
    return { out, beyond, nowhere };
}
const LINE_LIMITS = [2, 10, 50], POINT_LIMITS = [20, 100];
const describeLines = v => { const b = buckets(v, LINE_LIMITS); return `≤2 lines ${b.out[0]}, ≤10 ${b.out[1]}, ≤50 ${b.out[2]}, farther ${b.beyond}, word not in that file ${b.nowhere}`; };
const describePoints = v => { const b = buckets(v, POINT_LIMITS); return `≤20 pt ${b.out[0]}, ≤100 pt ${b.out[1]}, farther ${b.beyond}, word not on that page ${b.nowhere}`; };
function summarize(name, inv, dir) {
    const parts = [];
    if (inv) parts.push(`inverse ${inv.right}/${inv.words} right (${pct(inv.right, inv.words)}), line ${inv.line}, near ${inv.near}, wrong ${inv.wrong}, unmapped ${inv.unmapped} (no source ${inv.unsourced || 0}, click misses glyph ${inv.missed || 0}), followed to .bib/heading ${inv.followedRight || 0}/${inv.followed || 0}; ` +
        `generated ${inv.generatedMapped}/${inv.generated} mapped, figure text ${inv.figure}; p50 ${quantile(inv.ms, 0.5)?.toFixed(3)} ms`);
    if (inv && inv.missLines?.length) parts.push(`wrong clicks land ${describeLines(inv.missLines)}`);
    if (dir && dir.missPoints?.length) parts.push(`wrong highlights ${describePoints(dir.missPoints)}`);
    if (dir) parts.push(`direct ${dir.right}/${dir.words} right (${pct(dir.right, dir.words)}), empty ${dir.empty}, wrong ${dir.wrong}; p50 ${quantile(dir.ms, 0.5)?.toFixed(3)} ms p90 ${quantile(dir.ms, 0.9)?.toFixed(3)} ms`);
    console.log(`  ${name}: ${parts.join(' | ')}`);
}
const strip = r => r && ({ ...r, ms: undefined, p50_ms: quantile(r.ms, 0.5), p90_ms: quantile(r.ms, 0.9),
    missLines: undefined, missPoints: undefined,
    miss_lines: r.missLines && buckets(r.missLines, LINE_LIMITS), miss_points: r.missPoints && buckets(r.missPoints, POINT_LIMITS) });

async function paper(source, main) {
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-search-'));
    const project = path.join(run, 'project');
    fs.cpSync(source, project, { recursive: true });
    const root = path.join(project, main);
    const sources = readSources(project);
    const original = fs.readFileSync(root, 'utf8');
    const random = rng(7);
    const result = {};
    const lane = new NativeBuildLane(root, CHECKOUT);
    try {
        // SETTLED: the cold build's map, every page.
        const t0 = performance.now();
        const gen = await lane.compile({ sourceFiles: [...sources.files.keys()].filter(f => f.endsWith('.tex')), timeoutMs: 600000 });
        if (!gen.ok) throw Error(`native build failed: ${gen.stopReason}`);
        result.build_ms = Math.round(performance.now() - t0);
        const all = Array.from({ length: gen.pageCount }, (_, i) => i + 1);
        const pdfPages = popplerWords(gen.pdfPath);
        const view = await lane.refresh(all);
        const settled = new NativeMap({ nativeView: view, nativeSource: lane.source, generation: { pdfHash: gen.pdfHash, projectDir: project, outDir: gen.outDir } });
        const textOf = file => sources.files.get(file) || (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : null);
        const generatedTextOf = file => { try { return fs.readFileSync(path.join(gen.outDir, file), 'utf8').split('\n'); } catch (_) { return null; } };
        const inv = inverse(settled, pdfPages, all, sources, textOf, generatedTextOf);
        const dir = await direct(settled, root, original.split('\n'), pdfPages, random);
        summarize(`settled (${gen.pageCount} pages)`, inv, dir);
        result.settled = { pages: gen.pageCount, inverse: strip(inv), direct: strip(dir) };

        // EDITED: an unsaved line above a third of the body; positions translate.
        const lines = original.split('\n');
        const body = sourceWords(lines);
        const at = body.length ? body[Math.floor(body.length / 3)].line : lines.length;
        const insertion = lines.slice(0, at - 1).join('\n').length + (at > 1 ? 1 : 0);
        const edited = original.slice(0, insertion) + '% an unsaved note\n' + original.slice(insertion);
        const doc = text => ({ uri: { fsPath: root }, getText: () => text });
        await lane.noteChange(doc(edited), [{ rangeOffset: insertion, rangeLength: 0, text: '% an unsaved note\n' }]);
        const editedLines = edited.split('\n');
        const editedText = file => file === root ? editedLines : textOf(file);
        const view2 = await lane.refresh(all);
        const moved = new NativeMap({ nativeView: view2, nativeSource: lane.source, generation: { pdfHash: gen.pdfHash, projectDir: project, outDir: gen.outDir } });
        const inv2 = inverse(moved, pdfPages, all, sources, editedText, generatedTextOf);
        const dir2 = await direct(moved, root, editedLines, pdfPages, random);
        summarize('edited (unsaved line above)', inv2, dir2);
        result.edited = { inverse: strip(inv2), direct: strip(dir2) };

        // LIVE: a word typed into a paragraph after the insertion.
        const target = body.find(b => b.line >= at && editedLines[b.line]?.length > 40) || body.at(-1);
        if (target && lane.interactive) {
            const line = target.line + 1; // shifted by the inserted note
            const lineText = editedLines[line - 1];
            const space = lineText.indexOf(' ', Math.floor(lineText.length / 2));
            const offset = editedLines.slice(0, line - 1).join('\n').length + 1 + (space < 0 ? lineText.length : space);
            const typed = edited.slice(0, offset) + ' lorem' + edited.slice(offset);
            await lane.noteChange(doc(typed), [{ rangeOffset: offset, rangeLength: 0, text: ' lorem' }]);
            const t1 = performance.now();
            const built = await lane.interactiveBuild({ wait: true, overlay: new Map([[root, typed]]), nativePages: all });
            result.live_build_ms = Math.round(performance.now() - t1);
            if (built?.ok) {
                const drawn = (built.pages || []).map(p => p.page ?? p).filter(Number.isInteger);
                const liveView = await lane.liveView(drawn.length ? drawn : all);
                if (liveView) {
                    const live = new NativeMap({ nativeView: liveView, nativeSource: lane.source, projectDir: project,
                        generation: { outDir: lane.coldReport?.artifact_directory || null } });
                    const livePages = live.materializedPages;
                    // Ground truth: a cold build of the typed text (live pages equal cold ones).
                    const truth = path.join(run, 'truth');
                    fs.cpSync(project, truth, { recursive: true });
                    fs.writeFileSync(path.join(truth, main), typed);
                    const out = path.join(run, 'truth-out');
                    execFileSync(lane.runtime.nativeBinary, ['--cold-build', truth, out, '--main', main], { stdio: 'ignore', timeout: 600000 });
                    const truthPages = popplerWords(path.join(out, path.basename(main, '.tex') + '.pdf'));
                    const typedLines = typed.split('\n');
                    const typedText = file => file === root ? typedLines : textOf(file);
                    const inv3 = inverse(live, truthPages, livePages, sources, typedText, generatedTextOf);
                    const dir3 = await direct(live, root, typedLines, truthPages, random, { pageFilter: page => live.hasPage(page) });
                    summarize(`live (${livePages.length} pages with maps)`, inv3, dir3);
                    result.live = { pages: livePages, inverse: strip(inv3), direct: strip(dir3) };
                } else { console.log('  live: no live map was published'); result.live = { error: 'no live map' }; }
            } else { console.log(`  live: ${built ? built.error || 'failed' : 'no interactive build'}`); result.live = { error: built?.error || 'no build' }; }
        } else result.live = { error: lane.interactive ? 'no prose line to type into' : lane.interactiveUnavailable };
    } finally {
        lane.close();
        fs.rmSync(run, { recursive: true, force: true });
    }
    return result;
}

async function main() {
    if (!args[0]) throw Error('usage: verifyNativeSearch.cjs WLATEX_CHECKOUT (PAPER_DIR MAIN | --corpus DIR)');
    const jobs = [];
    if (CORPUS) {
        const index = JSON.parse(fs.readFileSync(path.join(CORPUS, 'index.json'), 'utf8'));
        for (const [key, v] of Object.entries(index)) if (v.kept && (!ONLY || ONLY.includes(v.id) || ONLY.includes(key))) jobs.push([v.id, path.join(CORPUS, key), v.main]);
    } else jobs.push([path.basename(args[1]), path.resolve(args[1]), args[2]]);
    const report = JSON_OUT && ONLY && fs.existsSync(JSON_OUT) ? JSON.parse(fs.readFileSync(JSON_OUT, 'utf8')) : {};
    for (const [id, dir, main] of jobs) {
        console.log(id);
        try { report[id] = await paper(dir, main); }
        catch (error) { console.log(`  FAILED: ${error.message}`); report[id] = { error: error.message }; }
        if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
    }
    // Totals.
    for (const state of ['settled', 'edited', 'live']) {
        const inv = Object.values(report).map(r => r[state]?.inverse).filter(Boolean);
        const dir = Object.values(report).map(r => r[state]?.direct).filter(Boolean);
        const sum = (list, key) => list.reduce((n, r) => n + (r[key] || 0), 0);
        if (!inv.length) continue;
        const merge = (list, key, limits) => list.reduce((acc, r) => { const b = r[key]; if (!b) return acc;
            b.out.forEach((v, i) => { acc.out[i] += v; }); acc.beyond += b.beyond; acc.nowhere += b.nowhere; return acc; },
            { out: limits.map(() => 0), beyond: 0, nowhere: 0 });
        const ml = merge(inv, 'miss_lines', LINE_LIMITS), mp = merge(dir, 'miss_points', POINT_LIMITS);
        console.log(`${state} misses: wrong clicks ≤2 lines ${ml.out[0]}, ≤10 ${ml.out[1]}, ≤50 ${ml.out[2]}, farther ${ml.beyond}, word not in that file ${ml.nowhere}; ` +
            `wrong highlights ≤20 pt ${mp.out[0]}, ≤100 pt ${mp.out[1]}, farther ${mp.beyond}, word not on that page ${mp.nowhere}`);
        console.log(`${state}: inverse ${pct(sum(inv, 'right'), sum(inv, 'words'))} right (+${pct(sum(inv, 'line'), sum(inv, 'words'))} same line, ` +
            `${sum(inv, 'wrong')} wrong, ${sum(inv, 'unmapped')} unmapped [no source ${sum(inv, 'unsourced')}, click misses ${sum(inv, 'missed')}] of ${sum(inv, 'words')} typed words; ` +
            `generated ${pct(sum(inv, 'generatedMapped'), sum(inv, 'generated'))} mapped of ${sum(inv, 'generated')}, figure text ${sum(inv, 'figure')}); ` +
            `direct ${pct(sum(dir, 'right'), sum(dir, 'words'))} right (${sum(dir, 'empty')} empty, ${sum(dir, 'wrong')} wrong of ${sum(dir, 'words')})`);
    }
    process.exit(0);
}

main().catch(error => { console.error(error); process.exit(1); });
