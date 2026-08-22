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

            const out = {
                file: r.fsPath,
                outline: buildOutline(model.objects),
                counts,
                objects: model.objects.filter(o => ADDRESSABLE.has(o.kind)).length,
                managedBlocks: mma.blocks.length
                    ? { total: mma.blocks.length, byState: tally(mma.blocks.map(b => b.state)) }
                    : undefined,
                warnings: scan.warnings.concat(mma.warnings).slice(0, 20),
            };
            if (input.include_project) {
                const deps = nodeDeps();
                const root = findRoot(r.fsPath, deps);
                const graph = buildGraph(root.root, deps);
                out.project = {
                    root: root.root, rootSource: root.source,
                    files: graph.files, missing: graph.missing, cycles: graph.cycles,
                };
            }
            return jsonPart(out);
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
            const obj = findObject(model, input.selector);
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
            const head = sel
                ? (findObject(model, input.selector)
                    || headings.find(h => (h.title || '').toLowerCase().includes(sel)))
                : headings[0];
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
            const { model } = projectionOf(r.fsPath, r.text);
            const name = input.name ? String(input.name) : null;

            const labels = model.objects.filter(o => o.kind === 'label');
            const refs = model.objects.filter(o => o.kind === 'ref');
            const cites = model.objects.filter(o => o.kind === 'cite');

            if (name) {
                const declared = labels.filter(l => l.name === name);
                const used = refs.filter(x => x.target === name);
                const cited = cites.filter(x => x.target === name);
                const owner = model.objects.find(o => o.label === name && o.kind !== 'label');
                return jsonPart({
                    name,
                    declaredIn: declared.map(l => ({ file: l.sourceRange.file, line: l.sourceRange.startLine })),
                    attachedTo: owner ? summariseObject(owner) : null,
                    referencedBy: used.map(x => ({ cmd: x.cmd, line: x.sourceRange.startLine })),
                    citedBy: cited.map(x => ({ cmd: x.cmd, line: x.sourceRange.startLine })),
                    unresolved: declared.length === 0 && (used.length > 0 || cited.length > 0),
                });
            }

            // No name: the whole reference health of the file.
            const declaredNames = new Set(labels.map(l => l.name));
            const seen = new Map();
            const duplicates = [];
            for (const l of labels) {
                if (seen.has(l.name)) duplicates.push({ name: l.name, lines: [seen.get(l.name), l.sourceRange.startLine] });
                else seen.set(l.name, l.sourceRange.startLine);
            }
            return jsonPart({
                file: r.fsPath,
                labels: labels.length,
                refs: refs.length,
                cites: cites.length,
                unresolvedRefs: refs.filter(x => !declaredNames.has(x.target))
                    .map(x => ({ target: x.target, line: x.sourceRange.startLine })),
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
        if (!input.query) return errPart('`query` is required');
        return withDocument(input, async (r) => {
            const { model } = projectionOf(r.fsPath, r.text);
            const q = String(input.query);
            let re;
            try {
                re = input.regex ? new RegExp(q, 'i') : null;
            } catch (e) { return errPart(`bad regex: ${e.message}`); }
            const needle = q.toLowerCase();

            const kinds = input.kinds && input.kinds.length ? new Set(input.kinds) : null;
            const hits = [];
            for (const o of model.objects) {
                if (kinds ? !kinds.has(o.kind) : !ADDRESSABLE.has(o.kind)) continue;
                const hay = `${o.text || ''}\n${o.title || ''}\n${o.label || ''}`;
                const match = re ? re.test(hay) : hay.toLowerCase().includes(needle);
                if (!match) continue;
                const s = summariseObject(o);
                s.excerpt = excerpt(o.text || '', q, re);
                hits.push(s);
                if (hits.length >= (input.limit ?? 25)) break;
            }
            return jsonPart({ file: r.fsPath, query: q, matches: hits.length, hits });
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
                    cellId: b.cellId, kind: b.kind, state: b.state, stateReason: b.stateReason,
                    startLine: b.startLine, endLine: b.endLine,
                    codeHash: b.codeHash.slice(0, 12),
                    code: input.include_code ? b.code : undefined,
                    output: b.output ? {
                        startLine: b.output.startLine, endLine: b.output.endLine,
                        closed: b.output.closed,
                        declaredSourceHash: b.declaredSourceHash,
                        declaredOutputHash: b.declaredOutputHash,
                    } : null,
                }));
            return jsonPart({
                file: r.fsPath,
                total: mma.blocks.length,
                byState: tally(mma.blocks.map(b => b.state)),
                orphanedOutputs: mma.outputs.map(o => ({ cellId: o.cellId, startLine: o.startLine, state: o.state })),
                blocks,
                warnings: mma.warnings,
                note: 'Stage 1 classifies only. Executing a block is Stage 4.',
            });
        });
    }
}

// ---------------------------------------------------------------------------
// paper_previewEdit / paper_applyEdit

function buildEdit(r, obj, newText) {
    const doc = r.doc;
    const before = r.text.slice(obj.sourceRange.startOffset, obj.sourceRange.endOffset);
    return { before, after: newText, doc };
}

