'use strict';
/**
 * Pure markdown builders for the live working.wb chrome cells (P6 util trace, P7 status).
 * No vscode/fs dependency — unit-testable. The index.js notebook listeners turn these
 * strings into NotebookCellData.
 */

/** P6: a "util registered" banner (markdown header for the working notebook). */
function buildUtilBanner({ name, note } = {}) {
    const n = String(name || '?');
    const desc = String(note || '').trim();
    return `### 🔧 util: \`${n}\`${desc ? ` — ${desc}` : ''}`;
}

/**
 * P7: the pinned status cell. Distinct callout style (blockquote + glyph) so it reads as
 * chrome, not content. While active shows phase · budget · "thinking…" + the last few
 * reasoning lines; on terminal it swaps to a final ✅ / ▢ line.
 *
 * @param {{ phase?:string, budgetLeft?:number, thinkingTail?:string, done?:boolean, status?:string }} s
 * @returns {string}
 */
function buildStatusMarkdown(s = {}) {
    if (s.done) {
        const st = String(s.status || 'done');
        const glyph = st === 'delivered' ? '✅' : (st === 'partial_delivered' ? '▢' : '⛔');
        return `> ${glyph} **${st}** — run complete.`;
    }
    const phase = String(s.phase || 'explore');
    const budget = (typeof s.budgetLeft === 'number') ? ` · ${s.budgetLeft} probes left` : '';
    const head = `> ⏳ **${phase}**${budget} · _thinking…_`;
    const tail = String(s.thinkingTail || '').trim();
    if (!tail) return head;
    const lines = tail.split('\n').map(l => l.trim()).filter(Boolean).slice(-3);
    return head + '\n>\n' + lines.map(l => `> > ${l}`).join('\n');
}

/** Take the last `n` non-empty lines of free text (the model's reasoning) for the status tail. */
function reasoningTail(text, n = 3) {
    return String(text || '')
        .split('\n').map(l => l.trim()).filter(Boolean).slice(-n).join('\n');
}

function _esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * P7 (R8 redesign): the pinned status cell as a FIXED-HEIGHT scrolling box. The cell
 * is updated in place (no delete+reinsert) and the reasoning lives inside an
 * overflow:auto div, so the notebook never grows or jumps while thinking streams.
 * Content is bounded (last ~1800 chars) so it stays compact even if the host strips
 * the inline style.
 *
 * @param {{ phase?:string, budgetLeft?:number, thinkingTail?:string, done?:boolean, status?:string }} s
 * @returns {string} markdown (with an embedded scroll div while active)
 */
function buildStatusHtml(s = {}) {
    if (s.done) {
        const st = String(s.status || 'done');
        const glyph = st === 'delivered' ? '✅' : (st === 'partial_delivered' ? '▢' : '⛔');
        return `**${glyph} ${st}** — run complete.`;
    }
    const phase  = String(s.phase || 'explore');
    const budget = (typeof s.budgetLeft === 'number') ? ` · ${s.budgetLeft} probes left` : '';
    const header = `⏳ **${phase}**${budget} · _thinking…_`;
    // Second line: run meters (probes used · turns · cost so far).
    const meters = [];
    if (typeof s.probesUsed === 'number') meters.push(`${s.probesUsed} probes`);
    if (typeof s.turnsUsed === 'number')  meters.push(`${s.turnsUsed} turns`);
    if (typeof s.costUSD === 'number' && s.costUSD > 0) meters.push(`$${s.costUSD.toFixed(4)}`);
    const meterLine = meters.length ? `\n<sub>${meters.join(' · ')}</sub>` : '';
    const tail   = String(s.thinkingTail || '').slice(-1800).trim();
    if (!tail) return header + meterLine;
    const body = tail.split('\n').map(l => l.trim()).filter(Boolean).map(_esc).join('<br>');
    return header + meterLine + '\n\n' +
        '<div style="max-height:140px;overflow-y:auto;padding:4px 8px;border-left:2px solid var(--vscode-textBlockQuote-border,#888);' +
        'font-size:12px;line-height:1.45;opacity:0.8;white-space:pre-wrap;">' + body + '</div>';
}

module.exports = { buildUtilBanner, buildStatusMarkdown, buildStatusHtml, reasoningTail };
