'use strict';
/**
 * Oberon Fairy — tool handler implementations.
 *
 * Each handler takes (args, ctx) and returns a structured tool result matching
 * the shape used by toolRegistry.dispatchTool:
 *   { ok, kind, summary, modelPayload (JSON string), durationMs, error, raw }
 *
 * ctx = {
 *   workDir:  WorkDir instance for this run
 *   shim:     wolframShim (evalOnce, kernelStatus, etc.)
 *   fsm:      FSM instance (for budget checks — read-only in handlers)
 *   signal?:  AbortSignal
 * }
 *
 * Handlers never throw — always return a structured error result so the Fairy
 * can read the error and self-correct.
 */

const crypto       = require('crypto');
const { analyzeCode } = require('./depAnalyzer');
const { runResearch } = require('./literature');
const { classifyMessages } = require('../core/wolframShim');

// ── Result helpers ──────────────────────────────────────────────────────────

function mkOk(name, durationMs, modelData, summary, raw = null) {
    return {
        name, ok: true, kind: 'ok', durationMs,
        summary:      summary || `${name} ok in ${durationMs}ms`,
        modelPayload: JSON.stringify(modelData),
        error:        null,
        raw,
    };
}

function mkErr(name, durationMs, kind, error, extraData = {}) {
    return {
        name, ok: false, kind, durationMs,
        summary:      `${name} ${kind}: ${String(error).slice(0, 200)}`,
        modelPayload: JSON.stringify({ ok: false, kind, error: String(error), ...extraData }),
        error:        String(error),
        raw:          null,
    };
}

// ── Pre-flight WL lint (P3) ──────────────────────────────────────────────────

/**
 * Cheap, kernel-free static check of a probe before we spend budget on it. Catches
 * the common, guaranteed-failure mistakes: unbalanced brackets and unterminated
 * strings. Conservative — only flags certainties (never blocks valid code).
 *
 * @param {string} code
 * @returns {{ ok: boolean, error?: string }}
 */
function lintWolfram(code) {
    const s = String(code || '');
    // Walk char-by-char, skipping (* … *) comments and "…" strings, tracking bracket depth.
    const stack = [];
    const pairs = { ')': '(', ']': '[', '}': '{' };
    let inStr = false, i = 0;
    while (i < s.length) {
        const c = s[i];
        if (inStr) {
            if (c === '\\') { i += 2; continue; }
            if (c === '"') inStr = false;
            i++; continue;
        }
        // comment start
        if (c === '(' && s[i + 1] === '*') {
            const end = s.indexOf('*)', i + 2);
            if (end === -1) return { ok: false, error: 'Unterminated comment (* … *).' };
            i = end + 2; continue;
        }
        if (c === '"') { inStr = true; i++; continue; }
        if (c === '(' || c === '[' || c === '{') { stack.push(c); i++; continue; }
        if (c === ')' || c === ']' || c === '}') {
            const open = stack.pop();
            if (open !== pairs[c]) {
                return { ok: false, error: `Unbalanced bracket: '${c}' has no matching '${pairs[c]}'.` };
            }
            i++; continue;
        }
        i++;
    }
    if (inStr) return { ok: false, error: 'Unterminated string literal (missing closing ").' };
    if (stack.length) {
        const open = stack[stack.length - 1];
        return { ok: false, error: `Unbalanced bracket: '${open}' is never closed.` };
    }
    return { ok: true };
}

// ── Util similarity (P1 anti-fork) ───────────────────────────────────────────

/** Normalise WL code for comparison: drop comments, collapse whitespace, lowercase. */
function _normaliseCode(code) {
    return String(code || '')
        .replace(/\(\*[\s\S]*?\*\)/g, ' ')   // strip comments
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Token-Jaccard similarity of two WL code bodies (0..1). Used to detect a util that
 * is really a re-derivation of an existing one under a new name (P1/P8/P9).
 */
function utilSimilarity(a, b) {
    const tok = (s) => new Set(_normaliseCode(s).match(/[a-z0-9$]+/g) || []);
    const A = tok(a), B = tok(b);
    if (!A.size && !B.size) return 1;
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
}

// ── Redefinition detection (M8) ──────────────────────────────────────────────

/**
 * Extract symbols that `code` DEFINES — the LHS of every `name := …`,
 * `name[args] := …`, or `name = …` at a statement boundary.
 * @param {string} code
 * @returns {string[]}
 */
function extractDefinedSymbols(code) {
    if (!code || typeof code !== 'string') return [];
    const out = [];
    // Only match definitions at a LINE boundary (not after `;`) to avoid false
    // positives from local assignments inside Module[{x}, x=1; y=2] bodies.
    const re = /(?:^|\n)\s*([A-Za-z$][A-Za-z0-9$]*)\s*(?:\[[^\]]*\])?\s*:?=(?![=])/g;
    let m;
    while ((m = re.exec(code)) !== null) {
        if (m[1] && !out.includes(m[1])) out.push(m[1]);
    }
    return out;
}

/**
 * Symbols explicitly whitelisted for redefinition via a leading
 * `(* redefine: foo *)` or `(* redefine: foo, bar *)` comment.
 * @param {string} code
 * @returns {Set<string>}
 */
function extractRedefineWhitelist(code) {
    const set = new Set();
    const re = /\(\*\s*redefine:\s*([^*]+?)\s*\*\)/gi;
    let m;
    while ((m = re.exec(code)) !== null) {
        for (const name of m[1].split(',')) {
            const n = name.trim();
            if (n) set.add(n);
        }
    }
    return set;
}

/**
 * Return the list of already-defined symbols (registered utils + valid recorded
 * step definitions) that `code` re-defines, excluding any explicitly whitelisted.
 * @param {string} code
 * @param {object} ctx
 * @returns {Promise<string[]>}
 */
async function detectRedefinition(code, ctx) {
    const defined = extractDefinedSymbols(code);
    if (!defined.length) return [];

    const [utils, steps] = await Promise.all([
        ctx.workDir.loadUtils().catch(() => []),
        ctx.workDir.loadAllSteps().catch(() => []),
    ]);
    const alive = new Set();
    for (const u of utils) if (u && u.name) alive.add(u.name);
    for (const s of steps) {
        if (s && s.status === 'valid') {
            for (const sym of (s.definesSymbols || [])) if (sym) alive.add(sym);
        }
    }

    const whitelist = extractRedefineWhitelist(code);
    const hits = [];
    for (const sym of defined) {
        if (alive.has(sym) && !whitelist.has(sym) && !hits.includes(sym)) hits.push(sym);
    }
    return hits;
}

// ── Structural summary (pure, no kernel call) ────────────────────────────────

/**
 * Derive a lightweight structural description from an InputForm string.
 * Used to give the model useful orientation about large results without
 * dumping the full value into the context.
 */