class PaperPreviewEditTool {
    async prepareInvocation(options) {
        return { invocationMessage: `Preview edit: ${options.input?.selector || '?'}` };
    }
    async invoke(options) {
        const input = options.input || {};
        if (!input.selector) return errPart('`selector` is required');
        if (typeof input.new_text !== 'string') return errPart('`new_text` is required');
        return withDocument(input, async (r) => {
            const { model } = projectionOf(r.fsPath, r.text);
            const obj = findObject(model, input.selector);
            if (!obj) return errPart(`no object matching ${JSON.stringify(input.selector)}`);

            const conflict = texMutationConflict(obj, r.text, input);
            if (conflict) return jsonPart(conflict);

            const { before, after } = buildEdit(r, obj, input.new_text);
            // Re-scan the WHOLE file with the edit applied, so the preview can
            // report what the change does to the projection — including whether
            // it introduces a parse warning, which is the cheapest way to catch
            // an agent about to write unbalanced TeX.
            const nextText = r.text.slice(0, obj.sourceRange.startOffset) + input.new_text +
                r.text.slice(obj.sourceRange.endOffset);
            const nextScan = scanTex(nextText, { file: r.fsPath });
            const newWarnings = nextScan.warnings.filter(w => !model.warnings.includes(w));

            return jsonPart({
                applied: false,
                object: summariseObject(obj),
                sourceHash: sha256(before),
                before, after,
                lineDelta: (after.match(/\n/g) || []).length - (before.match(/\n/g) || []).length,
                introducesWarnings: newWarnings,
                nextSourceHash: sha256(after),
                howToApply: 'call paper_applyEdit with the same selector and new_text, ' +
                    'passing expected_source_hash = sourceHash above',
            });
        });
    }
}

class PaperApplyEditTool {
    async prepareInvocation(options) {
        return {
            invocationMessage: `Edit paper object: ${options.input?.selector || '?'}`,
            confirmationMessages: {
                title: 'Apply edit to .tex',
                message: new vscode.MarkdownString(
                    `Replace \`${options.input?.selector}\` in ` +
                    `\`${path.basename(options.input?.file || 'the active .tex')}\`?`),
            },
        };
    }
    async invoke(options) {
        const input = options.input || {};
        if (!input.selector) return errPart('`selector` is required');
        if (typeof input.new_text !== 'string') return errPart('`new_text` is required');

        return withDocument(input, async (r) => {
            if (!r.doc) {
                return errPart(`${r.fsPath} is not open in the editor. ` +
                    'paper_applyEdit goes through WorkspaceEdit so the change is undoable ' +
                    'and participates in normal VS Code save semantics; open the file first.');
            }
            const { model } = projectionOf(r.fsPath, r.text);
            const obj = findObject(model, input.selector);
            if (!obj) return errPart(`no object matching ${JSON.stringify(input.selector)}`);

            const conflict = texMutationConflict(obj, r.text, input);
            if (conflict) return jsonPart(conflict);

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

            // Guarding is opt-in per the notebook contract, but for a document
            // an agent did not just read it is the difference between an edit
            // and a corruption. Say so rather than silently allowing it.
            const unguarded = input.expected_source_hash == null &&
                input.expected_object_id == null && input.expected_stable_key == null;

            const range = new vscode.Range(
                r.doc.positionAt(obj.sourceRange.startOffset),
                r.doc.positionAt(obj.sourceRange.endOffset));
            const we = new vscode.WorkspaceEdit();
            we.replace(r.doc.uri, range, input.new_text);
            const applied = await vscode.workspace.applyEdit(we);
            if (!applied) return errPart('WorkspaceEdit was rejected by the editor');

            if (input.save) { try { await r.doc.save(); } catch (_) { /* dirty tab is not an error */ } }

            // THE READER MUST BE ABLE TO SEE THIS. An edit made here goes
            // through the open buffer, so the file watcher never fires and the
            // review would never hear about the one tool the agent is told to
            // use. `r.text` is the document as it was before the replacement,
            // which is the baseline a review opens with.
            try {
                announceAgentEdit({
                    file: r.fsPath, baseText: r.text,
                    source: 'paper_applyEdit',
                    note: obj.label ? `${obj.kind} ${obj.label}` : obj.kind,
                });
            } catch (_) { /* announcing is never worth failing an applied edit */ }

            const after = r.doc.getText();
            const nextScan = scanTex(after, { file: r.fsPath });
            const introduced = nextScan.warnings.filter(w => !model.warnings.includes(w));

            return jsonPart({
                applied: true,
                object_id: obj.objectId,
                stable_key: obj.stableKey,
                kind: obj.kind,
                replaced_lines: `${obj.sourceRange.startLine}-${obj.sourceRange.endLine}`,
                new_source_hash: sha256(input.new_text),
                saved: !!input.save,
                unguarded: unguarded || undefined,
                unguarded_note: unguarded
                    ? 'applied WITHOUT a hash guard — pass expected_source_hash next time so a ' +
                      'stale edit is rejected rather than overwriting someone else\'s change'
                    : undefined,
                introducesWarnings: introduced.length ? introduced : undefined,
            });
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
