// mmaBlocks.js — the managed-computation grammar inside an ordinary .tex.
//
// Pure: no vscode, no fs, no kernel, never throws. READS ONLY — the canonical
// writer is tex/mmaWrite.js, deliberately a separate module so that the thing
// which decides what a block MEANS and the thing which decides how a block is
// SPELLED cannot drift apart inside one file.
//
// The grammar (vision §63), all inside TeX comments so the .tex still compiles
// on a plain latexmk with no Wolfbook anywhere:
//
//   %Mathematica[notebook, BlockID: 4f2a, name -> "branch"]
//   %%Markdown[out -> insert, CellID: m1]
//   % The branch points solve $\operatorname{disc}(g)=0$.
//   %%Wolfram[CellID: c1, out -> insert, kind -> figure]
//   %  branchPoints[g_] := NSolve[disc[g] == 0, u];
//   %  ListPlot[branchPoints /@ gGrid, Joined -> True]
//   %%Wolfram[out -> none]
//   %  (* scratch, never reaches the paper *)
//   %EndMathematica
//   %WolfbookOutputBegin[CellID: c1, BlockID: 4f2a, SourceHash: a91c…, OutputHash: 7de1…]
//   \begin{figure}[t] … \end{figure}
//   %WolfbookOutputEnd
//
// A block with no %% directive at all is ONE implicit Wolfram cell, which is
// exactly the Stage-1 shape — every .tex written before multi-cell existed
// parses identically, and its fence keeps adjudicating, because the implicit
// cell's source hash is the hash of the whole undecorated region.
//
// Why `%%` and not `%Cell[...]`: code lines are decorated as '% ' + line, so a
// real Wolfram line starting with `%` is written `% %foo` and can never yield
// `%%` at column 0. A single-% directive would be ambiguous — `%Cell[…]`
// undecorates to `Cell[…]`, which is a legitimate Wolfram expression.
//
// Fences are paired to cells by CellID, never by position, so reordering cells
// in the editor cannot mispair a cell with someone else's output.
//
// States use the vocabulary already in tools/cell-state.js rather than a
// parallel one, so a reader who knows how notebook cells go stale does not
// have to learn a second scheme.

const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Block states. `fresh` and `stale` mirror CELL_STATE; the other three are
 * shapes a notebook cell cannot get into because its output is not editable
 * text sitting in the same file.
 */
const BLOCK_STATE = {
    FRESH: 'fresh',                       // output matches the code that made it
    STALE: 'stale',                       // the code changed since the output was written
    MODIFIED_BY_USER: 'modified-by-user', // the output was hand-edited
    ORPHANED: 'orphaned',                 // an output fence with no block above it
    MALFORMED: 'malformed',               // unbalanced or unparseable fences
    NO_OUTPUT: 'no-output',               // a block that has never been run
    EPHEMERAL: 'ephemeral',               // deliberately not stored in the paper
};

const BLOCK_STATE_REASON = {
    [BLOCK_STATE.FRESH]: 'output is current for this code',
    [BLOCK_STATE.STALE]: 'generating code changed since this output was written',
    [BLOCK_STATE.MODIFIED_BY_USER]: 'output was edited by hand after it was generated',
    [BLOCK_STATE.ORPHANED]: 'managed output with no generating block',
    [BLOCK_STATE.MALFORMED]: 'fences are unbalanced or the header cannot be parsed',
    [BLOCK_STATE.NO_OUTPUT]: 'block has never produced managed output',
    [BLOCK_STATE.EPHEMERAL]: 'output is not materialised in the paper by choice',
};

// Worst-first. A block reports the worst state among its cells, so a roadmap of
// green blocks cannot hide one stale cell inside a block.
const STATE_SEVERITY = [
    BLOCK_STATE.MALFORMED,
    BLOCK_STATE.ORPHANED,
    BLOCK_STATE.STALE,
    BLOCK_STATE.MODIFIED_BY_USER,
    BLOCK_STATE.NO_OUTPUT,
    BLOCK_STATE.FRESH,
    BLOCK_STATE.EPHEMERAL,
];

