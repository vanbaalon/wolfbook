// tex-tools.js — the `paper_*` LM/MCP tool surface for .tex documents.
//
// Registered from tools/index.js exactly like wolfslide-tools.js: classes with
// prepareInvocation/invoke, added to the `tools` array, declared in
// package.json contributes.languageModelTools.
//
// Read semantic projections and apply guarded transactions. Optional LaTeX
// verification compiles private overlays; managed blocks are never evaluated.
//
// The mutation guard is deliberately the SAME SHAPE as the notebook one at
// tools/index.js:104 (`mutationConflict`) — a structured conflict record
// carrying the CURRENT hash and first line, so an agent can re-read and retry
// instead of guessing. An agent that has learned the notebook contract already
// knows this one.

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');

const { scanTex } = require('../tex/texScanner');
const {
    buildModel, buildOutline, summariseObject, sha256, ADDRESSABLE,
} = require('../tex/texModel');
const { parseMmaBlocks, BLOCK_STATE } = require('../tex/mmaBlocks');
const { findRoot, buildGraph } = require('../tex/texProject');
const { checkWritable } = require('../tex/diskGuard');
const { announceAgentEdit } = require('../tex/reviewBus');
const { compile } = require('../tex/compileService');
const { paperCompileEngine } = require('../tex/livePolicy');
const { regexPositions } = require('../tex/regexSearch');
const { CommentStore, reconcileRecord, selectionLocation, commentHash } = require('../tex/commentStore');
const { commentInbox } = require('../tex/commentInbox');
const { resolveCommentAnchor, uniqueOffset, changedRange } = require('../tex/commentAnchor');
const { commentAgent } = require('../tex/commentWakeup');
const { readerConflict, readerRanges } = require('../tex/editorActivity');
const { diffLines, splitLines } = require('../tex/texDiff');
const fs = require('fs');
const os = require('os');

const ok = (text) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
const jsonPart = (obj) => ok(JSON.stringify(obj, null, 2));
const errPart = (msg) => ok(`Error: ${msg}`);

// --- document resolution ----------------------------------------------------
// ROUTING-NEUTRAL, like the read-side notebook tools: resolving a document must
// never open an editor or change what any other tool considers "current".

function texDocuments() {
    return vscode.workspace.textDocuments.filter(d =>
        /\.tex$/i.test(d.uri.fsPath) || d.languageId === 'latex' || d.languageId === 'tex');
}

/**
 * @returns {{doc, uri, fsPath, text}|null}
 * `file` may be an absolute path, a workspace-relative path, or a bare
 * basename. Bare names are accepted because that is what an agent naturally
 * types, and rejected as ambiguous only when they actually are.
 */
async function resolveTexDocument(file) {
    const open = texDocuments();
    if (!file) {
        const active = vscode.window.activeTextEditor?.document;
        if (active && /\.tex$/i.test(active.uri.fsPath)) return wrap(active);
        if (open.length === 1) return wrap(open[0]);
        if (open.length > 1) {
            return { ambiguous: open.map(d => d.uri.fsPath) };
        }
        return null;
    }

    const want = String(file);
    let hit = open.find(d => d.uri.fsPath === want);
    if (hit) return wrap(hit);
    const base = path.basename(want);
    // A path is an exact address, never a hint to pick another main.tex.
    const bareName = want === base;
    const sameBase = bareName ? open.filter(d => path.basename(d.uri.fsPath) === base) : [];
    if (sameBase.length === 1) return wrap(sameBase[0]);
    if (sameBase.length > 1) return { ambiguous: sameBase.map(d => d.uri.fsPath) };

    // Not open: read from disk, still without opening an editor.
    const candidates = [];
    if (path.isAbsolute(want)) candidates.push(vscode.Uri.file(want));
    for (const folder of path.isAbsolute(want) ? [] : vscode.workspace.workspaceFolders || []) {
        candidates.push(vscode.Uri.joinPath(folder.uri, want));
        if (!/\.tex$/i.test(want)) candidates.push(vscode.Uri.joinPath(folder.uri, want + '.tex'));
    }
    const found = [];
    for (const uri of candidates) {
        try {
            if (found.some(r => r.fsPath === uri.fsPath)) continue;
            const doc = open.find(d => d.uri.fsPath === uri.fsPath);
            const bytes = doc ? null : await vscode.workspace.fs.readFile(uri);
            found.push(doc ? wrap(doc) : { doc: null, uri, fsPath: uri.fsPath, text: Buffer.from(bytes).toString('utf8') });
        } catch (_) { /* next */ }
    }
    return found.length > 1 ? { ambiguous:found.map(r => r.fsPath) } : found[0] || null;
}

function wrap(doc) {
    return { doc, uri: doc.uri, fsPath: doc.uri.fsPath, text: doc.getText() };
}

/** Injected-fs adapter for texProject, backed by node fs (sync, tiny files). */
function nodeDeps() {
    const fs = require('fs');
    return {
        readFile: (p) => fs.readFileSync(p, 'utf8'),
        exists: (p) => { try { return fs.existsSync(p); } catch (_) { return false; } },
        listDir: (d) => { try { return fs.readdirSync(d); } catch (_) { return []; } },
    };
}

function projectProjections(r) {
    const deps = nodeDeps();
    const openByPath = new Map(texDocuments().map(doc => [doc.uri.fsPath, doc.getText()]));
    openByPath.set(r.fsPath, r.text);
    const diskRead = deps.readFile, diskExists = deps.exists;
    deps.readFile = file => openByPath.has(file) ? openByPath.get(file) : diskRead(file);
    deps.exists = file => openByPath.has(file) || diskExists(file);
    const root = findRoot(r.fsPath, deps);
    const graph = buildGraph(root.root, deps);
    const projections = [];
    for (const file of graph.files) {
        let text = openByPath.get(file);
        if (text == null) { try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; } }
        projections.push(projectionOf(file, text));
    }
    if (!projections.some(p => p.fsPath === r.fsPath)) projections.push(projectionOf(r.fsPath, r.text));
    return { root, graph, projections };
}

// --- a tiny per-file cache --------------------------------------------------
// Keyed on content hash, so it is correct by construction: a changed file has a
// different key and simply misses.

const _cache = new Map();
const CACHE_MAX = 32;