function computeStructuralSummary(valueStr) {
    if (!valueStr || typeof valueStr !== 'string') {
        return { head: 'Unknown', summary: '(no value)' };
    }
    const v = valueStr.trim();

    // List: starts with {
    if (v.startsWith('{')) {
        let depth = 0, count = 0, maxDepth = 0;
        let first = true;
        // Top-level element boundaries (for first/last element snippets).
        const topCommas = [];
        for (let i = 0; i < v.length; i++) {
            const c = v[i];
            if (c === '{') { depth++; if (depth > maxDepth) maxDepth = depth; if (depth === 1 && first) { count = 1; first = false; } }
            else if (c === '}') { depth--; if (depth === 0) { break; } }
            else if (c === ',' && depth === 1) { count++; topCommas.push(i); }
        }
        // R8: corner-element snippets + matrix-dims guess so the model rarely needs inspect.
        const firstEnd = topCommas.length ? topCommas[0] : v.indexOf('}');
        const firstEl  = v.slice(1, firstEnd > 0 ? firstEnd : v.length).trim().slice(0, 40);
        const lastStart = topCommas.length ? topCommas[topCommas.length - 1] + 1 : 1;
        const lastClose = v.lastIndexOf('}');
        const lastEl   = v.slice(lastStart, lastClose > lastStart ? lastClose : v.length).trim().slice(0, 40);
        // Rectangular matrix heuristic: first element is itself a list with the same length.
        let matrixDims;
        if (v.startsWith('{{')) {
            let rdepth = 0, cols = 0, rfirst = true;
            for (let i = 1; i < v.length; i++) {
                const c = v[i];
                if (c === '{') { rdepth++; if (rdepth === 1 && rfirst) { cols = 1; rfirst = false; } }
                else if (c === '}') { rdepth--; if (rdepth === 0) break; }
                else if (c === ',' && rdepth === 1) cols++;
            }
            matrixDims = `${count}×${cols}`;
        }
        const summary = matrixDims
            ? `List (matrix ${matrixDims}); first row {${firstEl}…`
            : `List[${count} element(s)], depth ${maxDepth}; first=${firstEl}, last=${lastEl}`;
        return {
            head: 'List', elementCount: count, depth: maxDepth,
            matrixDims, firstElement: firstEl, lastElement: lastEl, summary,
        };
    }

    // f[...] — extract head
    const headMatch = v.match(/^([A-Za-z$][A-Za-z0-9`$]*)(?:\[|\s)/);
    if (headMatch) {
        return { head: headMatch[1], summary: `${headMatch[1]}[…]` };
    }

    // Rational: n/m
    if (/^-?\d+\/\d+$/.test(v)) {
        return { head: 'Rational', summary: v };
    }

    // Integer or real number
    if (/^-?[\d.]+([*^eEj].*)?$/.test(v)) {
        return { head: 'Number', summary: v.slice(0, 60) };
    }

    // Symbol
    if (/^[A-Za-z$][A-Za-z0-9$]*$/.test(v)) {
        return { head: v, summary: v };
    }

    return { head: 'Expression', summary: v.slice(0, 80) };
}

// ── Probe ────────────────────────────────────────────────────────────────────

/**
 * Run a trial expression. Appends a scratch cell to working.wb and stores
 * the full result in results/<probeId>.json.
 */
async function handleProbe(args, ctx) {
    const t0   = Date.now();
    const name = 'probe';
    const code = String(args.code || '').trim();
    if (!code) return mkErr(name, 0, 'bad_args', 'code must be a non-empty string');

    // ── Forbidden probe patterns ────────────────────────────────────────────
    // Reject filesystem introspection — task inputs are pre-loaded, never on disk.
    const FS_PATTERNS = [/\bFileNames\b/, /\bDirectory\[\]/, /\$HomeDirectory\b/,
        /\bFileExistsQ\b/, /\bDirectoryQ\b/, /\bSetDirectory\b/, /\bGetDirectory\b/,
        /\bExpandFileName\b/, /\$Path\b/];
    if (FS_PATTERNS.some(re => re.test(code))) {
        return {
            name, ok: false, kind: 'rejected', durationMs: 0,
            summary:      'probe rejected: filesystem introspection forbidden',
            modelPayload: JSON.stringify({
                rejected:        true,
                reason:          'Filesystem introspection is forbidden. Task inputs are pre-loaded into the kernel — use them directly.',
                suggestedAction: 'Start computing with the task symbols directly. Never call FileNames, Directory[], $HomeDirectory, or $Path.',
            }),
            error: 'filesystem_introspection_forbidden', raw: null,
        };
    }

    // Reject Unprotect[] on any symbol — wolfbook internal symbols must never be touched.
    if (/\bUnprotect\s*\[/.test(code)) {
        return {
            name, ok: false, kind: 'rejected', durationMs: 0,
            summary:      'probe rejected: Unprotect[] forbidden',
            modelPayload: JSON.stringify({
                rejected:        true,
                reason:          'Calling Unprotect[] on any symbol is forbidden. Wolfbook\'s kernel has protected internal symbols that must not be modified.',
                suggestedAction: 'If you received a "Symbol is Protected" warning from ClearAll, do NOT call Unprotect. Instead, use Clear[specificSymbol] on only the symbols you created.',
            }),
            error: 'unprotect_forbidden', raw: null,
        };
    }

    // Reject probes containing placeholder comments — ensures code is complete before eval.
    if (/\(\*\s*(TODO|FIXME|repeat for|add here|fill in|\.\.\.)\b/i.test(code)) {
        return {
            name, ok: false, kind: 'rejected', durationMs: 0,
            summary:      'probe rejected: incomplete code (placeholder comment)',
            modelPayload: JSON.stringify({
                rejected:        true,
                reason:          'Probe contains a placeholder comment (TODO/repeat for/etc.). The code is incomplete.',
                suggestedAction: 'Write out the complete code before submitting the probe. Replace all placeholder comments with actual WL expressions.',
            }),
            error: 'incomplete_code', raw: null,
        };
    }

    // P3: pre-flight lint — reject guaranteed-failure syntax (unbalanced brackets /
    // strings) WITHOUT spending a probe, so the agent fixes it via amend_probe.
    const lint = lintWolfram(code);
    if (!lint.ok) {
        return {
            name, ok: false, kind: 'syntax', durationMs: 0,
            summary:      `probe rejected: ${lint.error}`,
            modelPayload: JSON.stringify({
                rejected:        true,
                reason:          `Syntax error (no probe spent): ${lint.error}`,
                suggestedAction: 'Fix the syntax and re-submit. If this was a small slip, use amend_probe.',
            }),
            error: 'syntax', raw: null,
        };
    }

    // M8: Reject re-pasting a symbol that is already alive in the kernel (registered
    // util or symbol defined by a valid recorded step). The model must CALL it by
    // name, not redefine it. Gated by ctx.rejectRedefinition (default on). An explicit
    // `(* redefine: foo *)` comment whitelists `foo` for a deliberate correction.
    if (ctx.rejectRedefinition !== false) {
        const redefHit = await detectRedefinition(code, ctx).catch(() => null);
        if (redefHit && redefHit.length) {
            return {
                name, ok: false, kind: 'rejected', durationMs: 0,
                summary:      `probe rejected: redefines ${redefHit.join(', ')}`,
                modelPayload: JSON.stringify({
                    rejected:        true,
                    reason:          `${redefHit.join(', ')} ${redefHit.length === 1 ? 'is' : 'are'} already defined in the live kernel — re-pasting the definition is forbidden. Call it by name instead.`,
                    suggestedAction: `Write only the next NEW line of the calculation, using ${redefHit.join(', ')} by name. To deliberately change a definition, first invalidate the step that created it, then re-probe with a leading "(* redefine: ${redefHit[0]} *)" comment.`,
                }),
                error: 'redefinition', raw: null,
            };
        }
    }

    // Near-duplicate-probe guard: stop the agent re-pasting a ~identical block with a
    // tiny tweak (numeric vs symbolic, Round→Chop) into fresh probes instead of
    // recording the shared setup or amending the last probe. Skipped for amends
    // (an amend is *meant* to resemble the probe it revises).
    if (!ctx.amendProbeId) {
        const recent = await ctx.workDir.loadRecentProbes(5).catch(() => []);
        let dupId = null, dupSim = 0;
        for (const rp of recent) {
            if (!rp || !rp.code) continue;
            const sim = utilSimilarity(rp.code, code);
            if (sim >= 0.8 && sim > dupSim) { dupSim = sim; dupId = rp.probeId; }
        }
        if (dupId) {
            return {
                name, ok: false, kind: 'near_duplicate', durationMs: 0,
                summary: `probe rejected: ${Math.round(dupSim * 100)}% identical to ${dupId}`,
                modelPayload: JSON.stringify({
                    rejected: true,
                    reason: `This probe is ${Math.round(dupSim * 100)}% identical to ${dupId} (no probe spent). ` +
                        `Re-running nearly the same block with a small tweak wastes budget and is the ` +
                        `"rebuild instead of extend" anti-pattern.`,
                    suggestedAction:
                        `Pick ONE: (a) if you are refining ${dupId} (e.g. numeric vs symbolic, a cleaner form), ` +
                        `use \`amend_probe\` to revise it IN PLACE — do not open a new probe; ` +
                        `(b) if the setup is correct and reusable, \`record\` it as a step (it is then loaded ` +
                        `automatically — never re-paste it) and probe ONLY the next new line; ` +
                        `(c) isolate the single thing you are changing into a SMALL, focused probe rather than ` +
                        `re-pasting the whole construction.`,
                }),
                error: 'near_duplicate', raw: null,
            };
        }
    }

    const timeoutSeconds = args.timeoutSeconds || ctx.shim.DEFAULT_TIMEOUT;

    // Generate probeId before evaluation so it can appear in the notebook note cell.
    // R1: an amend reuses the prior probeId (ctx.amendProbeId) instead of advancing
    // the counter, so a fixed probe keeps its slot rather than spawning a new one.
    const counter = await ctx.workDir.nextProbeCounter();
    const probeId = ctx.amendProbeId || `p${String(counter).padStart(3, '0')}`;

    // Require prevAnalysis for every probe after the first — forces visible reflection.
    // An amend never requires prevAnalysis (it is a fix of the immediately prior probe).
    if (!ctx.amendProbeId && counter >= 2 && !args.prevAnalysis) {
        return {
            name, ok: false, kind: 'missing_analysis', durationMs: 0,
            summary: `probe ${probeId} rejected: prevAnalysis required`,
            modelPayload: JSON.stringify({
                rejected: true,
                reason: `'prevAnalysis' is required for every probe after the first. Write one sentence stating what the previous probe's output showed and what you concluded from it.`,
                hint: `Add "prevAnalysis": "<your one-sentence assessment of the last result>" to this probe call, then resubmit.`,
            }),
            error: 'missing_analysis', raw: null,
        };
    }

    // M6: Do NOT prepend registered utility definitions. define_util evaluates each
    // helper into the live, persistent kernel once; later probes call it BY NAME.
    // Re-pasting util bodies on every probe bloated the notebook and trained the model
    // to rebuild instead of extend. Utils are re-seeded once on kernel restart
    // (see wolframShim.restartKernel) and used only for clean-notebook assembly.

    // Evaluate in the working kernel.
    // Use the wolfbook controller path (evalInNotebook) when working.wb is open so
    // the probe cell gets full rich rendering in the tab. Falls back to evalOnce
    // (text-only) when no notebook document is available (e.g. background runs).
    let r;
    let _nbDoc    = null;   // used for cleanup on message failure
    let _cellsBefore = 0;
    try {
        _nbDoc = ctx.getWorkingNbDoc && ctx.getWorkingNbDoc();
        if (_nbDoc && ctx.shim.evalInNotebook) {
            _cellsBefore = _nbDoc.cellCount;
            r = await ctx.shim.evalInNotebook(_nbDoc, code, {
                timeoutSeconds, signal: ctx.signal,
                note: args.note || null, probeId,
                prevAnalysis: args.prevAnalysis || null,
                agentView: true,   // request the compact InputForm + shape side channel
            });
        } else {
            r = await ctx.shim.evalOnce({ expression: code, timeoutSeconds, signal: ctx.signal });
            _nbDoc = null;  // no notebook cells to clean up in evalOnce path
        }
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'eval_error', e && e.message || String(e));
    }

    // Kernel messages: CRITICAL ones fail the probe (the agent must eliminate them
    // before recording). NON-critical convergence/tolerance warnings (FindRoot::lstol,
    // …) do NOT fail it — the result is kept and surfaced as a softWarning so the agent
    // verifies the residual, then records with acknowledgeMessages. The notebook path
    // already classifies (returns softWarning, messages:null); this covers the evalOnce
    // (background) path where r.messages still carries the raw warning text.
    if (r.ok && r.messages && (Array.isArray(r.messages) ? r.messages.length > 0 : !!r.messages)) {
        const msgText = Array.isArray(r.messages) ? r.messages.join('\n') : String(r.messages);
        const cls = classifyMessages(msgText);
        if (cls.allNonCritical) {
            r = { ...r, softWarning: r.softWarning || cls.soft.join(', '), messages: null };
        } else {
            r = { ...r, ok: false, kind: 'messages', error: r.messages };
        }
    }

    // Remove cells inserted by evalInNotebook whenever the probe failed (any reason:
    // messages, error, timeout). evalInNotebook may return ok:false directly (hasError
    // detected in text/plain), so this must be outside the messages check above.
    if (!r.ok && _nbDoc && ctx.shim.removeLastCells) {
        const cellsAdded = _nbDoc.cellCount - _cellsBefore;
        if (cellsAdded > 0) {
            await ctx.shim.removeLastCells(_nbDoc, cellsAdded).catch(() => {});
        }
    }

    const durationMs = Date.now() - t0;

    const valueStr   = r.value || null;
    // Agent view: when the notebook path supplied a compact InputForm + kernel-computed
    // shape (the on-demand side channel), use them for the agent — they are shorter,
    // executable, and surface evaluation state. The human cell keeps its LaTeX render;
    // valueStr (the human/LaTeX text) is still stored on disk for inspect/replay.
    const agentValue = (r.ok && typeof r.agentValue === 'string' && r.agentValue.length) ? r.agentValue : null;
    const agentShape = (r.ok && typeof r.agentShape === 'string' && r.agentShape.length) ? r.agentShape : null;

    const structural = !r.ok
        ? { head: 'Error', summary: r.error || r.kind }
        : (agentShape ? { shape: agentShape } : computeStructuralSummary(valueStr));

    // ── History size limits ───────────────────────────────────────────────────
    // These caps apply only to modelPayload (LLM message history).
    // Full values are preserved on disk in results/<probeId>.json.
    const VALUE_LIMIT    = 400;  // chars of result preview in conversation
    const MESSAGES_LIMIT = 400;  // chars of kernel messages/error in conversation

    // Preview from the agent's InputForm when available (already capped at 300 in the
    // kernel); otherwise from the human/LaTeX value.
    const preview          = agentValue || (valueStr ? valueStr.slice(0, VALUE_LIMIT) : null);
    const previewTruncated = agentValue
        ? (r.agentValueLen || 0) > agentValue.length
        : (valueStr && valueStr.length > VALUE_LIMIT);
    const previewFullLen   = agentValue ? (r.agentValueLen || agentValue.length) : (valueStr ? valueStr.length : 0);

    function capMessages(s) {
        if (!s || typeof s !== 'string') return s;
        return s.length > MESSAGES_LIMIT
            ? s.slice(0, MESSAGES_LIMIT) + `… [${s.length} chars total — use inspect ${probeId} for full output]`
            : s;
    }

    // Save probe to disk — always full values, never capped
    await ctx.workDir.saveProbe(probeId, {
        code,
        ok:               r.ok,
        value:            valueStr,
        messages:         r.messages || null,
        prints:           r.prints   || null,
        durationMs:       r.durationMs,
        structuralSummary: structural,
        agentValue:       agentValue || undefined,   // compact InputForm (agent layer)
        agentShape:       agentShape || undefined,
        softWarning:      r.softWarning || undefined, // non-critical solver warning (kept, non-failing)
        error:            r.ok ? null : (r.error || r.kind),
        note:             args.note || null,
    });

    if (r.ok) {
        const summary = `probe ${probeId} ok in ${durationMs}ms`;
        const outputIsEmpty = !valueStr || valueStr.trim() === '' || valueStr.trim() === 'Null';
        // M10: soft warning when a step's code is large — usually a sign the model is
        // rebuilding from scratch rather than extending live kernel symbols.
        const LARGE_STEP_CHARS = 1500;
        const largeStepWarning = code.length > LARGE_STEP_CHARS
            ? `This step is large (${code.length} chars). Large steps usually mean you are rebuilding rather than extending. Prefer small steps that reuse symbols already defined in the kernel — call them by name instead of re-pasting their definitions.`
            : undefined;

        // Symbolic-non-evaluation hint. A frequent cause of huge, useless output is an
        // expression that never fully evaluated — and the agent then blindly re-probes
        // (the p19–p22 pattern). The classic footgun: `⊗` (CircleTimes, a FORMAL product)
        // used where KroneckerProduct was meant, so matrices stay symbolic.
        const hints = [];
        if (/⊗|CircleTimes/.test(code) && /KroneckerProduct|IdentityMatrix|Eigen/.test(code)) {
            hints.push('Your code mixes `⊗` (CircleTimes — a FORMAL, non-evaluating product) with matrix ' +
                'operations. For an actual matrix tensor product use KroneckerProduct[a, b], not a⊗b.');
        }
        // Prefer the kernel-computed shape (precise) over regex-sniffing the rendered value.
        const shapeStr = agentShape || '';
        const unevalFromShape = /unevaluated\{|NON-numeric/.test(shapeStr);
        const unevalFromValue = !agentShape && valueStr && valueStr.length > 1500 && /⊗|\\otimes|CircleTimes|Root\[|\\mathrm\{Root\}/.test(valueStr);
        if (unevalFromShape || unevalFromValue) {
            hints.push(`The result did not fully evaluate (${agentShape ? `shape: ${shapeStr}` : 'large symbolic output'}). ` +
                `A NON-numeric/unevaluated result usually means a formal head (e.g. CircleTimes vs KroneckerProduct) ` +
                `was left in. Do NOT re-run the whole block; use inspect ${probeId} to find what stayed symbolic, ` +
                `or amend_probe to fix the offending operator in place.`);
        }
        const symbolicHint = hints.length ? hints.join(' ') : undefined;

        const modelData = {
            ok:               true,
            probeId,
            resultPreview:    preview,
            previewTruncated: previewTruncated ? `(${previewFullLen} chars total — call inspect ${probeId} for full result)` : undefined,
            outputIsEmpty:    outputIsEmpty || undefined,
            structuralSummary: structural,
            messages:         capMessages(r.messages) || undefined,
            prints:           capMessages(r.prints)   || undefined,
            durationMs,
            warning:          largeStepWarning,
            hint:             symbolicHint,
            solverWarning:    r.softWarning || undefined,
            notice: outputIsEmpty
                ? '🚨 EMPTY OUTPUT — this probe returned no value (Null or blank). You MUST write your analysis block and explicitly explain why empty output is acceptable here. If this probe was supposed to compute a value, do NOT record it — fix the code so it returns the value explicitly.'
                : (r.softWarning
                    ? `⚠️ Non-critical solver warning (${r.softWarning}) — the result was kept. This is usually fine, but VERIFY the residual/accuracy is acceptably small before relying on it; if so you may record this step with acknowledgeMessages: true.`
                    : (r.messages
                        ? '⚠️ Kernel messages present — check before recording this step.'
                        : undefined)),
        };
        const result = mkOk(name, durationMs, modelData, summary, r);
        result.probeId = probeId;  // expose at top level for probe.appended event
        return result;
    } else {
        const rawError = r.error || r.kind || '';
        const modelData = {
            ok:      false,
            probeId,
            kind:    r.kind,
            error:   capMessages(rawError),
            messages: capMessages(r.messages) || undefined,
            durationMs,
            errorNotice: `⚠️ Probe ${probeId} FAILED (${r.kind}). Do not record this probe. Fix the code and probe again.`,
        };
        return {
            name, ok: false, kind: r.kind, durationMs,
            probeId,  // expose at top level even on failure (for probe.appended)
            summary:      `probe ${probeId} ${r.kind} in ${durationMs}ms`,
            modelPayload: JSON.stringify(modelData),
            error:        rawError,
            raw:          r,
        };
    }
}

// ── amend_probe (R1) ──────────────────────────────────────────────────────────

/**
 * Fix the immediately-preceding probe in place rather than opening a fresh probe.
 * Reuses the prior probeId (set on ctx.lastProbeId) so the corrected probe keeps its
 * slot. Only valid right after a failed probe. Delegates to handleProbe with the
 * forced probeId so all the usual guards (FS/Unprotect/redefinition/large-step) apply.
 */
async function handleAmendProbe(args, ctx) {
    const name = 'amend_probe';
    const code = String(args.code || '').trim();
    if (!code) return mkErr(name, 0, 'bad_args', 'code must be a non-empty string');

    if (!ctx.lastProbeId) {
        return mkErr(name, 0, 'nothing_to_amend',
            'There is no prior probe to amend. Use `probe` for a new computation. ' +
            '`amend_probe` only revises the immediately-preceding probe.');
    }
    // amend_probe revises the LAST probe in place — whether it failed (a fix) or
    // succeeded with unsatisfactory output (a refinement: numeric vs symbolic, a
    // cleaner form). Reusing the slot is how you ITERATE on one probe instead of
    // re-pasting the whole block into a fresh probe.

    // Delegate to handleProbe with the forced probeId; mark the result as an amend.
    const probeCtx = Object.assign({}, ctx, { amendProbeId: ctx.lastProbeId });
    const result = await handleProbe({ code, note: args.note }, probeCtx);
    result.name    = name;
    result.amended = true;
    return result;
}

// ── Inspect ──────────────────────────────────────────────────────────────────

/**
 * Apply a WL operation to a stored probe result without re-running the probe.
 * Evaluates op(originalCode) in the kernel (re-uses original code to avoid
 * string-injection of the value).
 */
async function handleInspect(args, ctx) {
    const t0   = Date.now();
    const name = 'inspect';

    const resultRef = String(args.resultRef || '').trim();
    if (!resultRef) return mkErr(name, 0, 'bad_args', 'resultRef is required');

    const probe = await ctx.workDir.getProbe(resultRef);
    if (!probe)   return mkErr(name, Date.now() - t0, 'not_found', `No probe with id '${resultRef}'`);
    if (!probe.ok) return mkErr(name, Date.now() - t0, 'probe_failed', `Probe '${resultRef}' did not succeed — cannot inspect`);

    const op   = args.op ? String(args.op).trim() : null;
    const expr = op
        ? `With[{$inspectTarget$ = TimeConstrained[(${probe.code}), 20, $Failed]}, (${op})[$inspectTarget$]]`
        : `Short[TimeConstrained[(${probe.code}), 20, $Failed], 20]`;

    let r;
    try {
        r = await ctx.shim.evalOnce({ expression: expr, timeoutSeconds: 25, signal: ctx.signal });
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'eval_error', e && e.message || String(e));
    }

    const durationMs = Date.now() - t0;
    const INSPECT_CAP = 800;
    const raw = r.value || '';
    const capped = raw.length > INSPECT_CAP
        ? raw.slice(0, INSPECT_CAP) + `\n[…${raw.length - INSPECT_CAP} more chars — use a more specific op]`
        : raw;

    if (!r.ok) {
        return mkErr(name, durationMs, r.kind,
            `inspect of '${resultRef}' failed: ${r.error || r.kind}`);
    }

    return mkOk(name, durationMs, {
        ok:       true,
        resultRef,
        op:       op || 'Short[..., 20]',
        preview:  capped,
        messages: r.messages || undefined,
        durationMs,
    }, `inspect ${resultRef} ok in ${durationMs}ms`, r);
}

// ── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Look up WL symbol documentation via Information[].
 */
async function handleLookup(args, ctx) {
    const t0     = Date.now();
    const name   = 'lookup';
    const symbol = String(args.symbol || '').trim();
    if (!symbol) return mkErr(name, 0, 'bad_args', 'symbol is required');

    // Sanitise: only allow valid WL symbol names
    if (!/^[A-Za-z$][A-Za-z0-9`$]*$/.test(symbol)) {
        return mkErr(name, 0, 'bad_args', `Invalid symbol name: '${symbol}'`);
    }

    const expr = `ToString[Information["${symbol}", LongForm -> False], OutputForm]`;
    let r;
    try {
        r = await ctx.shim.evalOnce({ expression: expr, timeoutSeconds: 15, signal: ctx.signal });
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'eval_error', e && e.message || String(e));
    }

    const durationMs = Date.now() - t0;
    const INFO_CAP = 1200;
    const info = (r.value || '').slice(0, INFO_CAP);

    if (!r.ok) {
        return mkErr(name, durationMs, r.kind, `lookup '${symbol}' failed: ${r.error || r.kind}`);
    }

    return mkOk(name, durationMs, {
        ok:       true,
        symbol,
        info,
        messages: r.messages || undefined,
        durationMs,
    }, `lookup '${symbol}' ok in ${durationMs}ms`, r);
}

// ── Record ───────────────────────────────────────────────────────────────────

/**
 * Commit a successful probe as a named step in the working chain.
 */
async function handleRecord(args, ctx) {
    const t0      = Date.now();
    const name    = 'record';
    const stepId  = String(args.stepId  || '').trim();
    const probeId = String(args.probeId || '').trim();

    if (!stepId)  return mkErr(name, 0, 'bad_args', 'stepId is required');
    if (!probeId) return mkErr(name, 0, 'bad_args', 'probeId is required');

    // Validate stepId format
    if (!/^[a-z][a-z0-9_]*$/.test(stepId)) {
        return mkErr(name, 0, 'bad_args', `stepId must be snake_case lowercase: '${stepId}'`);
    }

    // Ensure stepId is unique among valid steps
    const existingSteps = await ctx.workDir.loadValidSteps();
    if (existingSteps.some(s => s.id === stepId)) {
        return mkErr(name, Date.now() - t0, 'duplicate_step',
            `A valid step with id '${stepId}' already exists. Choose a different stepId.`);
    }

    // Load the probe
    const probe = await ctx.workDir.getProbe(probeId);
    if (!probe) {
        return mkErr(name, Date.now() - t0, 'probe_not_found',
            `No probe with id '${probeId}'. Run a probe first.`);
    }
    if (!probe.ok) {
        return mkErr(name, Date.now() - t0, 'probe_failed',
            `Probe '${probeId}' did not succeed (${probe.error || 'unknown'}). Only record clean probes.`);
    }

    // Block recording if the probe produced kernel messages (warnings/errors) unless
    // the model explicitly acknowledges them as benign via acknowledgeMessages: true.
    if (probe.messages && !args.acknowledgeMessages) {
        return {
            name, ok: false, kind: 'has_messages', durationMs: Date.now() - t0,
            summary: `record rejected: probe '${probeId}' has kernel messages`,
            modelPayload: JSON.stringify({
                rejected: true,
                reason:   `Probe '${probeId}' produced kernel messages. Fix the code or confirm the messages are benign.`,
                messages: (Array.isArray(probe.messages) ? probe.messages : [probe.messages]).slice(0, 3),
                suggestedAction: 'Run a new probe that eliminates the warning. If the warning is genuinely benign and the result is correct, re-call record with acknowledgeMessages: true.',
            }),
            error: 'probe_has_messages', raw: null,
        };
    }

    // Static dependency analysis
    const { definesSymbols, usesSymbols } = analyzeCode(probe.code);

    // Infer dependsOn: steps that define symbols this step uses
    const inferredDependsOn = [];
    for (const s of existingSteps) {
        const defs = s.definesSymbols || [];
        if (defs.some(sym => usesSymbols.includes(sym))) {
            inferredDependsOn.push(s.id);
        }
    }

    // Merge model-supplied dependsOn with inferred (union, deduped, validate existence)
    const modelDependsOn = Array.isArray(args.dependsOn)
        ? args.dependsOn.filter(id => existingSteps.some(s => s.id === id))
        : [];
    const mergedDependsOn = [...new Set([...inferredDependsOn, ...modelDependsOn])];

    // Redefinition conflict check: does this step define a symbol already defined by another valid step in the chain?
    const warnings = [];
    for (const sym of definesSymbols) {
        for (const s of existingSteps) {
            if ((s.definesSymbols || []).includes(sym)) {
                warnings.push(`Redefinition conflict: '${sym}' is also defined by step '${s.id}'. This may cause issues at fresh-kernel verification.`);
            }
        }
    }

    // Append to steps.json
    await ctx.workDir.addStep({
        id:             stepId,
        probeId,
        code:           probe.code,
        resultRef:      probeId,
        dependsOn:      mergedDependsOn,
        usesSymbols:    usesSymbols.slice(0, 40),   // cap for storage
        definesSymbols,
        note:           args.note || probe.note || '',
        // R9: confidence metadata, optional.
        confidence:     ['high', 'medium', 'low'].includes(args.confidence) ? args.confidence : undefined,
        verifiedBy:     args.verifiedBy ? String(args.verifiedBy).slice(0, 200) : undefined,
    });

    const durationMs = Date.now() - t0;
    return mkOk(name, durationMs, {
        ok:                 true,
        stepId,
        probeId,
        recorded:           true,
        inferredDependsOn,
        mergedDependsOn,
        definesSymbols,
        usesSymbols:        usesSymbols.slice(0, 20),
        warnings:           warnings.length ? warnings : undefined,
        durationMs,
        notice: warnings.length
            ? '⚠️ Redefinition conflict(s) detected (see warnings). The fresh-kernel verification may fail; consider invalidating the conflicting step first.'
            : undefined,
    }, `record '${stepId}' from probe '${probeId}' ok in ${durationMs}ms`);
}

// ── Assume ───────────────────────────────────────────────────────────────────

/**
 * Register or update a mathematical assumption. Regenerates $Assumptions in
 * the working kernel after each call.
 */
async function handleAssume(args, ctx) {
    const t0        = Date.now();
    const name      = 'assume';
    const id        = String(args.id        || '').trim();
    const statement = String(args.statement || '').trim();

    if (!id)        return mkErr(name, 0, 'bad_args', 'id is required');
    if (!statement) return mkErr(name, 0, 'bad_args', 'statement is required');

    const assumption = {
        id,
        statement,
        wlAssumption: args.wlAssumption ? String(args.wlAssumption).trim() : undefined,
    };

    const allAssumptions = await ctx.workDir.upsertAssumption(assumption);

    // Regenerate $Assumptions in the working kernel
    const wlExprs = allAssumptions
        .map(a => a.wlAssumption)
        .filter(Boolean);
    const assumExpr = wlExprs.length > 0
        ? `$Assumptions = And[${wlExprs.join(', ')}];`
        : `$Assumptions = True;`;

    let kernelOk = false;
    try {
        const kr = await ctx.shim.evalOnce({ expression: assumExpr, timeoutSeconds: 10, signal: ctx.signal });
        kernelOk = kr.ok;
    } catch (_) {}

    const durationMs = Date.now() - t0;
    return mkOk(name, durationMs, {
        ok:            true,
        id,
        statement,
        totalAssumptions: allAssumptions.length,
        assumptionsExpr:  assumExpr,
        kernelUpdated:    kernelOk,
        durationMs,
    }, `assume '${id}' registered in ${durationMs}ms`);
}

// ── Chain ────────────────────────────────────────────────────────────────────

/**
 * Return a bounded summary of the current working chain state.
 */
async function handleChain(_args, ctx) {
    const t0   = Date.now();
    const name = 'chain';
    try {
        const [summary, utils] = await Promise.all([
            ctx.workDir.buildChainSummary({ maxChars: 3000 }),
            ctx.workDir.loadUtils().catch(() => []),
        ]);
        const durationMs = Date.now() - t0;
        return mkOk(name, durationMs, {
            ok: true,
            ...summary,
            utilities: utils.map(u => ({ name: u.name, note: u.note })),
            durationMs,
        }, `chain ok (${(summary.steps || []).length} valid steps, ${utils.length} utilities) in ${durationMs}ms`);
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'error', e && e.message || String(e));
    }
}

// ── Invalidate ───────────────────────────────────────────────────────────────

/**
 * Mark a step and all its dependents as stale, deleting the draft clean.wb.
 */
async function handleInvalidate(args, ctx) {
    const t0         = Date.now();
    const name       = 'invalidate';
    const fromStepId = String(args.fromStepId || '').trim();
    if (!fromStepId) return mkErr(name, 0, 'bad_args', 'fromStepId is required');

    try {
        const { prunedStepIds, keptStepIds } = await ctx.workDir.markStale(fromStepId);
        const durationMs = Date.now() - t0;
        return mkOk(name, durationMs, {
            ok:            true,
            fromStepId,
            prunedStepIds,
            keptStepIds,
            durationMs,
            notice: `${prunedStepIds.length} step(s) marked stale. Returning to Explore — re-probe the affected region.`,
        }, `invalidate from '${fromStepId}': ${prunedStepIds.length} pruned in ${durationMs}ms`);
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'error', e && e.message || String(e));
    }
}

// ── Finalize ─────────────────────────────────────────────────────────────────

/**
 * Terminate the Fairy run as failed or escalate. Does NOT trigger delivered
 * (that is harness-owned on a passing verify). Returns a result that the FSM
 * loop interprets as a termination signal.
 */
function handleFinalize(args, _ctx) {
    const name    = 'finalize';
    const status  = String(args.status  || '').trim();
    const summary = String(args.summary || '').trim();
    const reason  = String(args.reason  || '').trim();

    if (status !== 'failed' && status !== 'escalate') {
        return mkErr(name, 0, 'bad_args',
            `status must be 'failed' or 'escalate' (got '${status}'). ` +
            `Do NOT call finalize with 'delivered' — the harness triggers that automatically.`);
    }
    if (!summary) return mkErr(name, 0, 'bad_args', 'summary is required');
    if (!reason)  return mkErr(name, 0, 'bad_args', 'reason is required');

    return mkOk(name, 0, {
        ok:      true,
        status,
        summary,
        reason,
        notice:  `Fairy terminating with status '${status}'.`,
    }, `finalize '${status}'`);
}

// ── Polish-phase tools ────────────────────────────────────────────────────────

/**
 * run_clean: restart the working kernel, evaluate every Wolfram code cell in
 * clean.wb in sequence, and report per-cell errors and messages to the agent.
 *
 * The agent MUST call this (and receive allClean: true) before emitting the
 * clean_verified control signal.
 */
async function handleRunClean(_args, ctx) {
    const name = 'run_clean';
    const { workDir, shim, signal } = ctx;
    const t0 = Date.now();

    // Restart the working kernel first (fresh state, no prior definitions)
    const restart = await shim.restartKernel().catch(e => ({ ok: false, reason: e.message }));
    if (!restart.ok) {
        return mkErr(name, Date.now() - t0, 'restart_failed',
            `Kernel restart failed: ${restart.reason || 'unknown'}. Cannot verify.`);
    }

    // Use the VS Code NotebookController path (runNotebook) so cells are executed
    // identically to the user clicking "Run All" — outputs appear in the notebook,
    // and wolfbook renders them richly. Falls back to evalOnce in non-VS Code contexts.
    let runResult;
    try {
        runResult = await shim.runNotebook(workDir.cleanNb, { signal, timeoutSeconds: 120 });
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'run_error',
            `runNotebook failed: ${e && e.message || String(e)}`);
    }

    if (runResult.cellCount === 0) {
        return mkErr(name, Date.now() - t0, 'no_cells',
            'clean.wb has no Wolfram code cells. Was compile successful?');
    }

    const { allClean, cellCount, failures, allResults } = runResult;

    return mkOk(name, Date.now() - t0, {
        allClean,
        cellCount,
        summary: allClean
            ? `All ${cellCount} code cell(s) ran cleanly — no errors or warnings.`
            : `${failures.length} of ${cellCount} cell(s) had errors or warnings.`,
        failures: failures.map(f => ({
            cellIndex: f.cellIndex,
            cellId:    f.cellId,
            error:     f.error,
            messages:  f.messages,
            output:    f.output ? f.output.slice(0, 300) : null,
        })),
        allResults: allClean ? [] : allResults.map(f => ({
            cellIndex: f.cellIndex, cellId: f.cellId,
            clean: f.clean, output: f.output ? f.output.slice(0, 200) : null,
            messages: f.messages, error: f.error,
        })),
    }, allClean
        ? `run_clean: all ${cellCount} cells OK`
        : `run_clean: ${failures.length} failure(s) in clean.wb`);
}

/**
 * edit_cell: replace the code in a cell (by index among code cells) in either
 * clean.wb or working.wb. Use this to fix errors or warnings found by run_clean.
 */
async function handleEditCell(args, ctx) {
    const name = 'edit_cell';
    const fsp  = require('fs/promises');
    const { workDir } = ctx;
    const t0 = Date.now();

    const { notebook, cellIndex, newCode } = args;

    if (!['clean', 'working'].includes(notebook)) {
        return mkErr(name, 0, 'bad_args', 'notebook must be "clean" or "working"');
    }
    if (typeof cellIndex !== 'number' || !Number.isInteger(cellIndex) || cellIndex < 0) {
        return mkErr(name, 0, 'bad_args', 'cellIndex must be a non-negative integer');
    }
    if (typeof newCode !== 'string' || !newCode.trim()) {
        return mkErr(name, 0, 'bad_args', 'newCode must be a non-empty string');
    }

    const nbPath = notebook === 'clean' ? workDir.cleanNb : workDir.workingNb;

    let nb;
    try {
        const raw = await fsp.readFile(nbPath, 'utf8');
        nb = JSON.parse(raw);
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'read_error',
            `Cannot read ${notebook}.wb: ${e.message}`);
    }

    // Find the nth code cell (by index among code cells, ignoring markup cells)
    let codeIdx = 0;
    let found = false;
    for (let i = 0; i < nb.cells.length; i++) {
        const c = nb.cells[i];
        if (c.kind === 2) {
            if (codeIdx === cellIndex) {
                nb.cells[i] = { ...c, value: newCode };
                found = true;
                break;
            }
            codeIdx++;
        }
    }

    if (!found) {
        const totalCode = (nb.cells || []).filter(c => c.kind === 2).length;
        return mkErr(name, Date.now() - t0, 'out_of_range',
            `cellIndex ${cellIndex} is out of range — ${notebook}.wb has ${totalCode} code cell(s) (0 to ${totalCode - 1})`);
    }

    try {
        await fsp.writeFile(nbPath, JSON.stringify(nb, null, 2), 'utf8');
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'write_error',
            `Cannot write ${notebook}.wb: ${e.message}`);
    }

    return mkOk(name, Date.now() - t0, {
        ok:        true,
        notebook,
        cellIndex,
        summary:   `Updated code cell ${cellIndex} in ${notebook}.wb`,
    }, `edit_cell: ${notebook}.wb[${cellIndex}] updated`);
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function handleWritePartialReport(args, ctx) {
    const name = 'write_partial_report';
    const { workDir } = ctx;
    const t0 = Date.now();

    const { summary, failedAttempts = [], openQuestions = [], recommendations } = args;
    if (!summary || !recommendations) {
        return mkErr(name, Date.now() - t0, 'missing_fields',
            'write_partial_report requires both summary and recommendations fields.');
    }

    // Read current chain state from disk
    let steps = [], inputs = [], assumptions = [], taskTitle = '';
    try { steps       = await workDir.loadAllSteps();    } catch (_) {}
    try { inputs      = await workDir.loadInputs();      } catch (_) {}
    try { assumptions = await workDir.loadAssumptions(); } catch (_) {}
    // taskTitle not stored in workDir — the partial notebook header will derive it from inputs

    let nbPath;
    try {
        nbPath = await workDir.writePartialNotebook({
            steps, inputs, assumptions, taskTitle,
            summary, failedAttempts, openQuestions, recommendations,
        });
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'write_error',
            `Failed to write clean_partial.wb: ${e && e.message || String(e)}`);
    }

    return mkOk(name, Date.now() - t0, {
        ok: true,
        path: nbPath,
        stepsIncluded: steps.filter(s => !s.stale).length,
        message: 'clean_partial.wb written. You may now stop — this run will be marked partial_delivered.',
    }, `Partial report written: ${steps.filter(s => !s.stale).length} steps, ${failedAttempts.length} failed attempts.`);
}

// ── Plan ──────────────────────────────────────────────────────────────────────

/**
 * Record the fairy's intended execution plan at the start of a run.
 * Persists to plan.json; the bus event is emitted by fairy.js so the
 * UI can insert a roadmap cell into working.wb.
 */
async function handlePlan(args, ctx) {
    const t0    = Date.now();
    const name  = 'plan';
    const steps = Array.isArray(args.steps) ? args.steps.map(String) : [];
    const note  = String(args.note || '').trim();

    if (steps.length < 2)  return mkErr(name, 0, 'bad_args', 'steps must have at least 2 items');
    if (steps.length > 10) return mkErr(name, 0, 'bad_args', 'steps must have at most 10 items');

    await ctx.workDir.savePlan({ steps, note });
    const durationMs = Date.now() - t0;

    return mkOk(name, durationMs, {
        ok:        true,
        stepCount: steps.length,
        note,
        message:   `Plan recorded (${steps.length} steps). Proceed to your first probe now.`,
    }, `plan: ${steps.length} steps recorded`);
}

// ── note_fact (R2) ────────────────────────────────────────────────────────────

/**
 * Record an established result into durable memory so the agent never re-derives it.
 * Persisted to facts.json; surfaced in context every turn via buildFactsLedger.
 */
async function handleNoteFact(args, ctx) {
    const t0    = Date.now();
    const name  = 'note_fact';
    const key   = String(args.key || '').trim();
    const value = String(args.value || '').trim();
    const confidence = ['high', 'medium', 'low'].includes(args.confidence) ? args.confidence : 'medium';
    const provenance = String(args.provenance || '').trim();

    if (!key)   return mkErr(name, 0, 'bad_args', 'key is required');
    if (!value) return mkErr(name, 0, 'bad_args', 'value is required');

    await ctx.workDir.addFact({ key, value, confidence, provenance });
    const durationMs = Date.now() - t0;

    return mkOk(name, durationMs, {
        ok:         true,
        key,
        confidence,
        message:    `Fact '${key}' saved (${confidence}). It will appear under "Established results" every turn — reference it instead of re-deriving.`,
    }, `note_fact: '${key}' saved (${confidence})`);
}

// ── cite_skill (skill attribution) ────────────────────────────────────────────

/**
 * The agent explicitly declares it used a recalled SkilXiv skill, and how. This is
 * the authoritative "skill was used" signal (replaces the false-positive-prone token
 * heuristic). Only a recalled skill may be cited.
 */
async function handleCiteSkill(args, ctx) {
    const t0       = Date.now();
    const name     = 'cite_skill';
    const skillRef = String(args.skillRef || '').trim();
    const how      = String(args.how || '').trim();

    if (!skillRef) return mkErr(name, 0, 'bad_args', 'skillRef is required');
    if (!how)      return mkErr(name, 0, 'bad_args', 'how is required — state specifically how the skill helped');

    // Only a skill that was actually recalled into context may be cited.
    const recalled = (ctx.recalledSkillRefs || []);
    if (recalled.length && !recalled.includes(skillRef)) {
        return mkErr(name, 0, 'not_recalled',
            `'${skillRef}' was not recalled for this run. You may only cite a skill that appears in your context. Recalled: [${recalled.join(', ') || 'none'}].`);
    }

    await ctx.workDir.addCitedSkill({ skillRef, how });
    const durationMs = Date.now() - t0;
    return mkOk(name, durationMs, {
        ok:       true,
        skillRef,
        message:  `Cited '${skillRef}' as used. This run will credit the skill (used_reproduced on delivery).`,
    }, `cite_skill: '${skillRef}'`);
}

// ── research_literature (bounded literature sub-agent) ───────────────────────

/**
 * Dispatch the bounded literature sub-agent (literature.runResearch) over the
 * wolfbook paper-search tools, persist the resulting brief, and return a
 * CONDENSED, model-facing payload. Equations are flagged as UNVERIFIED — the
 * agent must reproduce them in the kernel before recording. Cited papers are
 * persisted to literature.json and surfaced in the run's citation block.
 */
const LITERATURE_QUERY_CAP = 3;   // #5: hard cap on literature searches per run

async function handleResearchLiterature(args, ctx) {
    const t0   = Date.now();
    const name = 'research_literature';
    const question = String(args.question || '').trim();
    if (question.length < 8) return mkErr(name, 0, 'bad_args', 'question is required (≥8 chars)');

    if (!ctx.paperTools) {
        return mkErr(name, Date.now() - t0, 'unavailable',
            'literature search is not available in this run (no paper tools wired).');
    }

    // #5/#6: ration literature searches. Load prior briefs to (a) hard-cap the number
    // of searches, and (b) reject a near-duplicate of a question already tried — both
    // were the failure mode in run_2026-06-22T19-41-13 (7 near-identical queries).
    let priorBriefs = [];
    try { if (ctx.workDir && ctx.workDir.loadLiteratureBriefs) priorBriefs = await ctx.workDir.loadLiteratureBriefs(); } catch (_) {}
    if (priorBriefs.length >= LITERATURE_QUERY_CAP) {
        return mkErr(name, Date.now() - t0, 'budget_spent',
            `Literature budget spent (${priorBriefs.length} searches already). Do NOT search again — ` +
            `derive the result directly with probes. Re-running search will not help.`);
    }
    for (const b of priorBriefs) {
        if (b && b.question && utilSimilarity(b.question, question) >= 0.6) {
            return mkErr(name, Date.now() - t0, 'duplicate_query',
                `This is nearly the same as a literature search you already ran ("${String(b.question).slice(0, 80)}"), ` +
                `which returned ${((b.papers || []).length)} papers / ${((b.key_equations || []).length)} equations. ` +
                `Rephrasing will not find new results — proceed with probes.`);
        }
    }

    let brief;
    try {
        brief = await runResearch({
            question,
            paperTools: ctx.paperTools,
            llm:        ctx.literatureLlm,   // may be undefined → keyword/top-k fallback
            signal:     ctx.signal,
        });
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'failed', `literature research failed: ${e && e.message || e}`);
    }

    // Persist the full brief; cite papers at run end.
    try { if (ctx.workDir && ctx.workDir.addLiteratureBrief) await ctx.workDir.addLiteratureBrief(brief); } catch (_) {}

    const papers       = (brief.papers || []);        // RELEVANT papers only (post-read judgment)
    const equations    = (brief.key_equations || []);
    const observations = (brief.observations || []);
    const considered   = (brief.considered || []);
    const rejected     = considered.filter(c => c.relevant === false);
    const uncertain    = (brief.uncertain || []);   // #5: judge couldn't classify — surfaced, not dropped
    const searchesUsed = priorBriefs.length + 1;
    const searchesLeft = Math.max(0, LITERATURE_QUERY_CAP - searchesUsed);

    if (!papers.length) {
        // #6: after the budget is nearly gone, tell the model to STOP searching.
        const stop = searchesLeft <= 1;
        const readNote = considered.length
            ? `Read ${considered.length} paper(s); none were judged relevant to this task.`
            : (brief.note || 'no papers found');
        return mkOk(name, Date.now() - t0, {
            ok: true, question, papers: [], key_equations: [], observations: [],
            note: readNote,
            // #5: a glitchy judge no longer silently deletes papers — surface the unjudged
            // ones so the agent can decide, instead of seeing a bare "0 relevant".
            uncertain: uncertain.slice(0, 4).map(u => ({ ref: u.ref, title: u.title, why: u.reason })),
            reminder: stop
                ? 'No relevant literature found and the search budget is nearly spent. STOP searching — ' +
                  'derive the result directly with probes.'
                : (uncertain.length
                    ? `No paper was confidently judged relevant, but ${uncertain.length} could not be classified ` +
                      '(judge parse failure) — they are listed under "uncertain"; skim them before searching again.'
                    : 'No relevant literature found for this phrasing. Proceed with your own derivation; ' +
                      'only search again if you can name a clearly different method or model.'),
        }, `research_literature: 0 relevant, ${uncertain.length} uncertain (read ${considered.length}) for "${question.slice(0, 50)}"`, { brief });
    }

    // Condense for the model: relevant papers (with WHY), extracted relations, observations.
    const payload = {
        ok: true,
        question,
        papers: papers.slice(0, 5).map(p => ({
            title: p.title, year: p.year, ref: p.ref,
            authors: (p.authors || []).slice(0, 3),
            relevant_because: p.reason,
            fullTextRead: !!p.fullText,
        })),
        key_relations: equations.slice(0, 12).map(e => ({
            statement: String(e.statement || '').slice(0, 200) || undefined,
            latex:     String(e.latex || '').slice(0, 240) || undefined,
            source:    e.source,
        })),
        observations: observations.slice(0, 8).map(o => ({ text: String(o.text || '').slice(0, 200), source: o.source })),
        rejected: rejected.slice(0, 4).map(r => ({ ref: r.ref, why_not: r.reason })),
        searchesLeft,
        reminder:
            'These relations/equations are UNVERIFIED transcriptions from the literature. Reproduce ' +
            'each one with a probe before you record or note_fact it. Only the RELEVANT papers above ' +
            'are returned (off-topic ones were read and rejected) and are cited automatically at run end.' +
            (searchesLeft === 0 ? ' Literature budget is now spent — do not search again.' : ''),
    };

    if (JSON.stringify(payload).length > 4200) {
        payload.key_relations = payload.key_relations.slice(0, 6);
        payload.observations  = payload.observations.slice(0, 4);
        payload.rejected      = payload.rejected.slice(0, 2);
    }

    return mkOk(name, Date.now() - t0, payload,
        `research_literature: ${papers.length} relevant (read ${considered.length}), ${equations.length} relations`,
        { brief });
}

// ── Define utility function ───────────────────────────────────────────────────

/**
 * Register a verified helper function for reuse. Evaluates the definition in
 * the live kernel now and persists it to utils.json. Future probes auto-prepend
 * all registered utils so the function is always available.
 */
async function handleDefineUtil(args, ctx) {
    const t0   = Date.now();
    const name = 'define_util';
    const utilName = String(args.name || '').trim();
    const code     = String(args.code || '').trim();
    const note     = String(args.note || '').trim();

    if (!utilName) return mkErr(name, 0, 'bad_args', 'name is required');
    if (!code)     return mkErr(name, 0, 'bad_args', 'code is required');
    if (!note)     return mkErr(name, 0, 'bad_args', 'note is required');

    // P1 anti-fork: reject a util that is really a re-derivation of an existing one under
    // a new name (the su3TQSolver→su3TQFixed→su3TQFinal pattern). Redefining the SAME name
    // is fine (that's a correction); forking a near-duplicate to a NEW name is the problem.
    const existingUtils = await ctx.workDir.loadUtils().catch(() => []);
    const UTIL_CAP = 12;
    if (existingUtils.length >= UTIL_CAP && !existingUtils.some(u => u.name === utilName)) {
        return mkErr(name, 0, 'util_cap',
            `Too many utilities (${existingUtils.length}). Consolidate existing helpers (invalidate + redefine) before adding more.`);
    }
    for (const u of existingUtils) {
        if (u.name !== utilName && utilSimilarity(u.code, code) >= 0.6) {
            return mkErr(name, 0, 'util_fork',
                `This is a near-duplicate of the existing util '${u.name}'. Do NOT fork a new name — ` +
                `\`invalidate\` the step that uses '${u.name}', then redefine '${u.name}' itself ` +
                `(use a leading "(* redefine: ${u.name} *)" in a probe). Reusing one name keeps the chain clean.`);
        }
    }

    // Evaluate the definition to verify it works
    let r;
    try {
        r = await ctx.shim.evalOnce({ expression: code, timeoutSeconds: ctx.shim.DEFAULT_TIMEOUT, signal: ctx.signal });
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'eval_error', `Utility '${utilName}' failed to evaluate: ${e && e.message || String(e)}`);
    }

    if (!r.ok || (r.messages && r.messages.length)) {
        const err = r.error || r.messages || r.kind || 'unknown error';
        return mkErr(name, Date.now() - t0, 'eval_failed',
            `Utility '${utilName}' evaluated with errors/messages: ${err}. Fix the definition before registering it.`);
    }

    await ctx.workDir.addUtil({ name: utilName, code, note });
    const durationMs = Date.now() - t0;

    return mkOk(name, durationMs, {
        ok:       true,
        utilName,
        message:  `'${utilName}' registered. It will be prepended automatically before every subsequent probe.`,
    }, `define_util: '${utilName}' registered in ${durationMs}ms`);
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

