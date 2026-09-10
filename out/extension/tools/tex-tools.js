// tex-tools.js — the `paper_*` LM/MCP tool surface for .tex documents.
//
// Registered from tools/index.js exactly like wolfslide-tools.js: classes with
// prepareInvocation/invoke, added to the `tools` array, declared in
// package.json contributes.languageModelTools.
//
// STAGE 1 SCOPE: read the projection, and mutate it under a hash guard.
// No rendering, no compiling, no execution of managed blocks.
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
const { diffLines, splitLines } = require('../tex/texDiff');
const fs = require('fs');

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
    const sameBase = open.filter(d => path.basename(d.uri.fsPath) === base);
    if (sameBase.length === 1) return wrap(sameBase[0]);
    if (sameBase.length > 1) return { ambiguous: sameBase.map(d => d.uri.fsPath) };

    // Not open: read from disk, still without opening an editor.
    const candidates = [];
    if (path.isAbsolute(want)) candidates.push(vscode.Uri.file(want));
    for (const folder of vscode.workspace.workspaceFolders || []) {
        candidates.push(vscode.Uri.joinPath(folder.uri, want));
        if (!/\.tex$/i.test(want)) candidates.push(vscode.Uri.joinPath(folder.uri, want + '.tex'));
    }
    for (const uri of candidates) {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            return { doc: null, uri, fsPath: uri.fsPath, text: Buffer.from(bytes).toString('utf8') };
        } catch (_) { /* next */ }
    }
    return null;
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
    const root = findRoot(r.fsPath, deps);
    const graph = buildGraph(root.root, deps);
    const openByPath = new Map(texDocuments().map(doc => [doc.uri.fsPath, doc.getText()]));
    openByPath.set(r.fsPath, r.text);
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
    return typeof w === 'string' ? w : JSON.stringify(w);
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
        if (!input.selector) return errPart('`selector` is required (an objectId, stableKey, or \\label)');
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
            const to = end ? end.sourceRange.startOffset : r.text.length;

            const contained = model.objects.filter(o =>
                o.sourceRange.startOffset >= from && o.sourceRange.endOffset <= to &&
                ADDRESSABLE.has(o.kind) && o !== head);

            return jsonPart({
                file: r.fsPath,
                section: summariseObject(head),
                startLine: head.sourceRange.startLine,
                endLine: end ? end.sourceRange.startLine - 1 : r.text.split('\n').length,
                objects: contained.map(o => summariseObject(o)),
                text: input.include_text
                    ? r.text.slice(from, Math.min(to, from + (input.max_chars ?? 8000)))
                    : undefined,
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
                const hits = [];
                for (const o of allObjects) {
                    if (kinds ? !kinds.has(o.kind) : !ADDRESSABLE.has(o.kind)) continue;
                    if (sectionFile && o.sourceRange.file !== sectionFile) continue;
                    if (o.sourceRange.startLine < fromLine || o.sourceRange.startLine > toLine) continue;
                    if ((o.sectionPath || []).length > maxDepth) continue;
                    if (section && !(o.sectionPath || []).join(' › ').toLowerCase().includes(section)) continue;
                    const label = o.label || (o.kind === 'label' ? o.name : '');
                    const hay = `${o.text || ''}\n${o.title || ''}\n${label}`;
                    const match = labelPrefix
                        ? String(label).startsWith(String(labelPrefix))
                        : (re ? (re.lastIndex = 0, re.test(hay)) : hay.toLowerCase().includes(needle));
                    if (!match) continue;
                    const s = summariseObject(o);
                    s.excerpt = excerpt(o.text || o.title || label, String(q || labelPrefix), re);
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

function excerpt(text, q, re) {
    const i = re ? text.search(re) : text.toLowerCase().indexOf(q.toLowerCase());
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
    const a = new Set((before || []).map(key));
    const b = new Set((after || []).map(key));
    return {
        introduced: (after || []).filter(x => !a.has(key(x))),
        resolved: (before || []).filter(x => !b.has(key(x))),
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
                x => x.stableKey || `${x.target}:${x.command}`),
            duplicates: deltaList(beforeRefs.duplicateLabels, afterRefs.duplicateLabels,
                x => x.name),
            before: beforeRefs,
            after: afterRefs,
        },
    };
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
            x => x.stableKey || `${x.target}:${x.command}`),
        duplicates: deltaList(before.duplicateLabels, after.duplicateLabels, x => x.name),
        before, after,
    };
}