function projectionOf(fsPath, text) {
    // The separator is written as an ESCAPE, not as a raw byte: a NUL in the
    // source makes the whole file BINARY to git, grep and diff, which costs
    // every future review of it. Same character at runtime.
    const key = fsPath + '\u0000' + sha256(text);
    const hit = _cache.get(key);
    if (hit) return hit;
    const scan = scanTex(text, { file: fsPath });
    const model = buildModel(scan, { file: fsPath });
    const mma = parseMmaBlocks(text, { file: fsPath });
    const value = { scan, model, mma, text, fsPath };
    _cache.set(key, value);
    if (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
    return value;
}

/**
 * Find one object by objectId, stableKey, or label. objectIds are session-local
 * and change when the extension restarts, so a label or stableKey is the
 * durable address and both are accepted everywhere an id is.
 */
function findObject(model, selector) {
    if (!selector) return null;
    const s = String(selector);
    return model.objects.find(o => o.objectId === s)
        || model.objects.find(o => o.stableKey === s)
        || model.objects.find(o => o.label === s)
        || model.objects.find(o => o.kind === 'label' && o.name === s)
        || null;
}

function findObjects(model, selector) {
    if (!selector) return [];
    const s = String(selector);
    const exact = model.objects.filter(o => o.objectId === s || o.stableKey === s);
    if (exact.length) return exact;
    const labelledOwners = model.objects.filter(o => o.label === s && o.kind !== 'label');
    if (labelledOwners.length) return labelledOwners;
    return model.objects.filter(o => o.kind === 'label' && o.name === s);
}

function ambiguousSelection(selector, matches) {
    return {
        state: 'ambiguous', selector: String(selector), matches: matches.length,
        candidates: matches.slice(0, 20).map(o => summariseObject(o)),
        remedy: 'retry with one exact stableKey',
    };
}

function warningKey(w) {
    // Moving an existing warning to another line is not a new parse failure.
    return typeof w === 'string' ? w.replace(/^.*?:\d+: /, '') : JSON.stringify(w);
}

function referenceHealth(model) {
    const labels = model.objects.filter(o => o.kind === 'label');
    const refs = model.objects.filter(o => o.kind === 'ref');
    const declared = new Set(labels.map(o => o.name));
    const byName = new Map();
    for (const o of labels) {
        if (!byName.has(o.name)) byName.set(o.name, []);
        byName.get(o.name).push(o.sourceRange.startLine);
    }
    return {
        unresolvedRefs: refs.filter(o => !declared.has(o.target))
            .map(o => ({ target: o.target, command: o.cmd, stableKey: o.stableKey,
                line: o.sourceRange.startLine })),
        duplicateLabels: [...byName].filter(([, lines]) => lines.length > 1)
            .map(([name, lines]) => ({ name, lines })),
        unusedLabels: [...declared].filter(name => !refs.some(o => o.target === name)),
    };
}

/**
 * The mutation guard. Same contract as tools/index.js:104 for notebook cells:
 * on a mismatch, return a STRUCTURED record naming the current hash so the
 * caller can re-read and retry, rather than a bare failure.
 */
function texMutationConflict(obj, text, input = {}) {
    const current = text.slice(obj.sourceRange.startOffset, obj.sourceRange.endOffset);
    const hash = sha256(current);
    const mismatch =
        (input.expected_source_hash != null &&
            String(input.expected_source_hash).toLowerCase() !== hash) ||
        (input.expected_object_id != null && input.expected_object_id !== obj.objectId) ||
        (input.expected_stable_key != null && input.expected_stable_key !== obj.stableKey) ||
        (input.expected_source_prefix != null && !current.startsWith(String(input.expected_source_prefix)));
    if (!mismatch) return null;
    return {
        state: 'conflict',
        reason: 'the object changed since you last read it',
        object_id: obj.objectId,
        stable_key: obj.stableKey,
        kind: obj.kind,
        source_hash: hash,
        first_line: current.split('\n')[0].slice(0, 200),
        start_line: obj.sourceRange.startLine,
        end_line: obj.sourceRange.endLine,
    };
}

async function withDocument(input, fn) {
    const r = await resolveTexDocument(input?.file);
    if (!r) {
        return errPart(input?.file
            ? `no .tex document matching ${JSON.stringify(input.file)} (open it, or give a path relative to the workspace)`
            : 'no .tex document is open; pass `file`');
    }
    if (r.ambiguous) {
        return errPart(`ambiguous: ${r.ambiguous.length} open .tex files match. Pass one of:\n  ` +
            r.ambiguous.join('\n  '));
    }
    try {
        return await fn(r);
    } catch (e) {
        return errPart(`${e && e.message ? e.message : String(e)}`);
    }
}

// ---------------------------------------------------------------------------
// paper_getOutline

class PaperGetOutlineTool {
    async prepareInvocation(options) {
        return { invocationMessage: `Paper outline: ${path.basename(options.input?.file || 'active .tex')}` };
    }
    async invoke(options) {
        const input = options.input || {};
        return withDocument(input, async (r) => {
            const { model, mma, scan } = projectionOf(r.fsPath, r.text);
            const counts = {};
            for (const o of model.objects) counts[o.kind] = (counts[o.kind] || 0) + 1;

            const mode = ['summary', 'tree', 'objects'].includes(input.mode) ? input.mode : 'summary';
            const includeIdentity = input.include_identity === true;
            const maxDepth = Math.max(0, Math.min(12, Number(input.max_depth ?? (mode === 'summary' ? 0 : 12))));
            const compactNode = (node, depth = 0) => {
                const original = model.byKey.get(node.stableKey);
                if (mode === 'summary' && !includeIdentity) {
                    return {
                        title: node.title, label: original?.label,
                        line: node.startLine, children: node.children?.length || undefined,
                    };
                }
                const out = {
                    title: node.title, label: original?.label,
                    level: node.level, startLine: node.startLine,
                    childCount: node.children?.length || undefined,
                };
                if (includeIdentity) {
                    out.objectId = node.objectId;
                    out.stableKey = node.stableKey;
                }
                if (depth < maxDepth && node.children?.length) {
                    out.children = node.children.map(child => compactNode(child, depth + 1));
                }
                return out;
            };
            let fullOutline = buildOutline(model.objects);
            if (input.selector) {
                const headings = model.objects.filter(o => o.kind === 'section-heading');
                const exact = findObjects(model, input.selector).filter(o => o.kind === 'section-heading');
                const needle = String(input.selector).toLowerCase();
                const candidates = exact.length ? exact : headings.filter(o =>
                    String(o.title || '').toLowerCase().includes(needle));
                if (candidates.length > 1) return jsonPart(ambiguousSelection(input.selector, candidates));
                if (!candidates.length) return jsonPart({ state: 'not-found', selector: input.selector,
                    remedy: 'use paper_search or request the unfiltered summary' });
                const wanted = candidates[0].stableKey;
                const findNode = (nodes) => {
                    for (const node of nodes) {
                        if (node.stableKey === wanted) return node;
                        const nested = findNode(node.children || []);
                        if (nested) return nested;
                    }
                    return null;
                };
                const node = findNode(fullOutline);
                fullOutline = node ? [node] : [];
            }
            const outlineFrom = Number(input.from_line ?? 0);
            const outlineTo = Number(input.to_line ?? Number.MAX_SAFE_INTEGER);
            const filterNodes = (nodes) => nodes.flatMap(node => {
                const children = filterNodes(node.children || []);
                const own = node.startLine >= outlineFrom && node.startLine <= outlineTo;
                return own || children.length ? [{ ...node, children }] : [];
            });
            if (input.from_line != null || input.to_line != null) fullOutline = filterNodes(fullOutline);
            let outline = fullOutline.map(node => compactNode(node));
            let page;
            if (mode === 'objects') {
                const offset = Math.max(0, Number(input.offset || 0));
                const limit = Math.max(1, Math.min(200, Number(input.limit || 50)));
                let objects = model.objects.filter(o => ADDRESSABLE.has(o.kind) &&
                    o.sourceRange.startLine >= outlineFrom && o.sourceRange.startLine <= outlineTo);
                if (input.selector && fullOutline.length) {
                    const head = model.byKey.get(fullOutline[0].stableKey);
                    const end = sectionEndOffset(model, r.text, head);
                    objects = objects.filter(o => o.sourceRange.startOffset >= head.sourceRange.startOffset &&
                        o.sourceRange.startOffset < end);
                }
                page = {
                    offset, limit, total: objects.length,
                    nextOffset: offset + limit < objects.length ? offset + limit : undefined,
                    items: objects.slice(offset, offset + limit).map(o => summariseObject(o)),
                };
                outline = undefined;
            }

            const out = {
                file: mode === 'summary' && !includeIdentity ? path.basename(r.fsPath) : r.fsPath,
                mode,
                documentHash: mode === 'summary' && !includeIdentity ? undefined : sha256(r.text),
                outline,
                page,
                counts,
                objects: model.objects.filter(o => ADDRESSABLE.has(o.kind)).length,
                managedBlocks: mma.blocks.length
                    ? { total: mma.blocks.length, byState: tally(mma.blocks.map(b => b.state)) }
                    : undefined,
                warnings: scan.warnings.concat(mma.warnings).slice(0, 20),
            };
            if (input.include_project) {
                const { root, graph, projections } = projectProjections(r);
                const fileKeys = new Map(graph.files.map((file, index) => [file, `f${index}`]));
                const byFile = new Map(projections.map(p => [p.fsPath, p]));
                out.project = {
                    root: root.root, rootSource: root.source,
                    fileCount: graph.files.length,
                    files: graph.files.map((file, index) => ({
                        key: `f${index}`, path: file,
                        relativePath: path.relative(path.dirname(root.root), file) || path.basename(file),
                        objects: byFile.get(file)?.model.objects.filter(o => ADDRESSABLE.has(o.kind)).length,
                        headings: byFile.get(file)?.model.objects.filter(o => o.kind === 'section-heading').length,
                        warnings: byFile.get(file)?.scan.warnings.length,
                    })),
                    edges: graph.edges.map(edge => ({
                        from: fileKeys.get(edge.from), to: fileKeys.get(edge.to),
                        line: edge.line, command: edge.cmd,
                    })),
                    missing: graph.missing, cycles: graph.cycles,
                };
            }
            // The orientation call is deliberately wire-compact. On the
            // 1,678-object acceptance paper this stays below 4,000 characters;
            // callers that need identities or the recursive tree opt in.
            return mode === 'summary' && !includeIdentity
                ? ok(JSON.stringify(out)) : jsonPart(out);
        });
    }
}

const tally = (xs) => xs.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {});

// ---------------------------------------------------------------------------
// paper_getObject

class PaperGetObjectTool {
    async prepareInvocation(options) {
        return { invocationMessage: `Paper object: ${options.input?.selector || '?'}` };
    }
    async invoke(options) {
        const input = options.input || {};
        if (input.selectors !== undefined) {
            if (!Array.isArray(input.selectors) || input.selectors.length < 1 || input.selectors.length > 10 ||
                input.selectors.some(s=>typeof s !== 'string' || !s) || input.selector || input.reveal)
                return errPart('selectors must contain 1–10 keys; do not combine a batch with selector or reveal');
            const budget=Number(input.max_chars ?? 8000);
            if (!Number.isInteger(budget) || budget < 1 || budget > 32000)
                return errPart('batch max_chars is a total source budget of 1–32000');
            return withDocument(input, async r=>{
                const {model}=projectionOf(r.fsPath,r.text), perObject=Math.floor(budget/input.selectors.length);
                return jsonPart({file:r.fsPath,document_hash:sha256(r.text),buffer_version:r.doc?.version ?? null,
                    objects:input.selectors.map(selector=>{
                        const matches=findObjects(model,selector);
                        if (matches.length > 1) return ambiguousSelection(selector,matches);
                        if (!matches.length) return {selector,state:'not-found'};
                        return {selector,...summariseObject(matches[0],{includeText:true,maxText:perObject})};
                    })});
            });
        }
        if (!input.selector) return errPart('`selector` or `selectors` is required (objectId, stableKey, or \\label)');
        return withDocument(input, async (r) => {
            const { model } = projectionOf(r.fsPath, r.text);
            const matches = findObjects(model, input.selector);
            if (matches.length > 1) return jsonPart(ambiguousSelection(input.selector, matches));
            const obj = matches[0];
            if (!obj) {
                const near = model.objects
                    .filter(o => ADDRESSABLE.has(o.kind))
                    .slice(0, 15).map(o => o.stableKey);
                return errPart(`no object matching ${JSON.stringify(input.selector)}. ` +
                    `Some keys in this file:\n  ${near.join('\n  ')}`);
            }
            const body = summariseObject(obj, { includeText: true, maxText: input.max_chars ?? 4000 });
            if (input.include_neighbours) {
                const i = model.objects.indexOf(obj);
                body.previous = i > 0 ? summariseObject(model.objects[i - 1]) : null;
                body.next = i < model.objects.length - 1 ? summariseObject(model.objects[i + 1]) : null;
            }
            if (input.reveal && r.doc) {
                const editor = await vscode.window.showTextDocument(r.doc, { preview: false, preserveFocus: false });
                const range = new vscode.Range(
                    r.doc.positionAt(obj.sourceRange.startOffset),
                    r.doc.positionAt(obj.sourceRange.endOffset));
                editor.selection = new vscode.Selection(range.start, range.start);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                body.revealed = true;
            }
            return jsonPart(body);
        });
    }
}

// ---------------------------------------------------------------------------
// paper_getSection