/**
 * Commit a set of valid recorded steps as a named section in clean_in_progress.wb.
 * The section persists permanently — independent of the run outcome.
 */
async function handleCheckpoint(args, ctx) {
    const t0           = Date.now();
    const name         = 'checkpoint';
    const sectionTitle = String(args.sectionTitle || '').trim();
    const stepIds      = Array.isArray(args.stepIds) ? args.stepIds : [];

    if (!sectionTitle) return mkErr(name, 0, 'bad_args', 'sectionTitle is required');
    if (!stepIds.length) return mkErr(name, 0, 'bad_args', 'stepIds must be a non-empty array');

    const allSteps   = await ctx.workDir.loadAllSteps().catch(() => []);
    const validSteps = allSteps.filter(s => s.status === 'valid');
    const selected   = validSteps.filter(s => stepIds.includes(s.id));

    if (!selected.length) {
        return mkErr(name, 0, 'no_valid_steps',
            `None of the specified stepIds [${stepIds.join(', ')}] are valid recorded steps. ` +
            `Valid steps: [${validSteps.map(s => s.id).join(', ') || 'none'}]`);
    }

    const inputs      = await ctx.workDir.loadInputs().catch(() => []);
    const assumptions = await ctx.workDir.loadAssumptions().catch(() => []);

    await ctx.workDir.appendCheckpointSection({ sectionTitle, steps: selected, inputs, assumptions });
    const durationMs = Date.now() - t0;

    return mkOk(name, durationMs, {
        ok:             true,
        sectionTitle,
        stepsIncluded:  selected.map(s => s.id),
        checkpointPath: ctx.workDir.checkpointNb,
        message:        `Section '${sectionTitle}' committed (${selected.length} steps). ` +
                        `These results are permanently saved in clean_in_progress.wb. ` +
                        `You may now continue to the next sub-problem.`,
    }, `checkpoint: '${sectionTitle}' (${selected.length} steps) in ${durationMs}ms`);
}

