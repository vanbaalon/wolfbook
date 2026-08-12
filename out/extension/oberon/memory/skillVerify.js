'use strict';
/**
 * Stage A2 (2026-08-04): kernel verification gate for authored skills.
 *
 * Motivating incident: @vanbaalon/sn-permutation-rep-decomposition v0.1.0 shipped
 * with the confident claim "FiniteGroupData does not cover S_n character tables".
 * It does (checked live for n = 6, 8, 10). The false claim came from an agent run
 * that had used the WRONG ENTITY NAME and concluded the built-in was missing —
 * i.e. the skill encoded a run's misdiagnosis as fact and would have taught it to
 * every future run. A skill is high-leverage precisely because it is trusted, so
 * an unverified claim is worse than no skill at all.
 *
 * What this does: extract the ```wolfram blocks from a SKILL.md, run them in a
 * FRESH kernel in document order, and report which fail. It is deliberately a
 * SMOKE test, not a proof: it catches syntax errors, undefined built-ins, wrong
 * entity names and copy-paste breakage — the class of defect that shipped in
 * v0.1.0 — and says nothing about mathematical correctness (that is what the
 * skill's own Verification anchors are for, which this also runs).
 *
 * vscode-free: takes an injected `evalOnce` so it runs headlessly and in-extension.
 */

/** Extract fenced ```wolfram / ```mathematica blocks in document order. */
function extractWolframBlocks(skillMd) {
    const blocks = [];
    const re = /```(?:wolfram|mathematica|wl)\s*\n([\s\S]*?)```/gi;
    let m;
    while ((m = re.exec(String(skillMd || ''))) !== null) {
        const code = m[1].trim();
        if (code) blocks.push(code);
    }
    return blocks;
}

/**
 * Run every wolfram block of a skill in one fresh kernel session.
 *
 * @param {string} skillMd
 * @param {{ evalOnce: Function, timeoutSeconds?: number, maxBlocks?: number }} deps
 * @returns {Promise<{ok, blocks, failures, ran, skipped}>}
 */
async function verifySkillBlocks(skillMd, { evalOnce, timeoutSeconds = 60, maxBlocks = 20 } = {}) {
    const blocks = extractWolframBlocks(skillMd);
    if (typeof evalOnce !== 'function') {
        return { ok: false, blocks: blocks.length, failures: [], ran: 0, skipped: blocks.length,
                 error: 'no kernel available — verification skipped' };
    }
    const failures = [];
    let ran = 0;
    for (let i = 0; i < Math.min(blocks.length, maxBlocks); i++) {
        const code = blocks[i];
        let r;
        try { r = await evalOnce({ expression: code, timeoutSeconds }); }
        catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
        ran++;
        const msgs = r && r.messages
            ? (Array.isArray(r.messages) ? r.messages.join('\n') : String(r.messages))
            : '';
        // A block "fails" on a hard error or on any kernel message that names a
        // symbol problem — the exact fingerprint of the v0.1.0 defect
        // (FiniteGroupData::notent) — not on numeric/convergence chatter.
        const structural = /::(notent|shdw|argx|argrx|argbu|argb|nonopt|sntx|sntxf|sntxb|undef|nofirst|partw|partd|pkspec)/i.test(msgs);
        if (!r || r.ok === false || structural) {
            failures.push({
                index: i + 1,
                snippet: code.slice(0, 160),
                error: String((r && (r.error || r.kind)) || '').slice(0, 200) || undefined,
                messages: (msgs || '').slice(0, 300) || undefined,
            });
        }
    }
    return {
        ok: failures.length === 0,
        blocks: blocks.length,
        ran,
        skipped: Math.max(0, blocks.length - ran),
        failures,
    };
}

/** Human-readable verdict for the review panel / publish gate. */
function renderVerification(res) {
    if (!res) return 'not verified';
    if (res.error) return `⚠️ ${res.error}`;
    if (res.ok) return `✅ ${res.ran}/${res.blocks} wolfram block(s) ran clean in a fresh kernel.`;
    const lines = [`❌ ${res.failures.length}/${res.ran} wolfram block(s) FAILED in a fresh kernel — do not publish:`];
    for (const f of res.failures) {
        lines.push(`  block ${f.index}: ${f.error || ''} ${f.messages || ''}`.trimEnd());
        lines.push(`    ${f.snippet.replace(/\n/g, ' ⏎ ')}`);
    }
    lines.push('A skill is trusted by every future run — a claim that does not execute is worse than no skill.');
    return lines.join('\n');
}

module.exports = { extractWolframBlocks, verifySkillBlocks, renderVerification };