class PaperGetSectionTool {
    async prepareInvocation(options) {
        return { invocationMessage: `Paper section: ${options.input?.selector || '?'}` };
    }
    async invoke(options) {
        const input = options.input || {};
        return withDocument(input, async (r) => {
            const { model } = projectionOf(r.fsPath, r.text);
            const headings = model.objects.filter(o => o.kind === 'section-heading');
            if (!headings.length) return errPart('this file has no sectioning commands');

            const sel = String(input.selector ?? '').toLowerCase();
            const exact = sel ? findObjects(model, input.selector).filter(o => o.kind === 'section-heading') : [];
            const fuzzy = sel && !exact.length
                ? headings.filter(h => (h.title || '').toLowerCase().includes(sel)) : [];
            const candidates = exact.length ? exact : fuzzy;
            if (candidates.length > 1) return jsonPart(ambiguousSelection(input.selector, candidates));
            const head = sel ? candidates[0] : headings[0];
            if (!head || head.kind !== 'section-heading') {
                return errPart(`no section matching ${JSON.stringify(input.selector)}. Sections:\n  ` +
                    headings.map(h => h.title).join('\n  '));
            }
            // The section runs to the next heading at the same or higher level.
            const idx = headings.indexOf(head);
            const end = headings.slice(idx + 1).find(h => (h.level ?? 0) <= (head.level ?? 0));
            const from = head.sourceRange.startOffset;
            const to = sectionEndOffset(model, r.text, head);

            const contained = model.objects.filter(o =>
                o.sourceRange.startOffset >= from && o.sourceRange.endOffset <= to &&
                ADDRESSABLE.has(o.kind) && o !== head);

            return jsonPart({
                file: r.fsPath,
                section: summariseObject(head),
                textScope: 'heading-and-body',
                sectionIdentityScope: 'heading-only',
                startLine: head.sourceRange.startLine,
                endLine: Math.max(head.sourceRange.startLine, lineCount(r.text.slice(0, to)) - (r.text[to - 1] === '\n' ? 1 : 0)),
                objects: contained.map(o => summariseObject(o)),
                text: input.include_text
                    ? r.text.slice(from, Math.min(to, from + (input.max_chars ?? 8000)))
                    : undefined,
                textTruncated: input.include_text ? to - from > (input.max_chars ?? 8000) : undefined,
            });
        });
    }
}

// ---------------------------------------------------------------------------
// paper_findReferences

class PaperFindReferencesTool {
    async prepareInvocation(options) {
        return { invocationMessage: `Paper references: ${options.input?.name || 'all'}` };
    }
    async invoke(options) {
        const input = options.input || {};
        return withDocument(input, async (r) => {
            const local = projectionOf(r.fsPath, r.text);
            const project = input.include_project ? projectProjections(r) : null;
            const projections = project?.projections || [local];
            const all = projections.flatMap(p => p.model.objects);
            const name = input.name ? String(input.name) : null;

            const labels = all.filter(o => o.kind === 'label');
            const refs = all.filter(o => o.kind === 'ref');
            const cites = all.filter(o => o.kind === 'cite');

            if (name) {
                const declared = labels.filter(l => l.name === name);
                const used = refs.filter(x => x.target === name);
                const cited = cites.filter(x => x.target === name);
                const owner = all.find(o => o.label === name && o.kind !== 'label');
                return jsonPart({
                    name,
                    declaredIn: declared.map(l => ({ file: l.sourceRange.file, line: l.sourceRange.startLine })),
                    attachedTo: owner ? summariseObject(owner) : null,
                    referencedBy: used.map(x => ({ file: x.sourceRange.file, cmd: x.cmd, line: x.sourceRange.startLine })),
                    citedBy: cited.map(x => ({ file: x.sourceRange.file, cmd: x.cmd, line: x.sourceRange.startLine })),
                    unresolved: declared.length === 0 && (used.length > 0 || cited.length > 0),
                    projectRoot: project?.root.root,
                });
            }

            // No name: the whole reference health of the file.
            const declaredNames = new Set(labels.map(l => l.name));
            const seen = new Map();
            const duplicates = [];
            for (const l of labels) {
                const at = { file: l.sourceRange.file, line: l.sourceRange.startLine };
                if (seen.has(l.name)) duplicates.push({ name: l.name, declarations: [seen.get(l.name), at] });
                else seen.set(l.name, at);
            }
            return jsonPart({
                file: r.fsPath,
                projectRoot: project?.root.root,
                files: projections.length,
                labels: labels.length,
                refs: refs.length,
                cites: cites.length,
                unresolvedRefs: refs.filter(x => !declaredNames.has(x.target))
                    .map(x => ({ target: x.target, file: x.sourceRange.file, line: x.sourceRange.startLine })),
                duplicateLabels: duplicates,
                unusedLabels: [...declaredNames].filter(n => !refs.some(x => x.target === n)),
            });
        });
    }
}

// ---------------------------------------------------------------------------
// paper_search

class PaperSearchTool {
    async prepareInvocation(options) {
        return { invocationMessage: `Paper search: ${options.input?.query || ''}` };
    }
    async invoke(options) {
        const input = options.input || {};
        if (!input.query && !Array.isArray(input.queries)) return errPart('`query` or `queries` is required');
        return withDocument(input, async (r) => {
            const local = projectionOf(r.fsPath, r.text);
            const project = input.include_project ? projectProjections(r) : null;
            const models = (project?.projections || [local]).map(p => p.model);
            const allObjects = models.flatMap(model => model.objects);
            const queries = Array.isArray(input.queries) ? input.queries : [input];
            const results = [];
            for (let qi = 0; qi < queries.length; qi++) {
                const query = queries[qi] || {};
                const q = query.query ?? query.text ?? '';
                const labelPrefix = query.label_prefix ?? query.labelPrefix;
                if (!q && !labelPrefix) {
                    results.push({ index: qi, error: '`query`/`text` or `label_prefix` is required' });
                    continue;
                }
                let re;
                try { re = query.regex ? new RegExp(String(q), 'i') : null; }
                catch (e) { results.push({ index: qi, error: `bad regex: ${e.message}` }); continue; }
                const needle = String(q).toLowerCase();
                const kinds = query.kinds?.length ? new Set(query.kinds) : null;
                const sectionSelector = String(query.within_section ?? query.withinSection ??
                    input.within_section ?? input.withinSection ?? '');
                let section = sectionSelector.toLowerCase();
                let sectionFile = null;
                let sectionFrom = 0; let sectionTo = Number.MAX_SAFE_INTEGER;
                if (sectionSelector) {
                    const exactSections = allObjects.filter(o => o.kind === 'section-heading' &&
                        (o.objectId === sectionSelector || o.stableKey === sectionSelector || o.label === sectionSelector));
                    if (exactSections.length > 1) {
                        results.push({ index: qi, error: `section selector ${sectionSelector} is ambiguous`,
                            candidates: exactSections.slice(0, 20).map(o => summariseObject(o)) });
                        continue;
                    }
                    if (exactSections.length === 1) {
                        const head = exactSections[0];
                        section = '';
                        sectionFile = head.sourceRange.file;
                        sectionFrom = head.sourceRange.startLine;
                        const owning = models.find(model => model.file === head.sourceRange.file);
                        const source = (project?.projections || [local]).find(p => p.fsPath === head.sourceRange.file)?.text || r.text;
                        const endOffset = sectionEndOffset(owning, source, head);
                        sectionTo = Math.max(sectionFrom, source.slice(0, endOffset).split('\n').length - 1);
                    }
                }
                const fromLine = Math.max(sectionFrom, Number(query.from_line ?? input.from_line ?? 0));
                const toLine = Math.min(sectionTo,
                    Number(query.to_line ?? input.to_line ?? Number.MAX_SAFE_INTEGER));
                const maxDepth = Number(query.max_depth ?? input.max_depth ?? Number.MAX_SAFE_INTEGER);
                const limit = Math.max(1, Math.min(100, Number(query.limit ?? input.limit_per_query ?? input.limit ?? 25)));
                let positions = null;
                if (re && !labelPrefix) {
                    try { positions = await regexPositions(re.source, allObjects.map(o =>
                        `${o.text || ''}\n${o.title || ''}\n${o.label || (o.kind === 'label' ? o.name : '')}`)); }
                    catch (error) { results.push({index:qi, error:error.message}); continue; }
                }
                const hits = [];
                for (const [oi, o] of allObjects.entries()) {
                    if (kinds ? !kinds.has(o.kind) : !ADDRESSABLE.has(o.kind)) continue;
                    if (sectionFile && o.sourceRange.file !== sectionFile) continue;
                    if (o.sourceRange.startLine < fromLine || o.sourceRange.startLine > toLine) continue;
                    if ((o.sectionPath || []).length > maxDepth) continue;
                    if (section && !(o.sectionPath || []).join(' › ').toLowerCase().includes(section)) continue;
                    const label = o.label || (o.kind === 'label' ? o.name : '');
                    const hay = `${o.text || ''}\n${o.title || ''}\n${label}`;
                    const match = labelPrefix
                        ? String(label).startsWith(String(labelPrefix))
                        : (positions ? positions[oi] >= 0 : hay.toLowerCase().includes(needle));
                    if (!match) continue;
                    const s = summariseObject(o);
                    s.excerpt = excerpt(o.text || o.title || label, String(q || labelPrefix), null, positions?.[oi]);
                    hits.push(s);
                    if (hits.length >= limit) break;
                }
                results.push({ index: qi, query: q || undefined, labelPrefix: labelPrefix || undefined,
                    matches: hits.length, hits });
            }
            if (!Array.isArray(input.queries)) {
                const one = results[0];
                if (one.error) return errPart(one.error);
                return jsonPart({ file: r.fsPath, projectRoot: project?.root.root,
                    query: one.query, matches: one.matches, hits: one.hits });
            }
            return jsonPart({ file: r.fsPath, projectRoot: project?.root.root,
                queryCount: results.length, results });
        });
    }
}

function excerpt(text, q, re, at) {
    const i = at ?? (re ? text.search(re) : text.toLowerCase().indexOf(q.toLowerCase()));
    if (i < 0) return text.slice(0, 160);
    const from = Math.max(0, i - 60);
    return (from ? '…' : '') + text.slice(from, i + 120).replace(/\s+/g, ' ') + '…';
}

// ---------------------------------------------------------------------------
// paper_mathematicaBlocks — state classification, NO execution (Stage 4)

