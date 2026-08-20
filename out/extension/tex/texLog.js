// texLog.js — a TeX .log into structured diagnostics.
//
// Pure: no vscode, no fs, never throws.
//
// WHY NOT REUSE THE SHIPPING PARSER. Spike D measured all three of the
// extension's existing LaTeX log readers against ten planted problems:
//
//   this parser              9/9 captured, 7/9 with file+line, structured
//   GetLatexErrorsTool       9/9 captured, 0/9 with file+line, markdown blob
//   CompileLatexTool         reads stdout, not the .log
//   report.js tryCompilePdf  parses nothing at all
//
// The problem is not recall, it is SHAPE: a 4-line text blob cannot become an
// editor squiggle, and there is no incremental path from one to the other.
// Worse, `GetLatexErrorsTool` only matches /^!/, so switching on
// -file-line-error — the flag that makes errors carry a filename in the first
// place — DROPS its recall from 9/9 to 7/9. The parser and the flag that makes
// diagnostics possible are mutually incompatible.
//
// A LOG IS A PREFIX, NOT A LIST. Compiling min-errors.tex surfaces 1 of its 10
// planted problems, because a missing \usepackage is fatal in nonstopmode and
// nothing after it happens. `parseLog` therefore returns {stopped, stopReason}
// alongside the diagnostics, so a UI can say "compilation stopped here, later
// problems unknown" rather than "1 problem".

const SEVERITY = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };

/**
 * TeX hard-wraps its log at `max_print_line` columns, splitting mid-word, so a
 * record can arrive in pieces. Rejoining them is necessary — but only when the
 * log is ACTUALLY wrapped.
 *
 * MEASURED: this originally joined any line of 79+ characters with its
 * successor. compileService sets `max_print_line=1000`, so nothing is wrapped,
 * and the heuristic instead glued a long ordinary line onto the record after
 * it — swallowing `Output written on draft.pdf (89 pages, ...)` and reporting
 * a 89-page document as having an unknown page count.
 *
 * So: detect the wrap width instead of assuming one. TeX wraps at EXACTLY the
 * limit, so a wrapped log has many lines of identical length; an unwrapped one
 * has a smooth distribution. Fewer than three such lines means no wrapping.
 */
function detectWrapWidth(raw) {
    // The wrap width is a MAXIMUM: in a wrapped log nothing exceeds it, and
    // many lines sit exactly on it. Taking "the most common long length"
    // instead picks up coincidences — on a real 1196-line log it chose 67,
    // a length three ordinary sentences happened to share.
    let max = 0;
    for (const l of raw) if (l.length > max) max = l.length;
    if (max < 60 || max > 300) return null;      // implausible as a TeX limit
    let atMax = 0;
    for (const l of raw) if (l.length === max) atMax++;
    return atMax >= 3 ? max : null;
}

function unwrap(text) {
    const raw = String(text).split('\n');
    const width = detectWrapWidth(raw);
    if (!width) return raw;
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        let line = raw[i];
        // Test the RAW line's length, not the accumulated one: a continuation
        // chain ends as soon as a piece comes in shorter than the wrap width.
        // Testing the accumulation instead swallowed the whole file into one
        // line, because the joined result is always >= width.
        while (raw[i].length === width && i + 1 < raw.length &&
               !/^(!|l\.\d|\(|\)|\[|Overfull|Underfull|LaTeX|Package|Class|Missing|Output written|No pages)/.test(raw[i + 1])) {
            line += raw[++i];
        }
        out.push(line);
    }
    return out;
}

/**
 * @param {string} logText
 * @param {{file?: string}} opts   the job's own .tex, for records with no file
 * @returns {{diagnostics: object[], stopped: boolean, stopReason: string|null,
 *            errors: number, warnings: number, engine: string|null,
 *            outputFormat: string|null, pages: number|null}}
 *
 * Each diagnostic: { severity, kind, file, line, message, symbol?, context?,
 *                    lineUnavailable? }
 */