const RE_BEGIN = /^[ \t]*%Mathematica(\[[^\]\n]*\])?[ \t]*$/;
const RE_END = /^[ \t]*%EndMathematica[ \t]*$/;
const RE_OUT_BEGIN = /^[ \t]*%WolfbookOutputBegin(\[[^\]\n]*\])?[ \t]*$/;
// The vision document writes the closer as %WolfbookOutputEnd[CellID=…]; the
// writer emits the bare form, but both must be read or a hand-copied example
// from the docs would classify as malformed.
const RE_OUT_END = /^[ \t]*%WolfbookOutputEnd(\[[^\]\n]*\])?[ \t]*$/;
// A cell directive. The keyword is required: without it `%%` inside a block of
// hand-written TeX would silently split someone's code in half.
const RE_CELL = /^[ \t]*%%(Wolfram|Markdown|Text)(\[[^\]\n]*\])?[ \t]*$/i;

/**
 * Parse a bracketed header into a plain object.
 *
 *   [figure, name -> "branch", format -> PDF]  ->
 *     { _positional: ['figure'], name: 'branch', format: 'PDF' }
 *   [CellID: 4f2a, SourceHash: a91c]           ->
 *     { CellID: '4f2a', SourceHash: 'a91c' }
 *
 * Both `->` and `:` are accepted because the vision document uses the first for
 * options and the second for provenance, and there is no reason to be strict
 * about which side of the file you are on. Unparseable pieces are collected in
 * `_unparsed` rather than dropped — a header we do not understand must not
 * silently look like an empty one.
 */
function parseHeader(raw) {
    const out = { _positional: [], _unparsed: [] };
    if (!raw) return out;
    const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
    if (!inner) return out;
    for (const part of splitTopLevel(inner)) {
        const s = part.trim();
        if (!s) continue;
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(->|:)\s*(.*)$/.exec(s);
        if (!m) {
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) out._positional.push(s);
            else out._unparsed.push(s);
            continue;
        }
        let v = m[3].trim();
        if (/^"(.*)"$/.test(v)) v = v.slice(1, -1);
        out[m[1]] = v;
    }
    return out;
}

/** Split on commas that are not inside quotes or brackets. */
function splitTopLevel(s) {
    const parts = []; let depth = 0; let quoted = false; let cur = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quoted) { if (c === '"' && s[i - 1] !== '\\') quoted = false; cur += c; continue; }
        if (c === '"') { quoted = true; cur += c; continue; }
        if (c === '[' || c === '{' || c === '(') depth++;
        if (c === ']' || c === '}' || c === ')') depth--;
        if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
}

/** Strip the leading `%` and one optional space from each code line. */
function undecorate(lines) {
    return lines.map(l => l.replace(/^[ \t]*%[ \t]?/, '')).join('\n');
}

/**
 * Does this cell's output belong in the paper?
 *
 * Wolfram cells default to yes and Markdown cells default to no, which is the
 * reading that needs the fewest explicit flags in the common case: a dropped
 * computation is there to put something on the page, and prose written beside
 * it is usually a note about the computation rather than paper text. The writer
 * always spells out the non-default, so a round trip never depends on this.
 */
function readInclude(opts, kind) {
    const raw = String(opts.out ?? opts.Out ?? '').trim().toLowerCase();
    if (raw === 'none' || raw === 'false') return false;
    if (raw === 'insert' || raw === 'true') return true;
    return kind === 'wolfram';
}

/**
 * Split a block's decorated body into cells.
 *
 * @param {string[]} rawLines   the lines between %Mathematica and %EndMathematica
 * @param {number}   firstLineNo 1-based line number of rawLines[0]
 *
 * A body with no directive is one implicit Wolfram cell spanning everything —
 * that is what keeps every pre-multi-cell .tex parsing exactly as it did.
 */