class PaperMathematicaBlocksTool {
    async prepareInvocation(options) {
        return { invocationMessage: `Managed blocks: ${path.basename(options.input?.file || 'active .tex')}` };
    }
    async invoke(options) {
        const input = options.input || {};
        return withDocument(input, async (r) => {
            const { mma } = projectionOf(r.fsPath, r.text);
            const wanted = input.state ? new Set([].concat(input.state)) : null;
            const blocks = mma.blocks
                .filter(b => !wanted || wanted.has(b.state))
                .map(b => ({
                    blockId: b.blockId,
                    cellId: b.cellId, kind: b.kind, state: b.state, stateReason: b.stateReason,
                    startLine: b.startLine, endLine: b.endLine,
                    codeHash: b.codeHash.slice(0, 12),
                    code: input.include_code ? b.code : undefined,
                    // A block holds an ordered list of cells, each with its own
                    // state and its own answer to "does this reach the paper".
                    // The block-level fields above are the roll-up.
                    cells: b.cells.map(c => ({
                        cellId: c.cellId, kind: c.kind, state: c.state,
                        include: c.include !== false,
                        startLine: c.startLine, endLine: c.endLine,
                        sourceHash: c.sourceHash.slice(0, 12),
                        code: input.include_code ? c.code : undefined,
                        hasOutput: c.outputIndex != null,
                    })),
                    output: b.output ? {
                        startLine: b.output.startLine, endLine: b.output.endLine,
                        closed: b.output.closed,
                        declaredSourceHash: b.declaredSourceHash,
                        declaredOutputHash: b.declaredOutputHash,
                    } : null,
                    outputs: b.outputs.map(o => ({
                        cellId: o.cellId, startLine: o.startLine, endLine: o.endLine, closed: o.closed,
                    })),
                }));
            return jsonPart({
                file: r.fsPath,
                total: mma.blocks.length,
                byState: tally(mma.blocks.map(b => b.state)),
                orphanedOutputs: mma.outputs.map(o => ({ cellId: o.cellId, startLine: o.startLine, state: o.state })),
                blocks,
                warnings: mma.warnings,
                note: 'Open the paper in WPaper to run a block: its ∑+ button drops a new one, '
                    + 'and the CodeLens above an existing block opens it.',
            });
        });
    }
}

// ---------------------------------------------------------------------------
// paper_previewEdit / paper_applyEdit

// Preview/apply share an expiring transaction store.  Keeping the proposed
// complete document, rather than a bag of line edits, gives apply one guarded
// WorkspaceEdit and therefore one undo step.  Tokens are capabilities local to
// this extension host; a restart invalidates them safely.
const _transactions = new Map();
const _journal = [];
const TX_TTL_MS = 60 * 60 * 1000;
const TX_MAX = 32;
const _applyQueues = new Map();

class PaperListenCommentsTool {
    async prepareInvocation(options) {
        return { invocationMessage:`Paper comments: ${options.input?.action || 'start'}` };
    }
    async invoke(options, token) {
        const input=options.input || {}, action=input.action || 'start';
        try {
            const inbox=commentInbox();
            if (action === 'start') {
                if (!input.file) return errPart('file is required to start a comment listener');
                const agent=commentAgent(input.agent,input._activityContext?.agentName);
                return await withDocument(input, async r => jsonPart(await inbox.start(r.fsPath,input.include_existing === true,agent,
                    input._activityContext?.agentSessionId)));
            }
            if (!input.listener_id) return errPart('listener_id is required');
            if (action === 'stop') {
                if (input.file) inbox.get(input.listener_id, input.file);
                return jsonPart(inbox.stop(input.listener_id));
            }
            const listener=inbox.get(input.listener_id,input.file);
            if (action === 'cancel_wait' && input._operationId) return jsonPart(inbox.cancelWait(listener.id,input._operationId));
            if (action === 'status') return jsonPart({...inbox.status(listener.id,input.projection === 'full'), reader_ranges:readerRanges(listener.file)});
            if (action === 'release') return jsonPart(inbox.release(listener.id,input.delivery_id));
            if (action === 'ack') {
                return await withDocument({file:listener.file}, async r =>
                    jsonPart(acknowledgeCommentEdit(r, listener.id, input.delivery_id, input.operation_id)));
            }
            if (action === 'context') {
                const {delivery}=inbox.claim(listener.id,input.delivery_id);
                const ids=input.comment_ids ?? [input.comment_id];
                if (!Array.isArray(ids) || !ids.length || ids.length > 10 || new Set(ids).size !== ids.length ||
                    ids.some(id=>typeof id !== 'string'))
                    return jsonPart({state:'invalid',reason:'context requires comment_id or 1–10 distinct comment_ids'});
                const comments=ids.map(id=>delivery.comments.find(c=>c.id === id));
                if (comments.some(c=>!c)) return jsonPart({state:'not-found', reason:'comment_id is not part of this delivery'});
                return await withDocument({file:listener.file}, async r => {
                    const offset=Number(input.offset ?? 0), limit=Number(input.limit ?? 8000);
                    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < ids.length || limit > 8000)
                        return jsonPart({state:'invalid',reason:'context offset must be nonnegative and limit must be 1–8000'});
                    const each=Math.floor(limit/ids.length);
                    const contexts=comments.map(comment=>{
                        const anchor=resolveCommentAnchor(r.fsPath,r.text,comment,r.doc?.version),span=anchor.editable_span;
                        if (span) {
                            const source=r.text.slice(span.startOffset,span.endOffset);
                            span.text=source.slice(offset,offset+each); span.offset=offset;
                            span.truncated=offset+span.text.length < source.length; span.total_length=source.length;
                            if (readerConflict(r.fsPath,[{start:span.startOffset,end:span.endOffset}])) {
                                anchor.text_status=anchor.status; anchor.status='user-editing';
                            }
                        }
                        return {comment_id:comment.id,text:comment.text.slice(offset,offset+each),
                            text_truncated:offset+each < comment.text.length,author:comment.author,createdAt:comment.createdAt,
                            updatedAt:comment.updatedAt,source:comment.source,revision:comment.revision,
                            ...(!span ? {quote:(comment.selection?.quote || comment.cell?.source || '').slice(offset,offset+each)} : {}),anchor};
                    });
                    return jsonPart({file:r.fsPath,document_hash:sha256(r.text),buffer_version:r.doc?.version ?? null,
                        ...(input.comment_ids ? {contexts} : contexts[0])});
                });
            }
            if (action !== 'next') return errPart('action must be start, next, context, ack, release, status, or stop');
            const response=await inbox.next(listener.id,{waitSeconds:input.wait_seconds ?? 45,
                maxComments:input.max_comments ?? 1,token,requestId:input._operationId});
            if (response.state !== 'comments') return jsonPart(response);
            return await withDocument({file:listener.file}, async r => {
                const p=projectionOf(r.fsPath,r.text);
                const record={cells:[...new Map(response.comments.map(c => [c.cellId,c.cell])).values()],comments:response.comments};
                const {bindings}=reconcileRecord(record,p.model.objects);
                return jsonPart({...response,document_hash:sha256(r.text),buffer_version:r.doc?.version ?? null,reader_ranges:readerRanges(r.fsPath),
                    comments:response.comments.map(c => {
                        const obj=bindings.get(c.cellId), cell=c.cell;
                        const anchor=resolveCommentAnchor(r.fsPath,r.text,c,r.doc?.version);
                        if (anchor.editable_span) {
                            const span=anchor.editable_span;
                            if (readerConflict(r.fsPath,[{start:span.startOffset,end:span.endOffset}])) {
                                anchor.text_status=anchor.status; anchor.status='user-editing';
                            }
                        }
                        anchor.context_handle={tool:'paper_listenComments',action:'context',listener_id:listener.id,
                            delivery_id:response.delivery_id,comment_id:c.id};
                        const summary=obj ? summariseObject(obj,{includeText:true,maxText:8000}) : null;
                        const line=obj?.sourceRange.startLine || cell.line;
                        const location=c.selection ? selectionLocation(c.selection,obj?.text || cell.source,line)
                            : {line,endLine:obj?.sourceRange.endLine || cell.endLine};
                        if (input.projection !== 'full') {
                            const {context,equation_labels,line:anchorLine,endLine:anchorEnd,...guard}=anchor;
                            const budget=Math.floor(2000/response.comments.length);
                            if (guard.editable_span) {
                                const span=guard.editable_span;
                                guard.editable_span={...span,text:span.text.slice(0,budget),
                                    truncated:span.truncated || span.text.length > budget};
                            }
                            return {id:c.id,comment_hash:c.comment_hash,text:c.text.slice(0,budget),
                                ...(c.text.length > budget ? {text_truncated:true} : {}),
                                ...location,...(anchorLine ? {line:anchorLine,endLine:anchorEnd} : {}),detached:!obj,anchor:guard,
                                object:obj ? {objectId:obj.objectId,stableKey:obj.stableKey,kind:obj.kind,sourceHash:obj.sourceHash} : null};
                        }
                        return {id:c.id,comment_hash:c.comment_hash,text:c.text,author:c.author,
                            createdAt:c.createdAt,updatedAt:c.updatedAt,source:c.source,revision:c.revision,
                            selection:c.selection ? {...c.selection,quote:c.selection.quote.slice(0,8000)} : undefined,
                            quote:(c.selection?.quote || cell.source).slice(0,8000),
                            quoteTruncated:(c.selection?.quote || cell.source).length > 8000,
                            file:r.fsPath,...location, ...(anchor.line ? {line:anchor.line,endLine:anchor.endLine} : {}),detached:!obj,anchor,
                            object:summary,
                            next:anchor.editable_span ? 'Apply patches with delivery_id, expected_span_hash and verify:true; acknowledge:true optionally consumes this comment after verification. Open reader ranges take priority.'
                                : 'Resolve the missing or ambiguous exact quote before editing; never guess from an old line number.'};
                    })});
            });
        } catch (error) { return errPart(error.message || String(error)); }
    }
}

