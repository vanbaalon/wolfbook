'use strict';
/**
 * Oberon Fairy — fresh-kernel verification via wolframscript subprocess.
 *
 * verifyCleanNotebook(nbPath, targetStepId, recordedValue, opts):
 *   Spawns a wolframscript child process, evaluates each code cell from
 *   clean.wb in order, and compares the target cell's output (in InputForm)
 *   against the value recorded during exploration.
 *
 * wolframscriptBin resolution:
 *   Derived from the WolframKernel path (same directory, same installation).
 *   Call resolveWolframscript(kernelBin) to get the path.
 *
 * Classification results:
 *   delivered      — all cells ok, target output matches recorded
 *   missing_step   — undefined-symbol error for a symbol a valid step defines
 *   cell_errored   — a cell failed (syntax error, timeout, abort)
 *   output_differs — target ran but output doesn't match recorded
 */

const cp   = require('child_process');
const path = require('path');
const fsp  = require('fs/promises');
const os   = require('os');

// Sentinel markers (unlikely to appear in WL output)
const START_MARK = '__WB_CELL_START__';
const END_MARK   = '__WB_CELL_END__';
const ERR_MARK   = '__WB_CELL_ERROR__';
const TMOUT_MARK = '__WB_CELL_TIMEOUT__';
const MATCH_MARK = '__WB_MATCH__';       // in-kernel SameQ succeeded for target cell

/**
 * Derive the wolframscript binary path from a WolframKernel path.
 * They live in the same directory on all platforms.
 *
 * @param {string} kernelBin  - absolute path to WolframKernel (or WolframKernel.exe)
 * @returns {string}
 */
function resolveWolframscript(kernelBin) {
    const dir = path.dirname(kernelBin);
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(dir, `wolframscript${ext}`);
}

/**
 * Read and parse a .wb notebook JSON file.
 * @param {string} nbPath
 * @returns {Promise<{ cells: object[] }>}
 */
async function readNotebook(nbPath) {
    const raw = await fsp.readFile(nbPath, 'utf8');
    const nb  = JSON.parse(raw);
    if (!Array.isArray(nb.cells)) throw new Error(`Invalid notebook: no cells array in ${nbPath}`);
    return nb;
}

/**
 * Build the WL script to send to wolframscript stdin.
 *
 * For each non-target cell:
 *   Print start sentinel, evaluate, print InputForm result, print end sentinel.
 *
 * For the target cell, do an IN-KERNEL comparison against the recorded value:
 *   Use SameQ for structural equality, then PossibleZeroQ[fresh - recorded]
 *   for symbolic/numeric equality. Print MATCH_MARK on match, else print the
 *   fresh InputForm so the diff is visible. This avoids false mismatches from
 *   formatting differences, term ordering, or WL version variation.
 *
 * @param {object[]} cells           - code cells (kind=2, language='wolfram')
 * @param {number}   timeoutPerCell  - seconds per cell
 * @param {string}   targetCellId    - id of the target cell (may be null)
 * @param {string}   recordedValue   - InputForm string recorded during exploration
 * @returns {string}  WL script
 */
function buildVerifyScript(cells, timeoutPerCell, targetCellId, recordedValue) {
    const codeCells = cells.filter(c => c.kind === 2 && c.language === 'wolfram');
    const lines = [
        // Disable interactive output formatting
        'Off[General::shdw];',
        '$Messages = {};',
    ];

    // Escape a WL string value for safe embedding inside a WL string literal.
    const wlEsc = s => String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

    for (const cell of codeCells) {
        const cellId = cell.id || 'unknown';
        const code   = (cell.value || '').trim();

        // Determine if this is the target cell (same matching logic as the caller)
        const isTarget = targetCellId && (
            cell.id === targetCellId
            || cell.id === targetCellId + '_cell'
            || (cell.metadata && Array.isArray(cell.metadata.tags) && cell.metadata.tags.includes(targetCellId))
        );

        lines.push(`Print["${START_MARK} ${cellId}"];`);

        if (isTarget && recordedValue != null) {
            // In-kernel comparison: parse the recorded value back into WL, then
            // compare using SameQ (structural) and PossibleZeroQ (symbolic/numeric).
            // This is immune to formatting differences and term-ordering variance.
            const escapedRec = wlEsc(recordedValue);
            lines.push(
                `$wbFresh$ = TimeConstrained[(${code}), ${timeoutPerCell}, "$WBTIMEOUT$"];`,
                `If[$wbFresh$ === "$WBTIMEOUT$",`,
                `  Print["${TMOUT_MARK} ${cellId}"],`,
                `  Module[{$wbRec$ = Quiet[ToExpression["${escapedRec}"]]},`,
                `    If[`,
                `      TrueQ[SameQ[$wbFresh$, $wbRec$]] || TrueQ[PossibleZeroQ[$wbFresh$ - $wbRec$]],`,
                `      Print["${MATCH_MARK}"],`,
                `      Print[ToString[$wbFresh$, InputForm]]`,
                `    ]`,
                `  ]`,
                `];`,
            );
        } else {
            // Non-target cell: just evaluate and emit InputForm result for error detection.
            lines.push(
                `$wbResult$ = TimeConstrained[(${code}), ${timeoutPerCell}, "$WBTIMEOUT$"];`,
                `If[$wbResult$ === "$WBTIMEOUT$",`,
                `  Print["${TMOUT_MARK} ${cellId}"],`,
                `  Print[ToString[$wbResult$, InputForm]]`,
                `];`,
            );
        }

        lines.push(`Print["${END_MARK} ${cellId}"];`);
    }
    lines.push('Exit[];');
    return lines.join('\n');
}