function parseCells(rawLines, firstLineNo) {
    const cells = [];
    let cur = null;
    const close = () => {
        if (!cur) return;
        cur.code = undecorate(cur._lines);
        cur.sourceHash = sha256(cur.code);
        delete cur._lines;
        cells.push(cur);
    };
    for (let n = 0; n < rawLines.length; n++) {
        const m = RE_CELL.exec(rawLines[n]);
        if (m) {
            close();
            const opts = parseHeader(m[2]);
            const word = m[1].toLowerCase();
            const kind = word === 'wolfram' ? 'wolfram' : 'markdown';
            cur = {
                kind,
                cellId: opts.CellID || opts.cellId || null,
                include: readInclude(opts, kind),
                options: opts,
                directiveLine: firstLineNo + n,
                startLine: firstLineNo + n + 1,
                endLine: firstLineNo + n,
                _lines: [],
            };
            continue;
        }
        if (!cur) {
            cur = {
                kind: 'wolfram', cellId: null, include: true, options: {},
                implicit: true, directiveLine: null,
                startLine: firstLineNo + n, endLine: firstLineNo + n, _lines: [],
            };
        }
        cur._lines.push(rawLines[n]);
        cur.endLine = firstLineNo + n;
    }
    close();
    if (!cells.length) {
        // An empty block still has one cell to type into.
        cells.push({
            kind: 'wolfram', cellId: null, include: true, options: {}, implicit: true,
            directiveLine: null, startLine: firstLineNo, endLine: firstLineNo - 1,
            code: '', sourceHash: sha256(''),
        });
    }
    return cells;
}

/**
 * @param {string} src
 * @param {{file?: string}} opts
 * @returns {{blocks: object[], outputs: object[], warnings: string[]}}
 *
 * Every block carries `state`, `stateReason`, and 1-based `startLine`/`endLine`
 * for itself and for its output region, so a caller can put a decoration on
 * either without re-scanning.
 */
function parseMmaBlocks(src, opts = {}) {
    const file = opts.file || '<string>';
    const lines = String(src).split('\n');
    const blocks = [];
    const outputs = [];
    const warnings = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (RE_BEGIN.test(line)) {
            const startLine = i + 1;
            const header = parseHeader(RE_BEGIN.exec(line)[1]);
            const codeLines = [];
            let j = i + 1;
            let closed = false;
            while (j < lines.length) {
                if (RE_END.test(lines[j])) { closed = true; break; }
                // A second %Mathematica before %EndMathematica means the first
                // was never closed. Stop here rather than swallowing the next
                // block whole.
                if (RE_BEGIN.test(lines[j])) break;
                codeLines.push(lines[j]);
                j++;
            }
            if (!closed) {
                warnings.push(`${file}:${startLine}: %Mathematica block never closed with %EndMathematica`);
                blocks.push(makeBlock({
                    file, header, startLine, endLine: Math.min(j, lines.length),
                    codeLines, bodyFirstLine: startLine + 1, state: BLOCK_STATE.MALFORMED,
                }));
                i = j;
                continue;
            }
            const endLine = j + 1;

            // A RUN of output fences may follow, one per materialised cell,
            // separated by blank lines.
            const fences = [];
            let cursor = j + 1;
            for (;;) {
                let k = cursor;
                while (k < lines.length && /^[ \t]*$/.test(lines[k])) k++;
                if (!(k < lines.length && RE_OUT_BEGIN.test(lines[k]))) break;
                const outHeader = parseHeader(RE_OUT_BEGIN.exec(lines[k])[1]);
                const bodyLines = [];
                let m = k + 1;
                let outClosed = false;
                while (m < lines.length) {
                    if (RE_OUT_END.test(lines[m])) { outClosed = true; break; }
                    if (RE_OUT_BEGIN.test(lines[m]) || RE_BEGIN.test(lines[m])) break;
                    bodyLines.push(lines[m]);
                    m++;
                }
                if (!outClosed) {
                    warnings.push(`${file}:${k + 1}: %WolfbookOutputBegin never closed with %WolfbookOutputEnd`);
                }
                fences.push({
                    header: outHeader,
                    cellId: outHeader.CellID || outHeader.cellId || null,
                    startLine: k + 1,
                    endLine: outClosed ? m + 1 : Math.min(m, lines.length),
                    body: bodyLines.join('\n'),
                    closed: outClosed,
                });
                cursor = outClosed ? m + 1 : m;
                if (!outClosed) break;
            }
            i = fences.length ? cursor : j + 1;

            blocks.push(makeBlock({
                file, header, startLine, endLine,
                codeLines, bodyFirstLine: startLine + 1, fences,
            }));
            continue;
        }

        // An output fence reached without a block above it.
        if (RE_OUT_BEGIN.test(line)) {
            const outHeader = parseHeader(RE_OUT_BEGIN.exec(line)[1]);
            const bodyLines = [];
            let m = i + 1;
            let outClosed = false;
            while (m < lines.length) {
                if (RE_OUT_END.test(lines[m])) { outClosed = true; break; }
                if (RE_OUT_BEGIN.test(lines[m]) || RE_BEGIN.test(lines[m])) break;
                bodyLines.push(lines[m]);
                m++;
            }
            warnings.push(`${file}:${i + 1}: managed output with no %Mathematica block above it`);
            outputs.push({
                file, header: outHeader,
                cellId: outHeader.CellID || null,
                startLine: i + 1,
                endLine: outClosed ? m + 1 : Math.min(m, lines.length),
                body: bodyLines.join('\n'),
                closed: outClosed,
                state: outClosed ? BLOCK_STATE.ORPHANED : BLOCK_STATE.MALFORMED,
                stateReason: outClosed
                    ? BLOCK_STATE_REASON[BLOCK_STATE.ORPHANED]
                    : BLOCK_STATE_REASON[BLOCK_STATE.MALFORMED],
            });
            i = outClosed ? m + 1 : m;
            continue;
        }

        if (RE_OUT_END.test(line)) {
            warnings.push(`${file}:${i + 1}: %WolfbookOutputEnd with no matching begin`);
        }
        i++;
    }

    return { blocks, outputs, warnings, file };
}