function acknowledgeCommentEdit(r, listenerId, deliveryId, operationId, commentIds) {
    const inbox=commentInbox();
    const replay=inbox.acknowledged(listenerId,deliveryId,operationId);
    if (replay) return replay;
    const {delivery}=inbox.claim(listenerId,deliveryId);
    const entry=_journal.find(e => e.operationId === operationId);
    if (!entry || entry.file !== r.fsPath || entry.action === 'undo' || entry.rolledBack ||
        !entry.verification?.ok || !entry.verification?.latex?.ok || Date.parse(entry.timestamp) < delivery.issued_at)
        return {state:'not-consumed',comments_deleted:0,
            reason:'A successful LaTeX-verified edit for this file after delivery is required; comments were preserved.'};
    if (sha256(r.text) !== entry.afterHash && !entry.effects?.every(e => e.unique && e.pattern &&
        r.text.indexOf(e.pattern) >= 0 && r.text.indexOf(e.pattern,r.text.indexOf(e.pattern)+1) < 0))
        return {state:'not-consumed',comments_deleted:0,reason:'The verified edit is no longer intact or uniquely identifiable.'};
    if (entry.commentClaim && entry.commentClaim.deliveryId !== deliveryId)
        return {state:'not-consumed',comments_deleted:0,reason:'This patch operation belongs to a different delivery.'};
    commentIds ||= entry.commentClaim?.commentIds;
    const comments=commentIds ? delivery.comments.filter(c => commentIds.includes(c.id)) : delivery.comments;
    const consumed=new CommentStore().consume(r.fsPath,comments);
    // A partial combined apply leaves unhandled comments in this delivery.
    if (consumed.ok && comments.length === delivery.comments.length) inbox.complete(listenerId,deliveryId);
    else inbox.release(listenerId,deliveryId);
    const receipt={...consumed,listener_id:listenerId,delivery_id:deliveryId,file:r.fsPath,operation_id:operationId};
    if (consumed.ok) inbox.rememberAcknowledgment(listenerId,deliveryId,operationId,receipt);
    return receipt;
}

async function withPaperWrite(r, fn) {
    const previous = _applyQueues.get(r.fsPath) || Promise.resolve();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    _applyQueues.set(r.fsPath, pending);
    await previous;
    try {
        if (r.doc) r.text = r.doc.getText();
        return await fn();
    } finally {
        release();
        if (_applyQueues.get(r.fsPath) === pending) _applyQueues.delete(r.fsPath);
    }
}

async function applyAgentWorkspaceEdit(r, edit, baseText, count) {
    announceAgentEdit({file:r.fsPath, baseText, phase:'begin', source:'paper_applyEdit'});
    try { return await vscode.workspace.applyEdit(edit); }
    finally { announceAgentEdit({file:r.fsPath, baseText, phase:'end', source:'paper_applyEdit',
        note:`${count} semantic edit${count === 1 ? '' : 's'}`}); }
}

function verificationOptions(verify) {
    if (verify === true) return { parse:true, references:true, latex:true, rollback_on_failure:true };
    if (verify === false) return { parse:false, references:false, latex:false, rollback_on_failure:false };
    if (verify != null && (typeof verify !== 'object' || Array.isArray(verify)))
        throw Error('verify must be a boolean or a verification options object');
    return { rollback_on_failure:true, ...(verify || {}) };
}

function separatedInsertion(text, at, fragment, paragraph = false) {
    if (!fragment) return fragment;
    const separator = paragraph ? '\n\n' : '\n';
    const left = text.slice(0, at), right = text.slice(at);
    if (left && !left.endsWith(separator) && !fragment.startsWith(separator)) fragment = separator + fragment;
    if (right && !right.startsWith(separator) && !fragment.endsWith(separator)) fragment += separator;
    return fragment;
}

function trimTransactions() {
    const now = Date.now();
    for (const [id, tx] of _transactions) if (now - tx.createdAt > TX_TTL_MS) _transactions.delete(id);
    while (_transactions.size > TX_MAX) _transactions.delete(_transactions.keys().next().value);
    while (_journal.length > 50) _journal.shift();
}

function lineCount(s) { return (String(s).match(/\n/g) || []).length + 1; }
function clipped(s, max = 1200) {
    s = String(s ?? '');
    if (s.length <= max) return s;
    const half = Math.max(100, Math.floor((max - 80) / 2));
    return s.slice(0, half) + `\n… (${s.length - half * 2} omitted chars) …\n` + s.slice(-half);
}

function changeSummary(beforeText, afterText) {
    return diffLines(splitLines(beforeText), splitLines(afterText)).map(h => ({
        kind: h.kind,
        beforeLines: `${h.aStart}-${Math.max(h.aStart, h.aEnd - 1)}`,
        afterLines: `${h.bStart}-${Math.max(h.bStart, h.bEnd - 1)}`,
        before: clipped(splitLines(beforeText).slice(h.aStart - 1, h.aEnd - 1).join('\n')),
        after: clipped(splitLines(afterText).slice(h.bStart - 1, h.bEnd - 1).join('\n')),
    }));
}

function deltaList(before, after, key) {
    const excess = (left, right) => {
        const counts = new Map();
        for (const x of right || []) counts.set(key(x), (counts.get(key(x)) || 0) + 1);
        return (left || []).filter(x => { const k = key(x), n = counts.get(k) || 0;
            if (!n) return true; counts.set(k, n - 1); return false; });
    };
    return {
        introduced: excess(after, before),
        resolved: excess(before, after),
    };
}

function projectionDelta(beforeProjection, afterProjection) {
    const beforeWarnings = beforeProjection.scan.warnings || [];
    const afterWarnings = afterProjection.scan.warnings || [];
    const warningDelta = deltaList(beforeWarnings, afterWarnings, warningKey);
    const beforeRefs = referenceHealth(beforeProjection.model);
    const afterRefs = referenceHealth(afterProjection.model);
    return {
        warnings: warningDelta,
        references: {
            unresolved: deltaList(beforeRefs.unresolvedRefs, afterRefs.unresolvedRefs,
                x => `${x.target}:${x.command}`),
            duplicates: duplicateDelta(beforeRefs.duplicateLabels, afterRefs.duplicateLabels),
            before: beforeRefs,
            after: afterRefs,
        },
    };
}

function duplicateDelta(before, after) {
    const a = new Map(before.map(x => [x.name, x.lines.length]));
    const b = new Map(after.map(x => [x.name, x.lines.length]));
    return {introduced:after.filter(x => x.lines.length > (a.get(x.name) || 1)),
        resolved:before.filter(x => x.lines.length > (b.get(x.name) || 1))};
}

function projectReferenceDelta(project, currentFile, beforeModel, afterModel) {
    const beforeObjects = []; const afterObjects = [];
    let sawCurrent = false;
    for (const projection of project.projections) {
        if (projection.fsPath === currentFile) {
            beforeObjects.push(...beforeModel.objects);
            afterObjects.push(...afterModel.objects);
            sawCurrent = true;
        } else {
            beforeObjects.push(...projection.model.objects);
            afterObjects.push(...projection.model.objects);
        }
    }
    if (!sawCurrent) {
        beforeObjects.push(...beforeModel.objects);
        afterObjects.push(...afterModel.objects);
    }
    const before = referenceHealth({ objects: beforeObjects });
    const after = referenceHealth({ objects: afterObjects });
    return {
        unresolved: deltaList(before.unresolvedRefs, after.unresolvedRefs,
            x => `${x.target}:${x.command}`),
        duplicates: duplicateDelta(before.duplicateLabels, after.duplicateLabels),
        before, after,
    };
}

function sectionEndOffset(model, text, head) {
    const headings = model.objects.filter(o => o.kind === 'section-heading');
    const i = headings.indexOf(head);
    const next = headings.slice(i + 1).find(o => (o.level ?? 0) <= (head.level ?? 0));
    // Trailing material and the document terminator are not section content.
    const bodyEnd = model.bodyEndOffset ?? text.length;
    return Math.min(next ? next.sourceRange.startOffset : text.length, bodyEnd);
}

function oneObject(model, selector) {
    const matches = findObjects(model, selector);
    if (!matches.length) return { error: { state: 'not-found', selector: String(selector) } };
    if (matches.length > 1) return { error: ambiguousSelection(selector, matches) };
    return { object: matches[0] };
}

function editGuard(obj, text, edit) {
    return texMutationConflict(obj, text, {
        expected_source_hash: edit.expected_source_hash,
        expected_object_id: edit.expected_object_id,
        expected_stable_key: edit.expected_stable_key,
        expected_source_prefix: edit.expected_source_prefix,
    });
}