// ── ask_specialist handler ──────────────────────────────────────────────────

async function handleAskSpecialist(args, ctx) {
    const t0       = Date.now();
    const name     = 'ask_specialist';
    const question = String(args.question || '').trim();
    const context  = String(args.context  || '').trim();

    if (!question) return mkErr(name, 0, 'bad_args', 'question is required');

    if (typeof ctx.askUser !== 'function') {
        return mkOk(name, Date.now() - t0, {
            ok: true, answered: false,
            message: 'ask_specialist is disabled. Proceed with your best judgment.',
        }, `ask_specialist: disabled`);
    }

    try {
        const answer = await ctx.askUser(question, context);
        const durationMs = Date.now() - t0;
        if (answer === null || answer === undefined) {
            return mkOk(name, durationMs, {
                ok: true, answered: false,
                message: 'The specialist dismissed the question. Proceed with your best judgment.',
            }, `ask_specialist: dismissed in ${durationMs}ms`);
        }
        const text = String(answer).trim();
        return mkOk(name, durationMs, {
            ok: true,
            answered: !!text,
            answer:   text || '(no text provided)',
            message:  text
                ? `Specialist replied: "${text.slice(0, 200)}"`
                : 'Specialist dismissed without providing an answer.',
        }, `ask_specialist: ${text ? 'answered' : 'dismissed'} in ${durationMs}ms`);
    } catch (e) {
        return mkErr(name, Date.now() - t0, 'error', e && e.message || String(e));
    }
}

