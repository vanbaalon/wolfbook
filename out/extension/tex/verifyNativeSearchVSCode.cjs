// Run with VS Code --extensionDevelopmentPath CHECKOUT --extensionTestsPath THIS_FILE
// (see launchNativeSearchVSCodeCheck.cjs): direct and inverse search on a real
// paper through the viewer the reader uses. Ground truth: Poppler's words of
// the PDF on screen.
//   inverse: a click at a prose word's centre (the viewer's click handler,
//            as the webview sends it) must put the editor on a line holding
//            the word (or, for a bibliography entry, in its .bib record);
//   direct:  moving the editor cursor into a word must post a highlight that
//            covers that word on the page.
// Both again after an unsaved line is inserted above a third of the body.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { execFileSync } = require('node:child_process');
const { RenderCoordinator } = require('./renderUi');
const { Projection } = require('./index');
const { TexViewer } = require('./texViewer');
const memento = () => { const values = new Map(); return {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => { values.set(key, value); },
}; };
async function until(predicate, label, timeoutMs = 60000, intervalMs = 5) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}
const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', '’': "'" };
const tokens = text => text.replace(/[ﬀ-ﬄ’]/g, c => LIGATURES[c]).toLowerCase().match(/[a-z]+/g) || [];
function popplerWords(pdf) {
    const pages = []; let page = null;
    for (const line of execFileSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n')) {
        if (line.includes('<page ')) pages.push(page = []);
        const m = /<word xMin="([^"]+)" yMin="([^"]+)" xMax="([^"]+)" yMax="([^"]+)">(.*)<\/word>/.exec(line);
        if (m && page) page.push({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: m[5] });
    }
    return pages;
}
function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }
const quantile = (v, q) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !path.basename(path.dirname(folder)).startsWith('wpaper-ui-')) throw Error('Run only in an isolated wpaper-ui-* test directory');
    const { main, sample = 120 } = JSON.parse(fs.readFileSync(path.join(folder, '../acceptance-mode.json'), 'utf8'));
    const report = { paper: main };
    const output = vscode.window.createOutputChannel('WPaper native search');
    const projection = new Projection();
    const coord = new RenderCoordinator(projection, output);
    const context = { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')), workspaceState: memento(), globalState: memento(), subscriptions: [] };
    const viewer = new TexViewer(context, coord, projection);
    const posted = [];
    const post = viewer._post.bind(viewer);
    viewer._post = message => { if (message && message.type === 'highlight') posted.push({ at: performance.now(), message }); return post(message); };
    let subscription;
    try {
        const file = path.join(folder, main);
        const doc = await vscode.workspace.openTextDocument(file);
        let editor = await vscode.window.showTextDocument(doc);
        const t0 = performance.now();
        await coord.build(doc, { quiet: true });
        report.build_ms = Math.round(performance.now() - t0);
        const st = coord.stateFor(doc);
        if (st.generation?.runner !== 'wlatex' || !st.map?.native) throw Error(`not on the WLaTeX lane: ${st.lastError || st.nativeUnavailable || st.nativeOff}`);
        await viewer.open(doc);
        await viewer.refresh({ force: true });
        await until(() => viewer._openedPdfHash === st.generation.pdfHash, 'the PDF open in the viewer');
        const pages = popplerWords(st.generation.pdfPath);
        report.pages = pages.length;
        // Words the writer typed: in a .tex file of the project.
        const typed = new Set();
        const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith('.')) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else if (e.name.endsWith('.tex')) for (const w of fs.readFileSync(p, 'utf8').toLowerCase().match(/[a-z]{3,}/g) || []) typed.add(w);
        } };
        walk(folder);
        const random = rng(11);
        const candidates = [];
        pages.forEach((words, i) => { for (const w of words) {
            const t = tokens(w.text);
            if (t.length === 1 && t[0].length >= 4 && /^[^A-Za-z]*[A-Za-z]+[^A-Za-z]*$/.test(w.text) && typed.has(t[0])) candidates.push({ page: i + 1, ...w, word: t[0] });
        } });
        const picks = []; for (let i = 0; i < sample && candidates.length; i++) picks.push(candidates.splice(Math.floor(random() * candidates.length), 1)[0]);
        const click = async (w) => {
            const before = vscode.window.activeTextEditor;
            const key = before ? `${before.document.uri.fsPath}:${before.selection.start.line}:${before.selection.start.character}` : '';
            const t = performance.now();
            await viewer._jumpToSource({ generation: viewer._openedGeneration, page: w.page, xBp: (w.x0 + w.x1) / 2, yTopBp: (w.y0 + w.y1) / 2 });
            await until(() => { const e = vscode.window.activeTextEditor; return e && `${e.document.uri.fsPath}:${e.selection.start.line}:${e.selection.start.character}` !== key; },
                'the editor to move', 1500).catch(() => {});
            const ms = performance.now() - t;
            const e = vscode.window.activeTextEditor;
            if (!e || e.document.uri.fsPath === (before?.document.uri.fsPath) && `${e.document.uri.fsPath}:${e.selection.start.line}:${e.selection.start.character}` === key) return { ok: false, moved: false, ms };
            const line = e.selection.start.line, text = e.document.getText();
            const lines = text.split(/\r?\n/);
            let block = lines[line] || '';
            if (e.document.uri.fsPath.endsWith('.bib')) for (let i = line + 1; i < lines.length && !/^\s*@/.test(lines[i]); i++) block += '\n' + lines[i];
            return { ok: block.toLowerCase().includes(w.word), moved: true, ms, file: path.basename(e.document.uri.fsPath), line: line + 1 };
        };
        const clicks = async (label) => {
            const out = { words: picks.length, right: 0, wrong: 0, none: 0, ms: [], examples: [] };
            for (const w of picks) {
                // Start each click from the paper, somewhere else.
                editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
                editor.selection = new vscode.Selection(0, 0, 0, 0);
                const r = await click(w);
                out.ms.push(r.ms);
                if (r.ok) out.right++; else if (!r.moved) out.none++; else out.wrong++;
                if (!r.ok && out.examples.length < 10) out.examples.push({ page: w.page, word: w.text, file: r.file, line: r.line });
            }
            report[`inverse_${label}`] = { ...out, ms: undefined, p50_ms: quantile(out.ms, 0.5), p90_ms: quantile(out.ms, 0.9) };
            return out;
        };
        const cursor = async (label) => {
            editor = await vscode.window.showTextDocument(doc);
            const lines = doc.getText().split(/\r?\n/);
            const begin = lines.findIndex(l => l.includes('\\begin{document}'));
            const spots = [];
            lines.forEach((l, i) => { if (i <= begin || /^\s*[%\\]/.test(l) || l.includes('$')) return;
                for (const m of l.matchAll(/(?<![\\A-Za-z{])[A-Za-z]{5,}/g)) spots.push({ line: i, column: m.index + 2, word: m[0].toLowerCase() }); });
            const chosen = []; for (let i = 0; i < Math.min(sample, 80) && spots.length; i++) chosen.push(spots.splice(Math.floor(random() * spots.length), 1)[0]);
            const out = { words: chosen.length, right: 0, empty: 0, wrong: 0, ms: [], examples: [] };
            for (const s of chosen) {
                const since = posted.length, t = performance.now();
                editor.selection = new vscode.Selection(s.line, s.column, s.line, s.column);
                viewer.syncFromEditor(editor, { userCursorGesture: true });
                let rects = null;
                await until(() => { const m = posted.slice(since).map(p => p.message).find(m => m.exact && Array.isArray(m.rects)); rects = m?.rects || null; return !!m; },
                    'a highlight', 1500).catch(() => {});
                out.ms.push(performance.now() - t);
                if (!rects || !rects.length) { out.empty++; if (out.examples.length < 10) out.examples.push({ kind: 'empty', line: s.line + 1, word: s.word }); continue; }
                const hit = rects.some(r => (pages[r.page - 1] || []).some(w => {
                    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
                    return cx >= w.x0 - 1 && cx <= w.x1 + 1 && cy >= w.y0 - 1 && cy <= w.y1 + 1 &&
                        tokens(w.text).some(t => t.length >= 2 && (t.startsWith(s.word) || s.word.startsWith(t) || (t.length >= 3 && s.word.includes(t))));
                }));
                if (hit) out.right++; else { out.wrong++; if (out.examples.length < 10) out.examples.push({ kind: 'wrong', line: s.line + 1, word: s.word, page: rects[0].page }); }
            }
            report[`direct_${label}`] = { ...out, ms: undefined, p50_ms: quantile(out.ms, 0.5), p90_ms: quantile(out.ms, 0.9) };
        };
        await clicks('settled');
        await cursor('settled');
        // An unsaved line above a third of the body: the map translates.
        subscription = vscode.workspace.onDidChangeTextDocument(event => { if (event.document === doc) coord.noteChange(event); });
        editor = await vscode.window.showTextDocument(doc);
        const body = doc.getText().split(/\r?\n/);
        const at = Math.max(body.findIndex(l => l.includes('\\begin{document}')) + 1, Math.floor(body.length / 3));
        await editor.edit(b => b.insert(new vscode.Position(at, 0), '% an unsaved note\n'));
        await until(() => st.map.available, 'the translated map', 60000);
        await clicks('edited');
        await cursor('edited');
        const rate = (r, key = 'right') => r.words ? r[key] / r.words : 1;
        report.result = rate(report.inverse_settled) >= 0.95 && rate(report.inverse_edited) >= 0.95 &&
            rate(report.direct_settled) >= 0.9 && rate(report.direct_edited) >= 0.9 ? 'PASS' : 'FAIL';
    } catch (error) {
        report.result = 'FAIL'; report.error = String(error?.stack || error);
    } finally {
        report.vscode = vscode.version;
        fs.writeFileSync(path.join(folder, '../vscode-search.json'), JSON.stringify(report, null, 2));
        subscription?.dispose(); viewer.panel?.dispose(); coord.dispose(); projection.dispose(); output.dispose();
    }
};