function planPaperTransaction(r, input) {
    const beforeProjection = projectionOf(r.fsPath, r.text);
    const model = beforeProjection.model;
    let transactionProject = null;
    const getProject = () => (transactionProject ||= projectProjections(r));
    const legacy = !Array.isArray(input.edits);
    const edits = legacy ? [{
        operation: 'replace', selector: input.selector, new_text: input.new_text,
        expected_source_hash: input.expected_source_hash,
        expected_object_id: input.expected_object_id,
        expected_stable_key: input.expected_stable_key,
        expected_source_prefix: input.expected_source_prefix,
    }] : input.edits;
    if (!edits.length) return { error: { state: 'invalid', reason: '`edits` must not be empty' } };
    if (input.expected_document_hash && String(input.expected_document_hash).toLowerCase() !== sha256(r.text)) {
        return { error: { state: 'conflict', reason: 'the document changed since preview',
            document_hash: sha256(r.text) } };
    }

    const changes = [];
    const summaries = [];
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i] || {};
        for (const key of ['new_text', 'prefix', 'suffix', 'environment', 'new', 'new_label']) {
            if (typeof edit[key] === 'string' && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(edit[key]))
                return { error:{ state:'invalid', edit:i, reason:`${key} contains a control character; send the literal LaTeX with JSON-escaped backslashes` } };
        }
        const op = edit.operation || 'replace';
        if (op === 'rename_label') {
            const oldName = String(edit.old || edit.selector || '');
            const newName = String(edit.new || edit.new_label || '');
            if (!oldName || !newName) return { error: { state: 'invalid', edit: i,
                reason: 'rename_label requires `old` and `new`' } };
            if (/[\\{}%,\s]/.test(newName)) return { error:{ state:'invalid', edit:i,
                reason:'new label must be a literal key without whitespace, commas, braces, comments or commands' } };
            if (model.objects.some(o => o.kind === 'label' && o.name === newName)) {
                return { error: { state: 'conflict', edit: i, reason: `label ${newName} already exists` } };
            }
            const declaration = model.objects.find(o => o.kind === 'label' && o.name === oldName);
            if (!declaration) return { error: { state: 'not-found', edit: i, selector: oldName } };
            const project = getProject();
            const external = project.projections
                .filter(p => p.fsPath !== r.fsPath)
                .flatMap(p => p.model.objects);
            const externalRefs = external.filter(o => o.kind === 'ref' && o.target === oldName);
            const externalCollision = external.find(o => o.kind === 'label' && o.name === newName);
            if (externalCollision || externalRefs.length) {
                return { error: { state: 'cross-file-required', edit: i,
                    reason: externalCollision
                        ? `label ${newName} already exists elsewhere in the project`
                        : `label ${oldName} has references in other project files`,
                    locations: [externalCollision, ...externalRefs].filter(Boolean).slice(0, 30)
                        .map(o => ({ file: o.sourceRange.file, line: o.sourceRange.startLine,
                            kind: o.kind, command: o.cmd })),
                    remedy: 'cross-file paper transactions are not yet supported; no partial rename was made' } };
            }
            const conflict = texMutationConflict(declaration, r.text, {
                expected_source_hash: edit.expected_declaration_hash || edit.expected_source_hash,
            });
            if (conflict) return { error: { ...conflict, edit: i } };
            const targets = model.objects.filter(o =>
                (o.kind === 'label' && o.name === oldName) ||
                (edit.update_internal_references !== false && o.kind === 'ref' && o.target === oldName));
            const seen = new Set();
            for (const target of targets) {
                const rangeKey = `${target.sourceRange.startOffset}:${target.sourceRange.endOffset}`;
                if (seen.has(rangeKey)) continue;
                seen.add(rangeKey);
                const before = r.text.slice(target.sourceRange.startOffset, target.sourceRange.endOffset);
                const after = before.replace(/\{([^{}]*)\}$/, (whole, arg) => '{' + arg.split(',')
                    .map(part => part.trim() === oldName ? part.replace(oldName, () => newName) : part).join(',') + '}');
                if (after === before) return { error:{ state:'invalid', edit:i,
                    reason:`cannot safely locate the label argument in ${before}` } };
                changes.push({ start: target.sourceRange.startOffset, end: target.sourceRange.endOffset,
                    text: after, before, editIndex: i, operation: op });
            }
            summaries.push({ index: i, operation: op, old: oldName, new: newName,
                changedLocations: targets.length });
            continue;
        }

        const found = oneObject(model, edit.selector);
        if (found.error) return { error: { ...found.error, edit: i } };
        const obj = found.object;
        const conflict = editGuard(obj, r.text, edit);
        if (conflict) return { error: { ...conflict, edit: i } };
        const start = obj.sourceRange.startOffset;
        const end = obj.sourceRange.endOffset;
        const before = r.text.slice(start, end);

        if (op === 'replace') {
            if (typeof edit.new_text !== 'string') return { error: { state: 'invalid', edit: i,
                reason: 'replace requires `new_text`' } };
            changes.push({ start, end, text: edit.new_text, before, editIndex: i, operation: op });
        } else if (op === 'delete') {
            changes.push({ start, end, text: '', before, editIndex: i, operation: op });
        } else if (op === 'insert_before' || op === 'insert_after') {
            if (typeof edit.new_text !== 'string') return { error: { state: 'invalid', edit: i,
                reason: `${op} requires \`new_text\`` } };
            const at = op === 'insert_before' ? start : end;
            changes.push({ start: at, end: at, text: separatedInsertion(r.text, at, edit.new_text), before: '', editIndex: i, operation: op });
        } else if (op === 'append_to_section') {
            if (obj.kind !== 'section-heading') return { error: { state: 'invalid', edit: i,
                reason: 'append_to_section selector must resolve to a section heading' } };
            if (typeof edit.new_text !== 'string') return { error: { state: 'invalid', edit: i,
                reason: 'append_to_section requires `new_text`' } };
            const at = sectionEndOffset(model, r.text, obj);
            changes.push({ start: at, end: at, text: separatedInsertion(r.text, at, edit.new_text), before: '', editIndex: i, operation: op });
        } else if (op === 'move_before' || op === 'move_after') {
            const targetFound = oneObject(model, edit.target_selector);
            if (targetFound.error) return { error: { ...targetFound.error, edit: i, role: 'target' } };
            const target = targetFound.object;
            const at = op === 'move_before' ? target.sourceRange.startOffset : target.sourceRange.endOffset;
            if (at >= start && at <= end) return { error: { state: 'invalid', edit: i,
                reason: 'cannot move an object into itself' } };
            changes.push({ start, end, text: '', before, editIndex: i, operation: op });
            changes.push({ start: at, end: at, text: separatedInsertion(r.text, at, before, obj.kind === 'paragraph'), before: '', editIndex: i, operation: op });
        } else if (op === 'wrap') {
            const endFound = edit.end_selector ? oneObject(model, edit.end_selector) : { object: obj };
            if (endFound.error) return { error: { ...endFound.error, edit: i, role: 'end' } };
            const last = endFound.object;
            if (last.sourceRange.endOffset < start) return { error: { state: 'invalid', edit: i,
                reason: 'wrap end precedes start' } };
            const rangeText = r.text.slice(start, last.sourceRange.endOffset);
            const prefix = edit.prefix ?? (edit.environment ? `\\begin{${edit.environment}}\n` : '');
            const suffix = edit.suffix ?? (edit.environment ? `\n\\end{${edit.environment}}` : '');
            changes.push({ start, end: last.sourceRange.endOffset, text: prefix + rangeText + suffix,
                before: rangeText, editIndex: i, operation: op });
        } else {
            return { error: { state: 'invalid', edit: i, reason: `unknown operation ${op}` } };
        }
        summaries.push({ index: i, operation: op, selector: edit.selector,
            stableKey: obj.stableKey, sourceHash: sha256(before) });
    }

    return finishPaperPlan(r, {legacy, edits, changes, summaries, beforeProjection}, getProject);
}

function finishPaperPlan(r, {legacy=false, edits, changes, summaries, beforeProjection}, getProject=() => projectProjections(r)) {
    const model=beforeProjection.model, deletedLabels=[];
    const ordered = [...changes].sort((a, b) => b.start - a.start || b.end - a.end || b.editIndex - a.editIndex);
    for (let i = 0; i < ordered.length - 1; i++) {
        const right = ordered[i]; const left = ordered[i + 1];
        if (left.end > right.start && !(left.start === left.end && left.start === right.start)) {
            return { error: { state: 'conflict', reason: 'transaction edits overlap',
                edits: [left.editIndex, right.editIndex] } };
        }
    }
    let nextText = r.text;
    for (const change of ordered) {
        nextText = nextText.slice(0, change.start) + change.text + nextText.slice(change.end);
    }
    const afterProjection = projectionOf(r.fsPath, nextText);
    const delta = projectionDelta(beforeProjection, afterProjection);
    delta.references = projectReferenceDelta(getProject(), r.fsPath,
        beforeProjection.model, afterProjection.model);
    // A multi-row align owns several labels. Replacement can remove them too.
    for (const label of model.objects.filter(o => o.kind === 'label')) {
        if (afterProjection.model.objects.some(o => o.kind === 'label' && o.name === label.name)) continue;
        const change = changes.find(c => c.start < label.sourceRange.endOffset && c.end > label.sourceRange.startOffset ||
            c.start === c.end && c.start > label.sourceRange.startOffset && c.start < label.sourceRange.endOffset);
        if (change) deletedLabels.push({name:label.name, editIndex:change.editIndex});
    }
    for (const deleted of deletedLabels) {
        const stillReferenced = afterProjection.model.objects.some(o => o.kind === 'ref' && o.target === deleted.name);
        const project = getProject();
        const externalRefs = project.projections.filter(p => p.fsPath !== r.fsPath)
            .flatMap(p => p.model.objects)
            .filter(o => o.kind === 'ref' && o.target === deleted.name);
        if ((stillReferenced || externalRefs.length) && !edits[deleted.editIndex].allow_referenced) {
            return { error: { state: 'conflict', edit: deleted.editIndex,
                reason: `cannot delete labelled object ${deleted.name} while references remain`,
                externalReferences: externalRefs.slice(0, 30).map(o => ({
                    file: o.sourceRange.file, line: o.sourceRange.startLine, command: o.cmd,
                })),
                remedy: 'include edits that remove/update its references, or set allow_referenced:true explicitly' } };
        }
    }
    return { legacy, edits, changes, summaries, beforeProjection, afterProjection,
        beforeText: r.text, afterText: nextText, delta };
}

function planCommentPatches(r, input) {
    if (!Array.isArray(input.patches) || !input.patches.length || input.patches.length > 20)
        return {error:{state:'invalid',reason:'patches must contain 1–20 guarded replacements'}};
    if (input.edits || input.selector || input.transaction_id)
        return {error:{state:'invalid',reason:'Do not mix patches with semantic edits or preview transactions'}};
    if (input.expected_document_hash && input.expected_document_hash !== sha256(r.text))
        return {error:{state:'conflict',reason:'document hash changed',document_hash:sha256(r.text)}};
    let claim;
    if (input.delivery_id) {
        try { claim=commentInbox().claimDelivery(input.delivery_id,r.fsPath); }
        catch (error) { return {error:{state:'conflict',reason:error.message}}; }
    } else if (input.acknowledge) return {error:{state:'invalid',reason:'acknowledge requires delivery_id'}};
    const changes=[], summaries=[], commentIds=new Set();
    const currentComments=claim ? new CommentStore().read(r.fsPath).comments : [];
    for (let i=0;i<input.patches.length;i++) {
        const p=input.patches[i];
        if (!p || typeof p.expected_old_text !== 'string' || !p.expected_old_text || typeof p.replacement !== 'string' ||
            typeof p.expected_span_hash !== 'string') return {error:{state:'invalid',edit:i,
                reason:'Each patch requires nonempty expected_old_text, replacement and expected_span_hash'}};
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(p.replacement))
            return {error:{state:'invalid',edit:i,reason:'replacement contains a control character; use JSON-escaped LaTeX backslashes'}};
        let scope=r.text, base=0;
        if (claim) {
            const candidates=claim.delivery.comments.filter(c => !p.comment_id || p.comment_id === c.id).map(c =>
                ({comment:c,anchor:resolveCommentAnchor(r.fsPath,r.text,c,r.doc?.version)})).filter(({anchor}) =>
                anchor.editable_span?.source_hash === p.expected_span_hash &&
                r.text.slice(anchor.editable_span.startOffset,anchor.editable_span.endOffset).includes(p.expected_old_text));
            if (candidates.length !== 1) return {error:{state:'conflict',edit:i,
                reason:'The delivered source span is missing, ambiguous, or changed; call next/context again.',
                anchors:claim.delivery.comments.map(c => ({comment_id:c.id,...resolveCommentAnchor(r.fsPath,r.text,c,r.doc?.version)}))}};
            const {comment,anchor}=candidates[0];
            if (!currentComments.some(c => c.id === comment.id && commentHash(c) === comment.comment_hash))
                return {error:{state:'conflict',edit:i,reason:'The comment was edited or deleted; no edit was applied.'}};
            base=anchor.editable_span.startOffset;scope=r.text.slice(base,anchor.editable_span.endOffset);
            commentIds.add(comment.id);
        } else if (sha256(p.expected_old_text) !== p.expected_span_hash)
            return {error:{state:'conflict',edit:i,reason:'expected_span_hash must match the exact expected_old_text when no delivery is supplied'}};
        const found=uniqueOffset(scope,p.expected_old_text);
        if (found.state !== 'unique') return {error:{state:'conflict',edit:i,anchor_status:found.state,
            reason:'The exact expected_old_text must occur once in the guarded span; no edit was applied.'}};
        const change=changedRange(base+found.start,p.expected_old_text,p.replacement);
        if (!change.before && !change.text) return {error:{state:'invalid',edit:i,reason:'Patch makes no change'}};
        changes.push({...change,editIndex:i,operation:'patch'});
        summaries.push({index:i,operation:'patch',comment_id:p.comment_id,
            startOffset:change.start,endOffset:change.end,sourceHash:sha256(p.expected_old_text)});
    }
    const plan=finishPaperPlan(r,{edits:input.patches,changes,summaries,beforeProjection:projectionOf(r.fsPath,r.text)});
    if (!plan.error && claim) plan.commentClaim={listenerId:claim.listener.id,deliveryId:input.delivery_id,commentIds:[...commentIds]};
    return plan;
}