/**
 * Classify one block.
 *
 * The three hashes in the fence header are what make this decidable without a
 * kernel:
 *   SourceHash  — of the code that produced the output. Differs => STALE.
 *   OutputHash  — of the output body as written. Differs => MODIFIED_BY_USER.
 * Hashes are compared by PREFIX, because the fence carries a short form for
 * legibility (`a91c…`) and demanding the full 64 chars would make every
 * hand-written example fail.
 */
function makeBlock({ file, header, startLine, endLine, codeLines, bodyFirstLine, fences, state }) {
    const code = undecorate(codeLines || []);
    const codeHash = sha256(code);
    const cells = parseCells(codeLines || [], bodyFirstLine || startLine + 1);
    const allFences = fences || [];
    const output = allFences[0] || null;

    // The CellID lives in the OUTPUT fence, not the %Mathematica header — see
    // the grammar at the top of this file. A block may also declare one, and
    // that wins, but in the shape the vision document specifies only the fence
    // carries it, so reading the block header alone leaves every run-and-
    // inserted block anonymous.
    const b = {
        file,
        cellId: header.CellID || header.cellId
            || (output && (output.header.CellID || output.header.cellId)) || null,
        kind: header._positional[0] || header.kind || 'expression',
        options: header,
        startLine, endLine,
        code,
        codeHash,
        cells,
        output,
        outputs: allFences,
    };
    b.blockId = header.BlockID || header.blockId || b.cellId
        || (output && (output.header.BlockID || output.header.blockId)) || null;

    if (state) {
        b.state = state;
        b.stateReason = BLOCK_STATE_REASON[state] || '';
        for (const c of cells) { c.state = state; c.stateReason = b.stateReason; }
        return b;
    }

    pairFences(cells, allFences);
    b.orphanedFences = allFences.filter(f => !f._cell);

    for (const c of cells) classifyCell(c, c._fence || null);
    // The whole-block ellipsis of the per-cell verdicts. Orphaned fences are
    // part of the block's story too: a fence whose cell was deleted is the
    // block's problem to show, not something to leave silently on the floor.
    const states = cells.map(c => c.state);
    if (b.orphanedFences.length) {
        states.push(b.orphanedFences.some(f => !f.closed)
            ? BLOCK_STATE.MALFORMED : BLOCK_STATE.ORPHANED);
    }
    b.state = worstState(states);
    b.stateReason = pickReason(b.state, cells);

    // Single-cell blocks keep reporting their provenance at block level, which
    // is what every Stage-1 consumer reads.
    if (cells.length === 1 && cells[0]._fence) {
        const f = cells[0]._fence;
        b.outputHash = sha256(f.body);
        b.declaredSourceHash = f.header.SourceHash || f.header.sourceHash || null;
        b.declaredOutputHash = f.header.OutputHash || f.header.outputHash || null;
    }
    // Record the pairing as INDICES and drop the object references. The
    // pairing is what the writer needs in order to replace the right fence,
    // but these blocks are handed to MCP callers as JSON, and a cell pointing
    // at a fence pointing back at the cell cannot be serialised.
    cells.forEach((c, ci) => {
        const fi = allFences.indexOf(c._fence);
        c.index = ci;
        c.outputIndex = fi >= 0 ? fi : null;
        delete c._fence;
    });
    allFences.forEach((f) => {
        const ci = cells.indexOf(f._cell);
        f.cellIndex = ci >= 0 ? ci : null;
        delete f._cell;
    });
    return b;
}