/**
 * Parse wolframscript stdout into per-cell result objects.
 *
 * @param {string}   stdout    - full stdout from wolframscript
 * @param {object[]} cells     - code cells (same order as passed to buildVerifyScript)
 * @returns {Map<string, { output: string, error: boolean, timeout: boolean }>}
 *   keyed by cell.id
 */
function parseVerifyOutput(stdout, cells) {
    const results  = new Map();
    const lines    = stdout.split('\n');
    let   inCell   = null;
    let   buffer   = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(START_MARK)) {
            inCell = trimmed.slice(START_MARK.length).trim();
            buffer = [];
        } else if (trimmed.startsWith(END_MARK)) {
            if (inCell !== null) {
                const output = buffer.join('\n').trim();
                results.set(inCell, {
                    output,
                    error:   output.startsWith(ERR_MARK),
                    timeout: output.startsWith(TMOUT_MARK),
                });
            }
            inCell = null;
            buffer = [];
        } else if (inCell !== null) {
            // Detect error/timeout sentinels mid-cell
            if (trimmed.startsWith(ERR_MARK) || trimmed.startsWith(TMOUT_MARK)) {
                buffer.push(trimmed);
            } else {
                buffer.push(line);
            }
        }
    }

    return results;
}

/**
 * Numeric comparison: both strings are valid real numbers and |a - b| < tol.
 */
function numericMatch(a, b, tol) {
    const na = parseFloat(a);
    const nb = parseFloat(b);
    if (!isFinite(na) || !isFinite(nb)) return false;
    return Math.abs(na - nb) < tol;
}

/**
 * Detect whether stderr or cell output indicates an undefined-symbol error.
 * Wolfram messages like: Symbol "foo" in context "Global`" is not defined.
 * or value-was-$Failed with Global`foo being a pattern name.
 */
function isUndefinedSymbolError(output, stderr) {
    const combined = `${output}\n${stderr}`;
    return /is not defined|::shdw|::undef|is undefined/i.test(combined)
        || /Symbol\s+"[^"]+"\s+(in context\s+"[^"]+"\s+)?is not defined/i.test(combined);
}

/**
 * Main verification entry point.
 *
 * @param {string} cleanNbPath   - path to clean.wb
 * @param {string} targetStepId  - cell.id (or tag) to find as the target
 * @param {string} recordedValue - value string from results/<probeId>.json (InputForm)
 * @param {{
 *   wolframscriptBin: string,
 *   numeric_tol?:     number,
 *   timeoutPerCell?:  number,
 *   totalTimeoutMs?:  number,
 * }} opts
 * @returns {Promise<{
 *   classification: 'delivered' | 'missing_step' | 'cell_errored' | 'output_differs',
 *   firstFailureCell: string | null,
 *   freshOutput:      string | null,
 *   recordedOutput:   string | null,
 *   messages:         string[] | null,
 *   details:          string,
 * }>}
 */