function parseLog(logText, opts = {}) {
    const lines = unwrap(String(logText || ''));
    const diagnostics = [];
    let stopped = false;
    let stopReason = null;
    let engine = null;
    let outputFormat = null;
    let pages = null;

    const push = (d) => {
        if (!d.message) return;
        d.message = d.message.replace(/\s+/g, ' ').trim();
        diagnostics.push(d);
    };

    for (let i = 0; i < lines.length; i++) {
        const L = lines[i];

        if (!engine) {
            const m = /^This is (pdfTeX|XeTeX|LuaHBTeX|LuaTeX|e?TeX)[,\s]/.exec(L);
            if (m) engine = m[1];
        }
        // "Output written on job.pdf (12 pages, 123456 bytes)."
        const out = /^Output written on (\S+) \((\d+) pages?/.exec(L);
        if (out) { outputFormat = /\.pdf$/i.test(out[1]) ? 'pdf' : (/\.dvi$/i.test(out[1]) ? 'dvi' : null); pages = Number(out[2]); }
        if (/^No pages of output\./.test(L)) pages = 0;

        // --- errors ---------------------------------------------------------
        // With -file-line-error:  ./file.tex:13: Undefined control sequence.
        const fl = /^(?:\.\/)?(\S+?\.(?:tex|sty|cls|ltx|def|bbl)):(\d+):\s*(.*)$/.exec(L);
        if (fl) {
            const message = fl[3];
            const d = {
                severity: SEVERITY.ERROR, kind: classifyError(message),
                file: fl[1], line: Number(fl[2]), message,
            };
            attachContext(d, lines, i);
            push(d);
            if (/Emergency stop|Fatal error occurred|==> Fatal error/.test(message)) {
                stopped = true; stopReason = stopReason || message;
            }
            continue;
        }
        // Without it:  ! Undefined control sequence.   then  l.13 \foo
        if (/^! /.test(L)) {
            const message = L.slice(2).trim();
            const d = {
                severity: SEVERITY.ERROR, kind: classifyError(message),
                file: opts.file || null, line: null, message,
            };
            // The line arrives a few lines later as `l.NN <context>`.
            for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
                const lm = /^l\.(\d+)\s?(.*)$/.exec(lines[j]);
                if (lm) { d.line = Number(lm[1]); d.context = lm[2].trim() || undefined; break; }
                // A runaway that eats the file prints `<*> job.tex` instead.
                const rm = /^<\*>\s+(.*)$/.exec(lines[j]);
                if (rm) { d.context = rm[1].trim(); break; }
            }
            if (d.line == null) d.lineUnavailable = true;
            attachContext(d, lines, i);
            push(d);
            if (/Emergency stop|Fatal error/.test(message)) { stopped = true; stopReason = stopReason || message; }
            continue;
        }
        if (/^(?:\.\/)?\S+:\s*==> Fatal error occurred|^==> Fatal error occurred/.test(L)) {
            stopped = true; stopReason = stopReason || 'fatal error; no output produced';
            continue;
        }

        // --- boxes ----------------------------------------------------------
        // Overfull \hbox (4.4pt too wide) in paragraph at lines 12--15
        const box = /^(Overfull|Underfull) \\([hv])box \(([^)]*)\)(?: in paragraph| in alignment| detected)? at lines? (\d+)(?:--(\d+))?/.exec(L);
        if (box) {
            const amount = /([\d.]+)pt too (wide|short|high|deep)/.exec(box[3]);
            push({
                severity: SEVERITY.WARNING,
                kind: `${box[1].toLowerCase()}-${box[2]}box`,
                file: opts.file || null,
                line: Number(box[4]),
                endLine: box[5] ? Number(box[5]) : undefined,
                // The number is what makes this actionable ("4.4 mm too wide"),
                // so it is a field, not just prose.
                overBy: amount ? Number(amount[1]) : undefined,
                overByMm: amount ? Number(amount[1]) * 25.4 / 72.27 : undefined,
                direction: amount ? amount[2] : undefined,
                message: L.trim(),
            });
            continue;
        }
        // Some are reported "while \output is active" with no line at all.
        const box2 = /^(Overfull|Underfull) \\([hv])box \(([^)]*)\) has occurred while \\output is active/.exec(L);
        if (box2) {
            push({
                severity: SEVERITY.WARNING, kind: `${box2[1].toLowerCase()}-${box2[2]}box`,
                file: opts.file || null, line: null, lineUnavailable: true,
                message: L.trim(), context: 'while \\output is active (page break)',
            });
            continue;
        }

        // --- warnings -------------------------------------------------------
        const warn = /^(?:LaTeX|Package|Class)(?:\s+(\S+))? Warning:\s*(.*)$/.exec(L);
        if (warn) {
            let message = warn[2];
            for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                if (/^\((\S+)\)\s+(.*)$/.test(lines[j])) message += ' ' + RegExp.$2;
                else break;
            }
            const onPage = /on page (\d+)/.exec(message);
            const atLine = /on input line (\d+)/.exec(message);
            const d = {
                severity: SEVERITY.WARNING,
                kind: classifyWarning(message),
                file: opts.file || null,
                line: atLine ? Number(atLine[1]) : null,
                page: onPage ? Number(onPage[1]) : undefined,
                message: (warn[1] ? `[${warn[1]}] ` : '') + message,
            };
            const sym = /(?:Reference|Citation|Label) `([^']+)'/.exec(message);
            if (sym) d.symbol = sym[1];
            if (d.line == null) d.lineUnavailable = true;
            push(d);
            continue;
        }
        if (/^LaTeX Font Warning:/.test(L)) {
            push({ severity: SEVERITY.INFO, kind: 'font', file: opts.file || null,
                line: null, lineUnavailable: true, message: L.trim() });
            continue;
        }
        // A duplicate label is detected while READING the previous .aux, so it
        // carries no line anywhere in the log. Emit the symbol so a consumer
        // can find it by search rather than pretending to know where it is.
        const dup = /^(?:LaTeX Warning: )?Label `([^']+)' multiply defined/.exec(L);
        if (dup) {
            push({ severity: SEVERITY.WARNING, kind: 'duplicate-label',
                file: opts.file || null, line: null, lineUnavailable: true,
                symbol: dup[1], message: `Label \`${dup[1]}' multiply defined.` });
        }
    }

    return {
        diagnostics, stopped, stopReason, engine, outputFormat, pages,
        errors: diagnostics.filter(d => d.severity === SEVERITY.ERROR).length,
        warnings: diagnostics.filter(d => d.severity === SEVERITY.WARNING).length,
    };
}