/**
 * Attach fences to cells.
 *
 * By CellID, so that reordering cells cannot mispair them. The one exception is
 * the legacy shape — one implicit cell and one fence — where the fence names an
 * id the cell has never heard of because pre-multi-cell blocks kept the id only
 * in the fence. There, the single pairing is unambiguous and the cell adopts it.
 */
function pairFences(cells, fences) {
    if (cells.length === 1 && fences.length === 1) {
        cells[0]._fence = fences[0];
        fences[0]._cell = cells[0];
        if (!cells[0].cellId) cells[0].cellId = fences[0].cellId;
        return;
    }
    for (const f of fences) {
        if (!f.cellId) continue;
        const c = cells.find(c => c.cellId && c.cellId === f.cellId && !c._fence);
        if (c) { c._fence = f; f._cell = c; }
    }
}

/** Classify one cell against its fence (or its absence). */
function classifyCell(cell, fence) {
    const set = (s, reason) => {
        cell.state = s;
        cell.stateReason = reason || BLOCK_STATE_REASON[s] || '';
        return cell;
    };
    if (!fence) {
        // Not having an output is only a gap if one was ever wanted.
        return set(cell.include ? BLOCK_STATE.NO_OUTPUT : BLOCK_STATE.EPHEMERAL);
    }
    if (!fence.closed) return set(BLOCK_STATE.MALFORMED);

    const declaredSource = fence.header.SourceHash || fence.header.sourceHash;
    const declaredOutput = fence.header.OutputHash || fence.header.outputHash;
    const bodyHash = sha256(fence.body);
    cell.outputHash = bodyHash;
    cell.declaredSourceHash = declaredSource || null;
    cell.declaredOutputHash = declaredOutput || null;

    if (!declaredSource && !declaredOutput) {
        // A fence with no provenance at all cannot be adjudicated. Saying
        // "fresh" would be a guess dressed as a fact.
        return set(BLOCK_STATE.MALFORMED, 'output fence carries neither SourceHash nor OutputHash');
    }
    if (declaredSource && !hashMatches(declaredSource, cell.sourceHash)) return set(BLOCK_STATE.STALE);
    if (declaredOutput && !hashMatches(declaredOutput, bodyHash)) return set(BLOCK_STATE.MODIFIED_BY_USER);
    return set(BLOCK_STATE.FRESH);
}

function worstState(states) {
    for (const s of STATE_SEVERITY) if (states.includes(s)) return s;
    return BLOCK_STATE.NO_OUTPUT;
}

/** The reason belonging to whichever cell earned the block its state. */
function pickReason(state, cells) {
    const c = cells.find(c => c.state === state);
    return (c && c.stateReason) || BLOCK_STATE_REASON[state] || '';
}

/** Prefix comparison, tolerant of the trailing ellipsis the fences use. */
function hashMatches(declared, actual) {
    const d = String(declared).replace(/[…\.]+$/, '').trim().toLowerCase();
    if (!d) return false;
    return actual.toLowerCase().startsWith(d);
}

/** Render a fence header for writing. The writer half lives in mmaWrite.js. */
function formatOutputFence(cellId, sourceHash, outputHash, { short = 8, blockId } = {}) {
    const s = String(sourceHash).slice(0, short);
    const o = String(outputHash).slice(0, short);
    const parts = [`CellID: ${cellId}`];
    if (blockId) parts.push(`BlockID: ${blockId}`);
    parts.push(`SourceHash: ${s}`, `OutputHash: ${o}`);
    return `%WolfbookOutputBegin[${parts.join(', ')}]`;
}

module.exports = {
    parseMmaBlocks,
    parseHeader,
    parseCells,
    readInclude,
    undecorate,
    formatOutputFence,
    hashMatches,
    sha256,
    BLOCK_STATE,
    BLOCK_STATE_REASON,
    STATE_SEVERITY,
    RE_BEGIN,
    RE_END,
    RE_CELL,
    RE_OUT_BEGIN,
    RE_OUT_END,
};