function storeTransaction(r, plan, verify) {
    trimTransactions();
    const id = `paper_tx_${crypto.randomUUID()}`;
    const start = Math.min(...plan.changes.map(c => c.start));
    const end = Math.max(...plan.changes.map(c => c.end));
    const afterEnd = plan.afterText.length - (plan.beforeText.length - end);
    _transactions.set(id, {
        id, file: r.fsPath, createdAt: Date.now(), beforeText: plan.beforeText,
        beforeHash: sha256(plan.beforeText), afterText: plan.afterText,
        afterHash: sha256(plan.afterText), summaries: plan.summaries, delta: plan.delta,
        replaceStart: start, replaceEnd: end,
        replacementText: plan.afterText.slice(start, afterEnd),
        changes: coalesceChanges(plan.changes),
        verify: verify ?? null,
    });
    return id;
}

// Keep disjoint replacements disjoint in the WorkspaceEdit. Replacing the
// entire span between two edits swallowed unrelated open mini-editors and
// forced the incremental engine to reprocess otherwise unchanged paragraphs.
function coalesceChanges(changes) {
    const out=[];
    for (const c of [...changes].sort((a,b) => a.start-b.start || a.end-b.end || a.editIndex-b.editIndex)) {
        const previous=out.at(-1);
        if (previous && previous.end===c.start) {
            previous.end=c.end; previous.text+=c.text; previous.before+=c.before;
        } else out.push({...c});
    }
    return out;
}

function workspaceForChanges(r, changes) {
    const edit=new vscode.WorkspaceEdit();
    for (const c of [...changes].sort((a,b) => b.start-a.start)) edit.replace(r.doc.uri,
        new vscode.Range(r.doc.positionAt(c.start),r.doc.positionAt(c.end)),c.text);
    return edit;
}

function reverseChanges(changes) {
    let delta=0;
    return [...changes].sort((a,b) => a.start-b.start).map(c => {
        const start=c.start+delta;
        delta+=c.text.length-(c.end-c.start);
        return {start,end:start+c.text.length,text:c.before,before:c.text};
    });
}

function changeEffects(text, changes) {
    let delta=0;
    return [...changes].sort((a,b) => a.start-b.start).map(c => {
        const start=c.start+delta;
        delta+=c.text.length-(c.end-c.start);
        let pattern=c.text;
        const unique=p => !!p && text.indexOf(p) >= 0 && text.indexOf(p,text.indexOf(p)+1) < 0;
        if (!unique(pattern)) pattern=text.slice(Math.max(0,start-48),Math.min(text.length,start+c.text.length+48));
        return {pattern,unique:unique(pattern)};
    });
}

async function verifyAppliedPaper(r, beforeProjection, verify = {}) {
    const afterText = r.doc.getText();
    const afterProjection = projectionOf(r.fsPath, afterText);
    const delta = projectionDelta(beforeProjection, afterProjection);
    delta.references = projectReferenceDelta(projectProjections(r), r.fsPath,
        beforeProjection.model, afterProjection.model);
    const out = {
        parse: verify.parse === false ? undefined : {
            ok: delta.warnings.introduced.length === 0,
            introducedWarnings: delta.warnings.introduced,
            resolvedWarnings: delta.warnings.resolved,
        },
        references: verify.references === false ? undefined : {
            ok: delta.references.unresolved.introduced.length === 0 &&
                delta.references.duplicates.introduced.length === 0,
            ...delta.references,
        },
    };
    if (verify.latex) {
        const project = projectProjections({ ...r, text:afterText });
        const rootInfo = project.root, graph = project.graph;
        const overlay = new Map();
        for (const doc of texDocuments()) overlay.set(doc.uri.fsPath, doc.getText());
        overlay.set(r.fsPath, afterText);
        const built = await compile({
            root: rootInfo.root, sourceFiles: graph.files, overlay,
            // Verification must not queue ahead of the reader's cold rebuild,
            // replace its PDF/aux files, or occupy its compile gate.
            outDir:path.join(os.tmpdir(),'wolfbook-paper-verification',sha256(rootInfo.root).slice(0,20)),
            engine: verify.engine || paperCompileEngine(overlay.get(rootInfo.root) || fs.readFileSync(rootInfo.root, 'utf8'),
                vscode.workspace.getConfiguration('wolfbook.tex').get('engine', 'pdflatex')), force: true,
            timeoutMs: verify.timeout_ms || 180000,
        });
        out.latex = {
            ok: built.ok === true && !(Array.isArray(built.errors) ? built.errors.length : built.errors) && !built.stopped && !built.stopReason &&
                !built.diagnostics?.some(d => d.severity === 'error'), engine: built.engine, exit: built.exit, errors: built.errors,
            warnings: built.warnings, stopped: built.stopped, stopReason: built.stopReason,
            pdfPath: built.pdfPath, pdfBytes: built.pdfBytes, pdfHash: built.pdfHash,
            logPath: built.logPath, durationMs: built.ms,
            diagnostics: (built.diagnostics || []).slice(0, 30),
            dependencyIssue: built.dependencyIssue,
        };
    }
    out.ok = (!out.parse || out.parse.ok) && (!out.references || out.references.ok) &&
        (!out.latex || out.latex.ok);
    return out;
}

class PaperPreviewEditTool {
    async prepareInvocation(options) {
        const n = options.input?.edits?.length;
        return { invocationMessage: n ? `Preview ${n} paper edits` : `Preview edit: ${options.input?.selector || '?'}` };
    }
    async invoke(options) {
        const input = options.input || {};
        if (!Array.isArray(input.edits) && !input.selector) return errPart('`selector` or `edits` is required');
        if (!Array.isArray(input.edits) && typeof input.new_text !== 'string') return errPart('`new_text` is required');
        return withDocument(input, async (r) => {
            const plan = planPaperTransaction(r, input);
            if (plan.error) return jsonPart(plan.error);
            const transactionId = storeTransaction(r, plan, input.verify);
            const out = {
                applied: false,
                transaction_id: transactionId,
                documentHash: sha256(plan.beforeText),
                nextDocumentHash: sha256(plan.afterText),
                editCount: plan.edits.length,
                edits: plan.summaries,
                lineDelta: lineCount(plan.afterText) - lineCount(plan.beforeText),
                diff: changeSummary(plan.beforeText, plan.afterText),
                warningDelta: plan.delta.warnings,
                referenceDelta: plan.delta.references,
                howToApply: 'call paper_applyEdit with transaction_id; it applies atomically only if the document hash still matches',
            };
            if (plan.legacy && plan.changes.length === 1) {
                const change = plan.changes[0];
                const obj = oneObject(plan.beforeProjection.model, input.selector).object;
                out.object = summariseObject(obj);
                out.sourceHash = sha256(change.before);
                out.before = change.before;
                out.after = change.text;
                out.nextSourceHash = sha256(change.text);
                out.introducesWarnings = plan.delta.warnings.introduced;
            }
            return jsonPart(out);
        });
    }
}