function attachContext(d, lines, i) {
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (/^l\.\d/.test(lines[j]) || /^<\*>/.test(lines[j])) break;
        const t = lines[j].trim();
        if (t && !/^!/.test(t) && !d.detail) { d.detail = t.slice(0, 200); break; }
    }
}

function classifyError(m) {
    if (/Undefined control sequence/.test(m)) return 'undefined-control-sequence';
    if (/File `?([^']+)'? not found|LaTeX Error: File/.test(m)) return 'missing-file';
    if (/Missing \$ inserted/.test(m)) return 'missing-math-shift';
    if (/Missing \\?(begin|end)|Bad math environment delimiter/.test(m)) return 'environment-mismatch';
    if (/Runaway argument|Paragraph ended before/.test(m)) return 'runaway-argument';
    if (/Missing [{}] inserted|Extra [{}]/.test(m)) return 'brace-mismatch';
    if (/Emergency stop|Fatal error/.test(m)) return 'fatal';
    if (/TeX capacity exceeded/.test(m)) return 'capacity';
    return 'error';
}

function classifyWarning(m) {
    if (/Reference `[^']*' on page \d+ undefined|There were undefined references/.test(m)) return 'unresolved-ref';
    if (/Citation `[^']*'.*undefined|There were undefined citations/.test(m)) return 'unresolved-cite';
    if (/Label `[^']*' multiply defined/.test(m)) return 'duplicate-label';
    if (/Rerun|Label\(s\) may have changed/.test(m)) return 'rerun-needed';
    if (/Float too large|`h' float specifier changed/.test(m)) return 'float';
    if (/Marginpar on page/.test(m)) return 'marginpar';
    return 'warning';
}

/** Does the engine want another pass? Mirrors latexmk's own rule. */
function needsRerun(logText) {
    return /Rerun to get|Please rerun|Label\(s\) may have changed|Citation \S+ undefined/.test(String(logText || ''));
}

module.exports = { parseLog, needsRerun, unwrap, detectWrapWidth, SEVERITY };
