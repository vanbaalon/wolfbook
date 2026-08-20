// mmaBlocks.js — the managed-computation grammar inside an ordinary .tex.
//
// Pure: no vscode, no fs, no kernel, never throws.
//
// STAGE 1 PARSES AND CLASSIFIES ONLY. Nothing here executes anything; running
// these blocks is Stage 4. The point of doing it now is that the state machine
// is the contract Stage 4 has to honour, and it is far cheaper to get the
// grammar and the vocabulary right before anything depends on them.
//
// The grammar (vision §63), all inside TeX comments so the .tex still compiles
// on a plain latexmk with no Wolfbook anywhere:
//
//   %Mathematica[figure, name -> "branch", format -> PDF]
//   %  branchPoints[g_] := NSolve[disc[g] == 0, u];
//   %  ListPlot[branchPoints /@ gGrid, Joined -> True]
//   %EndMathematica
//   %WolfbookOutputBegin[CellID: 4f2a, SourceHash: a91c…, OutputHash: 7de1…]
//   \begin{figure}[t] … \end{figure}
//   %WolfbookOutputEnd
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
};

const BLOCK_STATE_REASON = {
    [BLOCK_STATE.FRESH]: 'output is current for this code',
    [BLOCK_STATE.STALE]: 'generating code changed since this output was written',
    [BLOCK_STATE.MODIFIED_BY_USER]: 'output was edited by hand after it was generated',
    [BLOCK_STATE.ORPHANED]: 'managed output with no generating block',
    [BLOCK_STATE.MALFORMED]: 'fences are unbalanced or the header cannot be parsed',
    [BLOCK_STATE.NO_OUTPUT]: 'block has never produced managed output',
};

const RE_BEGIN = /^[ \t]*%Mathematica(\[[^\]\n]*\])?[ \t]*$/;
const RE_END = /^[ \t]*%EndMathematica[ \t]*$/;
const RE_OUT_BEGIN = /^[ \t]*%WolfbookOutputBegin(\[[^\]\n]*\])?[ \t]*$/;
const RE_OUT_END = /^[ \t]*%WolfbookOutputEnd[ \t]*$/;

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
                    code: undecorate(codeLines), state: BLOCK_STATE.MALFORMED,
                }));
                i = j;
                continue;
            }
            const endLine = j + 1;
            const code = undecorate(codeLines);

            // An output region may follow, after blank/comment lines.
            let k = j + 1;
            while (k < lines.length && /^[ \t]*$/.test(lines[k])) k++;
            let output = null;
            if (k < lines.length && RE_OUT_BEGIN.test(lines[k])) {
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
                output = {
                    header: outHeader,
                    startLine: k + 1,
                    endLine: outClosed ? m + 1 : Math.min(m, lines.length),
                    body: bodyLines.join('\n'),
                    closed: outClosed,
                };
                i = (outClosed ? m + 1 : m);
            } else {
                i = j + 1;
            }

            blocks.push(makeBlock({ file, header, startLine, endLine, code, output }));
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
function makeBlock({ file, header, startLine, endLine, code, output, state }) {
    const codeHash = sha256(code);
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
        output: output || null,
    };

    if (state) {
        b.state = state;
        b.stateReason = BLOCK_STATE_REASON[state] || '';
        return b;
    }
    if (!output) {
        b.state = BLOCK_STATE.NO_OUTPUT;
        b.stateReason = BLOCK_STATE_REASON[BLOCK_STATE.NO_OUTPUT];
        return b;
    }
    if (!output.closed) {
        b.state = BLOCK_STATE.MALFORMED;
        b.stateReason = BLOCK_STATE_REASON[BLOCK_STATE.MALFORMED];
        return b;
    }

    const declaredSource = output.header.SourceHash || output.header.sourceHash;
    const declaredOutput = output.header.OutputHash || output.header.outputHash;
    const bodyHash = sha256(output.body);

    b.outputHash = bodyHash;
    b.declaredSourceHash = declaredSource || null;
    b.declaredOutputHash = declaredOutput || null;

    if (declaredSource && !hashMatches(declaredSource, codeHash)) {
        b.state = BLOCK_STATE.STALE;
    } else if (declaredOutput && !hashMatches(declaredOutput, bodyHash)) {
        b.state = BLOCK_STATE.MODIFIED_BY_USER;
    } else if (!declaredSource && !declaredOutput) {
        // A fence with no provenance at all cannot be adjudicated. Saying
        // "fresh" would be a guess dressed as a fact.
        b.state = BLOCK_STATE.MALFORMED;
        b.stateReason = 'output fence carries neither SourceHash nor OutputHash';
        return b;
    } else {
        b.state = BLOCK_STATE.FRESH;
    }
    b.stateReason = BLOCK_STATE_REASON[b.state];
    return b;
}

/** Prefix comparison, tolerant of the trailing ellipsis the fences use. */
function hashMatches(declared, actual) {
    const d = String(declared).replace(/[…\.]+$/, '').trim().toLowerCase();
    if (!d) return false;
    return actual.toLowerCase().startsWith(d);
}

/** Render a fence header for writing (Stage 4 will need this; kept beside the parser). */
function formatOutputFence(cellId, sourceHash, outputHash, { short = 8 } = {}) {
    const s = String(sourceHash).slice(0, short);
    const o = String(outputHash).slice(0, short);
    return `%WolfbookOutputBegin[CellID: ${cellId}, SourceHash: ${s}, OutputHash: ${o}]`;
}

module.exports = {
    parseMmaBlocks,
    parseHeader,
    formatOutputFence,
    hashMatches,
    BLOCK_STATE,
    BLOCK_STATE_REASON,
};