async function verifyCleanNotebook(cleanNbPath, targetStepId, recordedValue, opts = {}) {
    const {
        wolframscriptBin,
        numeric_tol    = 1e-10,
        timeoutPerCell = 30,
        totalTimeoutMs = 120_000,
    } = opts;

    if (!wolframscriptBin) throw new Error('opts.wolframscriptBin is required');

    // Read notebook
    const nb        = await readNotebook(cleanNbPath);
    const codeCells = nb.cells.filter(c => c.kind === 2 && c.language === 'wolfram');

    // Locate target cell: cell whose id matches or whose tags include targetStepId
    const targetCell = codeCells.find(c =>
        c.id === targetStepId
        || c.id === targetStepId + '_cell'
        || (c.metadata && Array.isArray(c.metadata.tags) && c.metadata.tags.includes(targetStepId))
    );

    if (!targetCell) {
        return {
            classification:   'cell_errored',
            firstFailureCell: null,
            freshOutput:      null,
            recordedOutput:   recordedValue,
            messages:         null,
            details:          `Target step '${targetStepId}' not found in clean.wb cells`,
        };
    }

    // Pass target cell id + recorded value so buildVerifyScript can embed in-kernel
    // SameQ/PossibleZeroQ for the target cell instead of emitting plain InputForm.
    const script = buildVerifyScript(codeCells, timeoutPerCell, targetCell.id, recordedValue);

    // Write script to a temp file and run with -f so wolframscript does not
    // prepend "In[N]:= " prompts to Print output (which breaks sentinel parsing).
    const tmpScript = path.join(os.tmpdir(), `wb_verify_${Date.now()}_${process.pid}.wl`);
    await fsp.writeFile(tmpScript, script, 'utf8');

    const { stdout, stderr } = await new Promise((resolve, reject) => {
        let stdoutBuf = '';
        let stderrBuf = '';

        const proc = cp.spawn(wolframscriptBin, ['-f', tmpScript], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: totalTimeoutMs,
        });

        proc.stdout.on('data', d => { stdoutBuf += d.toString('utf8'); });
        proc.stderr.on('data', d => { stderrBuf += d.toString('utf8'); });

        proc.on('error', err => reject(new Error(`wolframscript spawn failed: ${err.message}`)));
        proc.on('close', (code, signal) => {
            resolve({ stdout: stdoutBuf, stderr: stderrBuf, code, timedOut: signal === 'SIGTERM' });
        });
    }).finally(() => fsp.unlink(tmpScript).catch(() => {}));

    const cellResults = parseVerifyOutput(stdout, codeCells);

    // Check each cell in order
    for (const cell of codeCells) {
        const cellId = cell.id || 'unknown';
        const result = cellResults.get(cellId);
        if (!result) continue;

        if (result.timeout) {
            return {
                classification:   'cell_errored',
                firstFailureCell: cellId,
                freshOutput:      null,
                recordedOutput:   recordedValue,
                messages:         stderr ? [stderr.slice(0, 800)] : null,
                details:          `Cell '${cellId}' timed out during verification`,
            };
        }

        if (result.error) {
            const cls = isUndefinedSymbolError(result.output, stderr) ? 'missing_step' : 'cell_errored';
            return {
                classification:   cls,
                firstFailureCell: cellId,
                freshOutput:      result.output,
                recordedOutput:   recordedValue,
                messages:         stderr ? [stderr.slice(0, 800)] : null,
                details:          `Cell '${cellId}' produced an error: ${result.output.slice(0, 200)}`,
            };
        }

        // Is this the target cell?
        const isTarget = cell.id === targetCell.id;
        if (isTarget) {
            const fresh    = result.output;
            const recorded = recordedValue || '';

            // In-kernel comparison result: buildVerifyScript embedded SameQ + PossibleZeroQ
            // inside the kernel and printed MATCH_MARK on success, or the fresh InputForm
            // on mismatch. This is the authoritative check — no JS string comparison needed.
            if (fresh === MATCH_MARK) {
                return {
                    classification:   'delivered',
                    firstFailureCell: null,
                    freshOutput:      MATCH_MARK,
                    recordedOutput:   recorded,
                    messages:         null,
                    details:          'Verification passed: in-kernel SameQ/PossibleZeroQ confirmed match',
                };
            }

            // Numeric fallback: both plain real numbers and |a-b| < tol.
            // Covers cases where ToExpression of the recorded value fails but
            // both outputs are simple floats (e.g. "3.14159" vs "3.14159265").
            if (numericMatch(fresh, recorded, numeric_tol)) {
                return {
                    classification:   'delivered',
                    firstFailureCell: null,
                    freshOutput:      fresh,
                    recordedOutput:   recorded,
                    messages:         null,
                    details:          `Verification passed: numeric outputs within tolerance (|Δ| < ${numeric_tol})`,
                };
            }

            // Check for undefined-symbol in stderr even on non-error output
            if (isUndefinedSymbolError(result.output, stderr)) {
                return {
                    classification:   'missing_step',
                    firstFailureCell: cellId,
                    freshOutput:      fresh,
                    recordedOutput:   recorded,
                    messages:         stderr ? [stderr.slice(0, 800)] : null,
                    details:          `Undefined symbol detected in target cell '${cellId}'`,
                };
            }

            return {
                classification:   'output_differs',
                firstFailureCell: cellId,
                freshOutput:      fresh.slice(0, 400),
                recordedOutput:   recorded.slice(0, 400),
                messages:         stderr ? [stderr.slice(0, 800)] : null,
                details:          `Output mismatch on target '${cellId}': fresh="${fresh.slice(0, 100)}" vs recorded="${recorded.slice(0, 100)}"`,
            };
        }
    }

    // Fell through: target cell's output was not captured (parse failure or cell not reached)
    return {
        classification:   'cell_errored',
        firstFailureCell: targetCell.id,
        freshOutput:      null,
        recordedOutput:   recordedValue,
        messages:         stderr ? [stderr.slice(0, 800)] : null,
        details:          `Target cell '${targetCell.id}' output not captured — possible script truncation`,
    };
}

module.exports = { verifyCleanNotebook, resolveWolframscript, buildVerifyScript, parseVerifyOutput };