function sectionEndOffset(model, text, head) {
    const headings = model.objects.filter(o => o.kind === 'section-heading');
    const i = headings.indexOf(head);
    const next = headings.slice(i + 1).find(o => (o.level ?? 0) <= (head.level ?? 0));
    return next ? next.sourceRange.startOffset : text.length;
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
    const deletedLabels = [];
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i] || {};
        const op = edit.operation || 'replace';
        if (op === 'rename_label') {
            const oldName = String(edit.old || edit.selector || '');
            const newName = String(edit.new || edit.new_label || '');
            if (!oldName || !newName) return { error: { state: 'invalid', edit: i,
                reason: 'rename_label requires `old` and `new`' } };
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
            for (const target of targets) {
                const before = r.text.slice(target.sourceRange.startOffset, target.sourceRange.endOffset);
                const after = before.replace(`{${oldName}}`, `{${newName}}`);
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
            if (obj.label) deletedLabels.push({ name: obj.label, editIndex: i });
        } else if (op === 'insert_before' || op === 'insert_after') {
            if (typeof edit.new_text !== 'string') return { error: { state: 'invalid', edit: i,
                reason: `${op} requires \`new_text\`` } };
            const at = op === 'insert_before' ? start : end;
            changes.push({ start: at, end: at, text: edit.new_text, before: '', editIndex: i, operation: op });
        } else if (op === 'append_to_section') {
            if (obj.kind !== 'section-heading') return { error: { state: 'invalid', edit: i,
                reason: 'append_to_section selector must resolve to a section heading' } };
            if (typeof edit.new_text !== 'string') return { error: { state: 'invalid', edit: i,
                reason: 'append_to_section requires `new_text`' } };
            const at = sectionEndOffset(model, r.text, obj);
            changes.push({ start: at, end: at, text: edit.new_text, before: '', editIndex: i, operation: op });
        } else if (op === 'move_before' || op === 'move_after') {
            const targetFound = oneObject(model, edit.target_selector);
            if (targetFound.error) return { error: { ...targetFound.error, edit: i, role: 'target' } };
            const target = targetFound.object;
            const at = op === 'move_before' ? target.sourceRange.startOffset : target.sourceRange.endOffset;
            if (at >= start && at <= end) return { error: { state: 'invalid', edit: i,
                reason: 'cannot move an object into itself' } };
            changes.push({ start, end, text: '', before, editIndex: i, operation: op });
            changes.push({ start: at, end: at, text: before, before: '', editIndex: i, operation: op });
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
        verify: verify || null,
    });
    return id;
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
        const deps = nodeDeps();
        const rootInfo = findRoot(r.fsPath, deps);
        const graph = buildGraph(rootInfo.root, deps);
        const overlay = new Map();
        for (const doc of texDocuments()) overlay.set(doc.uri.fsPath, doc.getText());
        overlay.set(r.fsPath, afterText);
        const built = await compile({
            root: rootInfo.root, sourceFiles: graph.files, overlay,
            engine: verify.engine || 'pdflatex', force: true,
            timeoutMs: verify.timeout_ms || 180000,
        });
        out.latex = {
            ok: built.ok, engine: built.engine, exit: built.exit, errors: built.errors,
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
        if (input.transaction_id && !input.file) {
            const stored = _transactions.get(String(input.transaction_id));
            if (stored) input.file = stored.file;
        }
        if (input.action === 'undo' && input.undo_token && !input.file) {
            const entry = _journal.find(x => x.undoToken === String(input.undo_token));
            if (entry) input.file = entry.file;
        }
        if (!input.transaction_id && input.action !== 'undo' && !Array.isArray(input.edits) && !input.selector) {
            return errPart('`transaction_id`, `selector`, or `edits` is required');
        }
        if (!input.transaction_id && input.action !== 'undo' && !Array.isArray(input.edits) &&
            typeof input.new_text !== 'string') return errPart('`new_text` is required');

        return withDocument(input, async (r) => {
            if (!r.doc) {
                return errPart(`${r.fsPath} is not open in the editor. ` +
                    'paper_applyEdit goes through WorkspaceEdit so the change is undoable ' +
                    'and participates in normal VS Code save semantics; open the file first.');
            }
            let tx;
            let beforeProjection;
            let legacy = false;
            let unguarded = false;

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
                const plan = planPaperTransaction(r, input);
                if (plan.error) return jsonPart(plan.error);
                const id = storeTransaction(r, plan, input.verify);
                tx = _transactions.get(id);
                beforeProjection = plan.beforeProjection;
                legacy = plan.legacy;
                unguarded = plan.edits.some(e => e.expected_source_hash == null &&
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

            // SAY IT BEFORE WRITING, TOO. This edit goes through the open
            // buffer, so the change event it provokes looks exactly like the
            // reader typing — and the review mirrors the reader's typing into
            // its baseline, which would agree to this edit on their behalf and
            // leave nothing to review. `r.text` is the document as it stands
            // now, which is the baseline this change is against.
            try {
                announceAgentEdit({
                    file: r.fsPath, baseText: r.text, phase: 'begin',
                    source: 'paper_applyEdit',
                });
            } catch (_) { /* announcing is never worth failing an edit */ }

            const range = new vscode.Range(
                r.doc.positionAt(tx.replaceStart), r.doc.positionAt(tx.replaceEnd));
            const we = new vscode.WorkspaceEdit();
            we.replace(r.doc.uri, range, tx.replacementText);
            const applied = await vscode.workspace.applyEdit(we);
            if (!applied) return errPart('WorkspaceEdit was rejected by the editor');

            const verifyOptions = input.verify || tx.verify || {};
            const verification = await verifyAppliedPaper(r, beforeProjection, verifyOptions);
            let rolledBack = false;
            if (!verification.ok && verifyOptions.rollback_on_failure) {
                const rollback = new vscode.WorkspaceEdit();
                rollback.replace(r.doc.uri, new vscode.Range(
                    r.doc.positionAt(0), r.doc.positionAt(r.doc.getText().length)), tx.beforeText);
                rolledBack = await vscode.workspace.applyEdit(rollback);
            }
            if (!rolledBack && input.save) {
                try { await r.doc.save(); } catch (_) { /* dirty tab is not an error */ }
            }

            // THE READER MUST BE ABLE TO SEE THIS. An edit made here goes
            // through the open buffer, so the file watcher never fires and the
            // review would never hear about the one tool the agent is told to
            // use. `r.text` is the document as it was before the replacement,
            // which is the baseline a review opens with.
            try {
                announceAgentEdit({
                    file: r.fsPath, baseText: r.text, phase: 'end',
                    source: 'paper_applyEdit',
                    note: `${tx.summaries.length} semantic edit${tx.summaries.length === 1 ? '' : 's'}`,
                });
            } catch (_) { /* announcing is never worth failing an applied edit */ }

            const after = r.doc.getText();
            const operationId = `paper_edit_${crypto.randomUUID()}`;
            const undoToken = rolledBack ? undefined : `paper_undo_${crypto.randomUUID()}`;
            const entry = {
                operationId, transactionId: tx.id, undoToken, file: r.fsPath,
                timestamp: new Date().toISOString(), edits: tx.summaries,
                beforeHash: tx.beforeHash, afterHash: sha256(after),
                beforeText: tx.beforeText, verification, rolledBack,
            };
            _journal.push(entry);
            if (input.transaction_id) _transactions.delete(String(input.transaction_id));

            const result = {
                applied: !rolledBack,
                rolledBack: rolledBack || undefined,
                operation_id: operationId,
                transaction_id: tx.id,
                undo_token: undoToken,
                editCount: tx.summaries.length,
                edits: tx.summaries,
                previous_document_hash: tx.beforeHash,
                document_hash: sha256(after),
                saved: !!input.save && !rolledBack,
                unguarded: unguarded || undefined,
                unguarded_note: unguarded
                    ? 'applied WITHOUT a hash guard — pass expected_source_hash next time so a ' +
                      'stale edit is rejected rather than overwriting someone else\'s change'
                    : undefined,
                verification,
            };
            if (legacy && tx.summaries.length === 1) {
                result.stable_key = tx.summaries[0].stableKey;
                result.new_source_hash = sha256(input.new_text);
                result.introducesWarnings = verification.parse?.introducedWarnings?.length
                    ? verification.parse.introducedWarnings : undefined;
            }
            return jsonPart(result);
        });
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
    // exported for tests
    texMutationConflict,
    findObject,
    projectionOf,
    resolveTexDocument,
};