const HANDLERS = {
    plan:                 handlePlan,
    probe:                handleProbe,
    amend_probe:          handleAmendProbe,
    inspect:              handleInspect,
    lookup:               handleLookup,
    record:               handleRecord,
    note_fact:            handleNoteFact,
    cite_skill:           handleCiteSkill,
    research_literature:  handleResearchLiterature,
    assume:               handleAssume,
    chain:                handleChain,
    define_util:          handleDefineUtil,
    checkpoint:           handleCheckpoint,
    invalidate:           handleInvalidate,
    finalize:             handleFinalize,
    run_clean:            handleRunClean,
    edit_cell:            handleEditCell,
    write_partial_report: handleWritePartialReport,
    ask_specialist:       handleAskSpecialist,
};

/**
 * Dispatch a fairy tool call. Never throws.
 *
 * @param {{ name: string, args: object }} call
 * @param {{ workDir, shim, signal? }} ctx
 * @returns {Promise<object>}   structured tool result
 */
async function dispatchFairyTool(call, ctx) {
    const name = String(call && call.name || '');
    const args = (call && call.args) || {};
    const handler = HANDLERS[name];
    if (!handler) {
        return mkErr(name || 'unknown', 0, 'unknown_tool',
            `Unknown fairy tool '${name}'. Available: ${Object.keys(HANDLERS).join(', ')}.`);
    }
    try {
        return await handler(args, ctx);
    } catch (e) {
        return mkErr(name, 0, 'internal_error', e && e.message || String(e));
    }
}

module.exports = {
    dispatchFairyTool,
    detectRedefinition,
    lintWolfram,
    utilSimilarity,
    extractDefinedSymbols,
    extractRedefineWhitelist,
    handlePlan,
    handleProbe,
    handleAmendProbe,
    handleInspect,
    handleLookup,
    handleRecord,
    handleNoteFact,
    handleCiteSkill,
    handleResearchLiterature,
    handleAssume,
    handleChain,
    handleDefineUtil,
    handleCheckpoint,
    handleInvalidate,
    handleFinalize,
    handleRunClean,
    handleEditCell,
    handleWritePartialReport,
    handleAskSpecialist,
    computeStructuralSummary,
};