class PaperApplyEditTool {
    async prepareInvocation(options) {
        const input = options.input || {};
        if (input.action === 'history') return { invocationMessage: 'Paper edit history' };
        const n = input.edits?.length || 1;
        return {
            invocationMessage: input.action === 'undo' ? 'Undo paper transaction' :
                `Apply ${n} paper edit${n === 1 ? '' : 's'} atomically`,
            confirmationMessages: {
                title: 'Apply edit to .tex',
                message: new vscode.MarkdownString(
                    `${input.action === 'undo' ? 'Undo the selected transaction' : `Apply ${n} semantic edit${n === 1 ? '' : 's'}`} in ` +
                    `\`${path.basename(input.file || 'the active .tex')}\`?`),
            },
        };
    }
    async invoke(options) {
        const input = options.input || {};
        trimTransactions();
        if (input.action === 'history') {
            const limit = Math.max(1, Math.min(50, Number(input.limit || 10)));
            return jsonPart({ entries: _journal.slice(-limit).reverse().map(entry => ({
                operationId: entry.operationId, transactionId: entry.transactionId,
                undoToken: entry.undoToken, file: entry.file, timestamp: entry.timestamp,
                edits: entry.edits, beforeHash: entry.beforeHash, afterHash: entry.afterHash,
                verification: entry.verification, rolledBack: entry.rolledBack,
            })) });
        }
        if (input.delivery_id && !input.file && Array.isArray(input.patches)) {
            try { input.file=commentInbox().claimDelivery(input.delivery_id).listener.file; }
            catch (error) { return jsonPart({state:'conflict',reason:error.message}); }
        }
        if (input.acknowledge && (!input.delivery_id || !Array.isArray(input.patches)))
            return jsonPart({state:'invalid',reason:'Combined acknowledgment requires patches and delivery_id'});
        if (input.transaction_id && Array.isArray(input.patches))
            return jsonPart({state:'invalid',reason:'Do not mix patches and a preview transaction'});
        if (input.transaction_id && !input.file) {
            const stored = _transactions.get(String(input.transaction_id));
            if (stored) input.file = stored.file;
        }
        if (input.action === 'undo' && input.undo_token && !input.file) {
            const entry = _journal.find(x => x.undoToken === String(input.undo_token));
            if (entry) input.file = entry.file;
        }
        if (!input.transaction_id && input.action !== 'undo' && !Array.isArray(input.edits) && !Array.isArray(input.patches) && !input.selector) {
            return errPart('`transaction_id`, `selector`, `edits`, or `patches` is required');
        }
        if (!input.transaction_id && input.action !== 'undo' && !Array.isArray(input.edits) && !Array.isArray(input.patches) &&
            typeof input.new_text !== 'string') return errPart('`new_text` is required');

        return withDocument(input, async (r) => withPaperWrite(r, async () => {
            if (!r.doc) {
                // Open a buffer in THIS host, never via the OS or a different
                // window. Refresh source before stale-hash validation below.
                r.doc = await vscode.workspace.openTextDocument(r.uri);
                r.text = r.doc.getText();
            }
            let tx;
            let beforeProjection;
            let legacy = false;
            let unguarded = false;
            let commentClaim;

            if (input.action === 'undo') {
                const undoToken = String(input.undo_token || '');
                const entry = _journal.find(x => x.undoToken === undoToken);
                if (!entry) return jsonPart({ state: 'not-found', reason: 'unknown or expired undo token' });
                if (entry.file !== r.fsPath) return jsonPart({ state: 'conflict', reason: 'undo token belongs to another file' });
                if (sha256(r.text) !== entry.afterHash) return jsonPart({ state: 'conflict',
                    reason: 'the document changed since this transaction; undo was not applied',
                    document_hash: sha256(r.text), expected_hash: entry.afterHash });
                tx = { id: `undo_${entry.operationId}`, file: entry.file, beforeText: r.text,
                    beforeHash: entry.afterHash, afterText: entry.beforeText,
                    afterHash: entry.beforeHash, summaries: [{ operation: 'undo', operationId: entry.operationId }],
                    replaceStart: 0, replaceEnd: r.text.length, replacementText: entry.beforeText };
                if (entry.changes) tx.changes=reverseChanges(entry.changes);
                beforeProjection = projectionOf(r.fsPath, r.text);
            } else if (input.transaction_id) {
                tx = _transactions.get(String(input.transaction_id));
                if (!tx) return jsonPart({ state: 'not-found', reason: 'unknown or expired transaction_id; preview again' });
                if (tx.file !== r.fsPath) return jsonPart({ state: 'conflict', reason: 'transaction belongs to another file' });
                if (sha256(r.text) !== tx.beforeHash) return jsonPart({ state: 'conflict',
                    reason: 'the document changed since preview; nothing was applied',
                    document_hash: sha256(r.text), expected_hash: tx.beforeHash });
                beforeProjection = projectionOf(r.fsPath, r.text);
            } else {
                const plan = Array.isArray(input.patches) ? planCommentPatches(r,input) : planPaperTransaction(r, input);
                if (plan.error) return jsonPart(plan.error);
                const id = storeTransaction(r, plan, input.verify ?? (Array.isArray(input.patches) ? true : undefined));
                tx = _transactions.get(id);
                beforeProjection = plan.beforeProjection;
                legacy = plan.legacy;
                commentClaim=plan.commentClaim;
                unguarded = !Array.isArray(input.patches) && plan.edits.some(e => e.expected_source_hash == null &&
                    e.expected_object_id == null && e.expected_stable_key == null &&
                    (e.operation || 'replace') !== 'rename_label');
            }

            // THE FILE MAY HAVE MOVED SINCE IT WAS READ.
            //
            // The hash guard above proves the OBJECT still looks the way the
            // agent last saw it. It says nothing about the rest of the file, or
            // about a copy on disk that Dropbox or a collaborator replaced
            // while the agent was thinking. An edit computed against content
            // that is no longer there silently discards whatever arrived in
            // between, so disk is checked before anything is written.
            let diskText = null;
            try { diskText = fs.readFileSync(r.fsPath, 'utf8'); } catch (_) { diskText = null; }
            const writable = checkWritable({
                diskText,
                baseText: r.doc.isDirty ? diskText : r.text,
                isDirty: r.doc.isDirty,
                willSave: !!input.save,
            });
            if (!writable.ok) {
                return jsonPart({
                    conflict: 'file-changed-on-disk',
                    file: r.fsPath,
                    reason: writable.reason,
                    disk_hash: writable.diskHash,
                    hint: 'Re-read the file (paper_getObject / paper_getOutline) and redo the ' +
                        'edit against the current content.',
                });
            }

            const verifyOptions = verificationOptions(input.verify ?? tx.verify ?? (input.action === 'undo' ? false : undefined));
            const changes=tx.changes || [{start:tx.replaceStart,end:tx.replaceEnd,text:tx.replacementText,
                before:r.text.slice(tx.replaceStart,tx.replaceEnd)}];
            const busy=readerConflict(r.fsPath,changes);
            if (busy) return jsonPart({...busy,buffer_version:r.doc.version,
                affected_ranges:changes.map(c => ({startOffset:c.start,endOffset:c.end,current_source:r.text.slice(c.start,c.end).slice(0,1000)}))});
            const we=workspaceForChanges(r,changes);
            const applied = await applyAgentWorkspaceEdit(r, we, r.text, tx.summaries.length);
            if (!applied) return jsonPart(readerConflict(r.fsPath,changes) || {state:'conflict',file:r.fsPath,
                reason:'WorkspaceEdit was rejected by the editor; no verified edit or acknowledgment was made.',
                buffer_version:r.doc.version,document_hash:sha256(r.doc.getText()),
                ranges:changes.map(c => ({startOffset:c.start,endOffset:c.end,current_source:r.doc.getText().slice(c.start,c.end).slice(0,8000)})),
                remedy:'Refresh the guarded source span and retry after the conflicting draft closes.'});

            const appliedText = r.doc.getText();
            const appliedHash = sha256(appliedText);
            let verification;
            try { verification = await verifyAppliedPaper(r, beforeProjection, verifyOptions); }
            catch (error) { verification = {ok:false, error:error.message || String(error)}; }
            let rolledBack = false;
            let sourceConflict = sha256(r.doc.getText()) !== appliedHash;
            if (!verification.ok && verifyOptions.rollback_on_failure) {
                if (!sourceConflict) {
                    const rollback=workspaceForChanges(r,reverseChanges(changes));
                    rolledBack = await applyAgentWorkspaceEdit(r, rollback, appliedText, 1);
                } else verification.rollbackSkipped = 'the buffer changed during verification; newer edits were preserved';
            }
            let saved = false;
            if (!rolledBack && verification.ok && !sourceConflict && input.save) {
                // Recheck disk after an asynchronous compile, not just before it.
                let currentDisk = null;
                try { currentDisk = fs.readFileSync(r.fsPath, 'utf8'); } catch (_) {}
                if (currentDisk !== diskText) sourceConflict = true;
                else try { saved = await r.doc.save() === true; } catch (_) { /* receipt reports unsaved */ }
            }

            const after = r.doc.getText();
            const operationId = `paper_edit_${crypto.randomUUID()}`;
            const undoToken = rolledBack ? undefined : `paper_undo_${crypto.randomUUID()}`;
            const entry = {
                operationId, transactionId: tx.id, undoToken, file: r.fsPath,
                timestamp: new Date().toISOString(), edits: tx.summaries,
                beforeHash: tx.beforeHash, afterHash: rolledBack ? sha256(after) : appliedHash,
                beforeText: tx.beforeText, verification, rolledBack,
                action:input.action || 'apply', sourceConflict,
                changes, commentClaim,
                effects:changeEffects(appliedText,changes),
            };
            _journal.push(entry);
            if (input.transaction_id) _transactions.delete(String(input.transaction_id));

            const result = {
                state: sourceConflict ? 'source-changed-during-verification' : rolledBack ? 'rolled-back' :
                    verification.ok ? 'applied' : 'verification-failed',
                applied: !rolledBack,
                rolledBack: rolledBack || undefined,
                operation_id: operationId,
                transaction_id: tx.id,
                undo_token: undoToken,
                editCount: tx.summaries.length,
                edits: tx.summaries,
                previous_document_hash: tx.beforeHash,
                document_hash: sha256(after),
                verification_document_hash: appliedHash,
                saved,
                source_conflict: sourceConflict || undefined,
                unguarded: unguarded || undefined,
                unguarded_note: unguarded
                    ? 'applied WITHOUT a hash guard — pass expected_source_hash next time so a ' +
                      'stale edit is rejected rather than overwriting someone else\'s change'
                    : undefined,
                verification,
            };
            if (input.acknowledge && commentClaim) {
                r.text=after;
                try { result.acknowledgment=acknowledgeCommentEdit(r,commentClaim.listenerId,commentClaim.deliveryId,operationId,commentClaim.commentIds); }
                catch (error) { result.acknowledgment={state:'not-consumed',comments_deleted:0,reason:error.message}; }
            }
            if (legacy && tx.summaries.length === 1) {
                result.stable_key = tx.summaries[0].stableKey;
                result.new_source_hash = sha256(input.new_text);
                result.introducesWarnings = verification.parse?.introducedWarnings?.length
                    ? verification.parse.introducedWarnings : undefined;
            }
            return jsonPart(result);
        }));
    }
}

module.exports = {
    PaperGetOutlineTool,
    PaperGetObjectTool,
    PaperGetSectionTool,
    PaperFindReferencesTool,
    PaperSearchTool,
    PaperMathematicaBlocksTool,
    PaperPreviewEditTool,
    PaperApplyEditTool,
    PaperListenCommentsTool,
    // exported for tests
    texMutationConflict,
    findObject,
    projectionOf,
    resolveTexDocument,
};
