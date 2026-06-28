'use strict';
/**
 * Oberon — Critic working notebook helper.
 *
 * Creates and incrementally populates a `<charmId>_critic.wb` notebook
 * during the Skeptic phase.  The Critic notebook is the Skeptic's active
 * workspace: it records evidence re-evaluations, syntax/runtime errors,
 * targeted independent checks, domain-assumption probes, and the final
 * verdict summary.
 *
 * Unlike the post-hoc charm findings notebook, this file is built live
 * as the Skeptic works, so a partial notebook is still useful if the
 * Skeptic phase is aborted.
 *
 * Cell conventions
 * ----------------
 *   Safe cells (re-evals of simple expressions) are appended as plain
 *   Wolfram code cells — the user may re-run them freely.
 *
 *   Manual-review cells (alternative derivations, expressions with large
 *   output, or cells the Skeptic could not auto-verify) carry a
 *   `(* manual-review ... *)` header and MUST NOT be auto-executed by
 *   any automated process.
 *
 * Usage
 * -----
 *   const writer = createCriticNotebookWriter({ quest, charm, bus });
 *   await writer.init();
 *   // ... per evidence item:
 *   await writer.appendEvidenceCheck(ev, checkResult, wardResults);
 *   // ... at end:
 *   await writer.appendVerdictSummary(skepticResult);
 *   await writer.save();
 */

const { createNotebookWriter } = require('./notebookWriter');

/**
 * Create a notebook writer pre-configured for the Critic phase.
 *
 * @param {{ quest: object, charm: object, bus: object }} opts
 * @returns {object}  Extended writer with `appendEvidenceCheck` and
 *                    `appendVerdictSummary` helpers in addition to all
 *                    base writer methods.
 */
function createCriticNotebookWriter({ quest, charm, bus }) {
    const writer = createNotebookWriter({ quest, charm, bus, kind: 'critic' });

    /**
     * Append cells for one evidence item and its Skeptic check result.
     *
     * @param {{tool:string, expression:string, output:string, ok:boolean}} ev
     * @param {{kind:string, match:boolean|null, recheckOutput:string, error:string|null, deepChecks:Array}} check
     */
    async function appendEvidenceCheck(ev, check) {
        if (!writer.initialised) return;

        const expr    = String(ev && ev.expression || '').trim();
        const preview = expr.replace(/\s+/g, ' ').slice(0, 80);
        const matchIcon = check.match === true ? '✓' : check.match === false ? '✗' : '—';

        // Section header
        await writer.appendMarkdown(
            `#### Evidence re-eval ${matchIcon} — \`${preview}${expr.length > 80 ? '…' : ''}\``
        );

        // Clean code cell for the re-evaluation (safe to run unless failed)
        if (expr) {
            const isSafe = check.kind !== 'error' && check.kind !== 'timeout';
            const result = check.recheckOutput ? `(* Recheck result: ${
                String(check.recheckOutput).replace(/\n/g, ' ').slice(0, 120)
            } *)` : '';
            const fairedOutput = ev.output
                ? `(* Fairy cited: ${String(ev.output).replace(/\n/g, ' ').slice(0, 120)} *)`
                : '';
            const headerComment = [result, fairedOutput].filter(Boolean).join('\n');
            await writer.appendCode(
                (headerComment ? headerComment + '\n' : '') + expr,
                { safe: isSafe }
            );
        }

        // Deep check results
        const deepChecks = Array.isArray(check.deepChecks) ? check.deepChecks : [];
        for (const d of deepChecks) {
            const icon = d.status === 'passed' ? '✓' : d.status === 'failed' ? '✗' : '—';
            await writer.appendMarkdown(
                `> Ward ${d.wardId} (${d.method}) ${icon}: ${String(d.detail || '').slice(0, 200)}`
            );
        }

        // Kernel warnings from re-evaluation
        if (check.recheckMessages) {
            const warnCount = (check.recheckMessages.match(/\w+::\w+/g) || []).length;
            const severity  = warnCount >= 3 || /General::stop/i.test(check.recheckMessages) ? '⚠️' : 'ℹ️';
            const preview   = check.recheckMessages.slice(0, 400).replace(/\n/g, '\n> ');
            await writer.appendMarkdown(
                `> ${severity} **Kernel warnings (${warnCount}) during re-eval:**\n> \`\`\`\n> ${preview}\n> \`\`\``
            );
        }
    }

    /**
     * Append the final Skeptic verdict summary as a section at the end
     * of the critic notebook.
     *
     * @param {{verdict:string, verificationLevel:string, objections:string[],
     *          summary:object, wardSummary:object}} skepticResult
     */
    async function appendVerdictSummary(skepticResult) {
        if (!writer.initialised) return;

        const sk  = skepticResult || {};
        const sum = sk.summary || {};
        const ws  = sk.wardSummary || {};

        const lines = [
            '\n---',
            '## Skeptic Verdict',
            '',
            `**Verdict:** ${(sk.verdict || 'unknown').toUpperCase()}  ` +
                `**Level:** ${sk.verificationLevel || 'none'}`,
            '',
            `Re-eval: ${sum.matched || 0} matched / ${sum.failed || 0} failed / ` +
                `${sum.skipped || 0} skipped (of ${sum.total || 0} evidence items)`,
        ];

        if (ws.total > 0) {
            lines.push(
                `Wards: ${ws.passed || 0} passed / ${ws.failed || 0} failed / ` +
                `${ws.skipped || 0} skipped (of ${ws.total || 0})`,
            );
        }

        const objections = Array.isArray(sk.objections) ? sk.objections : [];
        if (objections.length > 0) {
            lines.push('', '**Objections:**');
            objections.slice(0, 6).forEach(o =>
                lines.push(`- ${String(o).slice(0, 300)}`));
        }

        await writer.appendMarkdown(lines.join('\n'));
    }

    return Object.assign({}, writer, { appendEvidenceCheck, appendVerdictSummary });
}

module.exports = { createCriticNotebookWriter };
