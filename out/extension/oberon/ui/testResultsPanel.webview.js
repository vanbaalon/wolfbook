/* global acquireVsCodeApi */
'use strict';
(function () {
    const vscode = acquireVsCodeApi();

    // ── Oberon terminology tooltips ──────────────────────────────────────────
    const TERM_TIPS = {
        'Oberon':   'Oberon: supervisor/planner/reviewer agent that orchestrates research',
        'Fairy':    'Fairy: worker agent assigned to a concrete executable task (Charm)',
        'Quest':    'Quest: a larger research sub-problem broken down by Oberon',
        'Charm':    'Charm: concrete executable task dispatched to a Fairy',
        'Scroll':   'Scroll: the Fairy\'s final report (findings, confidence, open questions)',
        'Ward':     'Ward: a validation check on a Scroll or intermediate result',
        'Omen':     'Omen: a warning, anomaly, or suspicious event flagged during a run',
        'Grimoire': 'Grimoire: canonical project memory (persisted across runs)',
        'Spell':    'Spell: an executable code / notebook / tool action',
        'Skeptic':  'Skeptic: deterministic re-checker that re-runs cited evidence to validate a Scroll',
        'Verdict':  'Verdict: final Oberon judgement (success / partial / failed / needs_review)',
    };

    // ── DOM refs ────────────────────────────────────────────────────────────
    const statusPill         = document.getElementById('statusPill');
    const progressBar        = document.getElementById('progressBar');
    const progressFill       = document.getElementById('progressFill');
    const progressLabel      = document.getElementById('progressLabel');
    const resultsTable       = document.getElementById('resultsTable');
    const resultsBody        = document.getElementById('resultsBody');
    const resultsFoot        = document.getElementById('resultsFoot');
    const analyticsSection   = document.getElementById('analyticsSection');
    const analyticsDistrib   = document.getElementById('analyticsDistribution');
    const analyticsTotals    = document.getElementById('analyticsTotals');
    const analyticsNarrative = document.getElementById('analyticsNarrative');
    const analyticsRawPre    = document.getElementById('analyticsRawPre');
    const emptyState         = document.getElementById('emptyState');
    const abortBtn           = document.getElementById('abortBtn');
    const runAgainBtn        = document.getElementById('runAgainBtn');

    // Log to confirm webview script loaded
    console.log('[testResults.webview] script loaded, DOM elements:', {
        statusPill: !!statusPill,
        progressBar: !!progressBar,
        resultsTable: !!resultsTable,
        emptyState: !!emptyState,
        abortBtn: !!abortBtn,
        runAgainBtn: !!runAgainBtn,
    });

    // ── live state ───────────────────────────────────────────────────────────
    let total   = 10;
    /** @type {Array<object|null>} indexed by test index */
    let results = [];
    /** @type {{ [id: string]: { verdict: string, reason: string } }} */
    let verdictMap = {};
    /** Wall-clock start of the current suite (Date.now()). */
    let suiteStartedAt = 0;
    /** Wall-clock end of the current suite (Date.now()), 0 if still running. */
    let suiteEndedAt   = 0;
    /** Ticker handle for the live elapsed display while a suite is running. */
    let suiteTicker    = null;

    // ── buttons ──────────────────────────────────────────────────────────────
    if (abortBtn) abortBtn.addEventListener('click', () => vscode.postMessage({ command: 'abort' }));
    if (runAgainBtn) {
        runAgainBtn.addEventListener('click', () => {
            runAgainBtn.style.display  = 'none';
            results    = [];
            verdictMap = {};
            resultsBody.innerHTML = '';
            resultsFoot.innerHTML = '';
            analyticsSection.style.display = 'none';
            emptyState.style.display = 'flex';
            emptyState.textContent   = 'Starting test suite…';
            vscode.postMessage({ command: 'runAgain' });
        });
    }

    // ── message handler ──────────────────────────────────────────────────────
    window.addEventListener('message', (e) => {
        const msg = e.data;
        console.log('[testResults] received message:', msg.command);
        if (!msg || !msg.command) return;
        switch (msg.command) {
            case 'suiteStarted':
                console.log('[testResults] onSuiteStarted called');
                onSuiteStarted(msg.total || 10);
                break;
            case 'testStarted':
                console.log('[testResults] testStarted:', msg.index, msg.test?.id);
                onTestStarted(msg.index, msg.test);
                break;
            case 'testDone':
                console.log('[testResults] testDone:', msg.result?.index, msg.result?.id);
                onTestDone(msg.result);
                break;
            case 'suiteComplete':
                console.log('[testResults] suiteComplete: ', msg.results?.length, 'tests');
                onSuiteComplete(msg.results, msg.analytics);
                break;
            case 'suiteError':
                console.log('[testResults] suiteError:', msg.message);
                onSuiteError(msg.message);
                break;
            case 'suiteState':
                console.log('[testResults] suiteState');
                onSuiteStarted(10);
                for (const r of (msg.results || [])) onTestDone(r);
                break;
            default:
                console.log('[testResults] unknown command:', msg.command);
        }
    });

    // ── event handlers ───────────────────────────────────────────────────────

    function onSuiteStarted(n) {
        total      = n;
        results    = [];
        verdictMap = {};
        suiteStartedAt = Date.now();
        suiteEndedAt   = 0;
        if (suiteTicker) { clearInterval(suiteTicker); suiteTicker = null; }
        suiteTicker = setInterval(updateTotals, 1000);

        setPill('running', 'running');
        emptyState.style.display       = 'none';
        resultsTable.style.display     = '';
        analyticsSection.style.display = 'none';
        resultsBody.innerHTML  = '';
        resultsFoot.innerHTML  = '';
        progressBar.style.display   = '';
        progressLabel.style.display = '';
        setProgress(0, n, 'Preparing…');
        abortBtn.style.display    = '';
        runAgainBtn.style.display = 'none';
    }

    function onTestStarted(index, test) {
        setProgress(index, total, `Running ${index + 1}/${total}: ${test.title}…`);
        if (!document.getElementById(`row-${index}`)) {
            // placeholder rows (running state, no verdict yet)
            appendRows(index, { index, id: test.id, title: test.title, state: 'running' }, null);
        }
    }

    function onTestDone(result) {
        results[result.index] = result;
        setProgress(result.index + 1, total,
            `Completed ${result.index + 1}/${total}: ${result.title}`);
        replaceRows(result.index, result, null);
        updateTotals();
    }

    function onSuiteComplete(allResults, analytics) {
        results = allResults;
        suiteEndedAt = Date.now();
        if (suiteTicker) { clearInterval(suiteTicker); suiteTicker = null; }

        // Parse analytics verdicts
        if (analytics && analytics.parsed && Array.isArray(analytics.parsed.verdicts)) {
            for (const v of analytics.parsed.verdicts) {
                if (v.id) verdictMap[v.id] = { verdict: v.verdict, reason: v.reason || '' };
            }
        }

        // Re-render all rows with verdicts + reasons
        resultsBody.innerHTML = '';
        for (const r of results) {
            appendRows(r.index, r, verdictMap[r.id] || null);
        }
        updateTotals();
        renderAnalyticsSection(analytics, allResults);

        setPill('done', 'done');
        progressBar.style.display   = 'none';
        progressLabel.style.display = 'none';
        abortBtn.style.display    = 'none';
        runAgainBtn.style.display = '';
    }

    function onSuiteError(message) {
        setPill('error', 'error');
        progressLabel.style.display = '';
        progressLabel.textContent   = 'Error: ' + message;
        abortBtn.style.display    = 'none';
        runAgainBtn.style.display = '';
    }

    // ── row builders ─────────────────────────────────────────────────────────

    /**
     * Build a DocumentFragment containing the data row + explanation row.
     * @param {number} index
     * @param {object} item
     * @param {{ verdict: string, reason: string } | null} v
     */
    function buildRowFragment(index, item, v) {
        const frag = document.createDocumentFragment();

        // ── data row ────
        const tr = document.createElement('tr');
        tr.id = `row-${index}`;
        if (item.state === 'running') tr.classList.add('row--running');

        const runStatusHtml  = renderRunStatus(item);
        const verdictHtml    = renderVerdictBadge(item, v);
        const costStr  = typeof item.totalCostUSD === 'number' && item.totalCostUSD > 0
            ? '$' + item.totalCostUSD.toFixed(4) : '—';
        const durStr   = item.durationMs > 0
            ? (item.durationMs / 1000).toFixed(1) + 's' : '—';
        const confStr  = item.confidence !== null && item.confidence !== undefined
            ? (item.confidence * 100).toFixed(0) + '%' : '—';
        const id       = item.id    || '';
        const title    = item.title || id || `Test ${index + 1}`;

        tr.innerHTML =
            `<td>${index + 1}</td>` +
            `<td><div class="prob-id">${escHtml(id)}</div><div class="prob-title">${escHtml(title)}</div></td>` +
            `<td>${runStatusHtml}</td>` +
            `<td>${verdictHtml}</td>` +
            `<td>${item.llmCallCount || 0}</td>` +
            `<td>${item.toolCallCount || 0}</td>` +
            `<td>${costStr}</td>` +
            `<td>${durStr}</td>` +
            `<td>${confStr}</td>`;
        frag.appendChild(tr);

        // ── explanation row ────
        const exTr = document.createElement('tr');
        exTr.id        = `row-explain-${index}`;
        exTr.className = 'row--explain';

        let exText = '';
        if (v && v.reason) {
            exText = v.reason;
        } else if (item.oberonReason) {
            exText = item.oberonReason;
        } else if (item.skepticReason) {
            exText = `Skeptic: ${item.skepticReason}`;
        } else if (item.state === 'error' && item.error) {
            exText = 'Error: ' + String(item.error).slice(0, 200);
        } else if (item.scrollSummary) {
            exText = item.scrollSummary.slice(0, 300);
        }

        // Append a narrated Oberon verdict block (separate from the analytics
        // verdict) when present.
        let oberonHtml = '';
        if (item.oberonVerdict) {
            const verdictPretty = String(item.oberonVerdict).replace(/_/g, ' ').toUpperCase();
            const oberonCls = item.oberonVerdict === 'success' ? 'verdict--success'
                            : item.oberonVerdict === 'partial_success' ? 'verdict--partial'
                            : item.oberonVerdict === 'failed' ? 'verdict--failed'
                            : 'verdict--needs-review';
            oberonHtml = `<div class="ob-verdict-row"><span class="verdict ${oberonCls}" title="Final Oberon verdict (separate from analytics)">${escHtml('Oberon: ' + verdictPretty)}</span></div>`;
        }
        // Append Skeptic chip if present.
        let skepticHtml = '';
        if (item.skepticVerdict) {
            const skCls = item.skepticVerdict === 'accept' ? 'verdict--success'
                        : item.skepticVerdict === 'dispute' ? 'verdict--failed'
                        : 'verdict--needs-review';
            const summary = item.skepticChecks
                ? ` (${item.skepticChecks.matched || 0}/${item.skepticChecks.total || 0})`
                : '';
            skepticHtml = `<span class="verdict ${skCls}" style="margin-left:6px" title="Skeptic re-checked the cited evidence">${escHtml('Skeptic: ' + item.skepticVerdict + summary)}</span>`;
        }

        const exTd = document.createElement('td');
        exTd.colSpan = 9;
        exTd.className = 'explain-cell';
        // Only show the row if there is something to display
        if (exText || oberonHtml || skepticHtml) {
            // Build inner HTML; the narrative text is escaped, the verdict
            // chips are pre-escaped HTML built above.
            const safeText = exText ? escHtml(exText) : '';
            const chips = (skepticHtml || oberonHtml)
                ? `<div class="ob-verdict-chips">${oberonHtml}${skepticHtml}</div>` : '';
            exTd.innerHTML = chips + (safeText ? `<div>${safeText}</div>` : '');
        } else {
            exTr.classList.add('row--explain-empty');
        }
        exTr.appendChild(exTd);
        frag.appendChild(exTr);

        return frag;
    }

    function appendRows(index, item, v) {
        resultsBody.appendChild(buildRowFragment(index, item, v));
    }

    function replaceRows(index, item, v) {
        const old        = document.getElementById(`row-${index}`);
        const oldExplain = document.getElementById(`row-explain-${index}`);
        const frag       = buildRowFragment(index, item, v);
        if (old) {
            old.parentNode.insertBefore(frag, old);
            old.remove();
            if (oldExplain) oldExplain.remove();
        } else {
            resultsBody.appendChild(frag);
        }
    }

    // ── badge renderers ──────────────────────────────────────────────────────

    function renderRunStatus(item) {
        let cls, label, tip;
        switch (item.state) {
            case 'done':    cls = 'status--done';    label = 'DONE';    tip = 'Run completed'; break;
            case 'error':   cls = 'status--error';   label = 'ERROR';   tip = 'Run failed with an error'; break;
            case 'aborted': cls = 'status--aborted'; label = 'ABORTED'; tip = 'Run was aborted'; break;
            case 'running': cls = 'status--running'; label = 'RUNNING'; tip = 'Run in progress'; break;
            default:        cls = 'status--pending'; label = escHtml(item.state || '?'); tip = '';
        }
        return `<span class="status ${cls}" title="${escHtml(tip)}">${label}</span>`;
    }

    function renderVerdictBadge(item, v) {
        if (!v) {
            // No analytics yet
            if (item.state === 'running') return `<span class="verdict verdict--pending">…</span>`;
            if (item.state === 'error')   return `<span class="verdict verdict--error">N/A</span>`;
            return `<span class="verdict verdict--pending" title="Awaiting analytics assessment">—</span>`;
        }
        switch ((v.verdict || '').toUpperCase()) {
            case 'SUCCESS':      return `<span class="verdict verdict--success">SUCCESS</span>`;
            case 'PARTIAL':      return `<span class="verdict verdict--partial">PARTIAL</span>`;
            case 'FAILED':       return `<span class="verdict verdict--failed">FAILED</span>`;
            case 'NEEDS_REVIEW': return `<span class="verdict verdict--needs-review">NEEDS REVIEW</span>`;
            default:             return `<span class="verdict verdict--pending">${escHtml(v.verdict)}</span>`;
        }
    }

    // ── analytics section ────────────────────────────────────────────────────

    function renderAnalyticsSection(analytics, allResults) {
        // Verdict distribution from verdictMap
        const dist = { SUCCESS: 0, PARTIAL: 0, FAILED: 0, NEEDS_REVIEW: 0 };
        for (const v of Object.values(verdictMap)) {
            const k = (v.verdict || '').toUpperCase();
            if (k === 'SUCCESS' || k === 'PARTIAL' || k === 'FAILED' || k === 'NEEDS_REVIEW') dist[k]++;
        }

        // Distribution pills
        analyticsDistrib.innerHTML =
            `<span class="dist-pill dist-pill--success" title="${dist.SUCCESS} problem(s) fully solved">SUCCESS ${dist.SUCCESS}</span>` +
            `<span class="dist-pill dist-pill--partial" title="${dist.PARTIAL} problem(s) with partial progress">PARTIAL ${dist.PARTIAL}</span>` +
            `<span class="dist-pill dist-pill--failed"  title="${dist.FAILED} problem(s) with no useful output">FAILED ${dist.FAILED}</span>` +
            (dist.NEEDS_REVIEW > 0
                ? `<span class="dist-pill dist-pill--needs-review" title="${dist.NEEDS_REVIEW} problem(s) need human review">NEEDS REVIEW ${dist.NEEDS_REVIEW}</span>`
                : '');

        // Aggregate run stats (from actual results, not from analytics)
        const done = allResults.filter(Boolean);
        const totalLlm   = done.reduce((s, r) => s + (r.llmCallCount  || 0), 0);
        const totalTools = done.reduce((s, r) => s + (r.toolCallCount  || 0), 0);
        const totalCost  = done.reduce((s, r) => s + (r.totalCostUSD   || 0), 0);
        analyticsTotals.textContent =
            `${done.length} tests · ${totalLlm} LLM calls · ${totalTools} tool calls · $${totalCost.toFixed(4)} total cost`;

        // Narrative / fallback
        let narrative = '';
        if (analytics && analytics.parsed && analytics.parsed.narrative) {
            narrative = analytics.parsed.narrative;
        } else if (analytics && analytics.text) {
            narrative = analytics.text.slice(0, 600);
        } else if (analytics && analytics.error) {
            narrative = '(analytics error: ' + analytics.error + ')';
        }
        analyticsNarrative.textContent = narrative;

        // Raw JSON toggle
        if (analytics) {
            analyticsRawPre.textContent = JSON.stringify(
                analytics.parsed || { text: analytics.text, error: analytics.error }, null, 2
            );
        }

        analyticsSection.style.display = '';
    }

    // ── totals footer ────────────────────────────────────────────────────────

    function updateTotals() {
        const done = results.filter(Boolean);
        if (!done.length && !suiteStartedAt) { resultsFoot.innerHTML = ''; return; }
        const totalLlm   = done.reduce((s, r) => s + (r.llmCallCount  || 0), 0);
        const totalTools = done.reduce((s, r) => s + (r.toolCallCount  || 0), 0);
        const totalCost  = done.reduce((s, r) => s + (r.totalCostUSD   || 0), 0);
        const sumTaskMs  = done.reduce((s, r) => s + (r.durationMs     || 0), 0);
        const wallEnd    = suiteEndedAt || Date.now();
        const wallMs     = suiteStartedAt ? Math.max(0, wallEnd - suiteStartedAt) : 0;
        const fmt        = (ms) => {
            const s = Math.round(ms / 1000);
            if (s < 60) return s + 's';
            const m = Math.floor(s / 60);
            const r = s % 60;
            return m + 'm' + (r ? ' ' + r + 's' : '');
        };
        const wallLabel  = suiteEndedAt ? 'wall-clock' : 'wall-clock so far';
        resultsFoot.innerHTML =
            `<tr><td colspan="4" style="text-align:right">Totals (${done.length}/${total} tests)</td>` +
            `<td>${totalLlm}</td><td>${totalTools}</td>` +
            `<td>$${totalCost.toFixed(4)}</td>` +
            `<td title="Sum of per-task durations">${fmt(sumTaskMs)}</td><td></td></tr>` +
            `<tr><td colspan="7" style="text-align:right;opacity:0.75">${wallLabel}</td>` +
            `<td colspan="2" style="font-variant-numeric:tabular-nums">${fmt(wallMs)}</td></tr>`;
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function setPill(state, text) {
        statusPill.dataset.state = state;
        statusPill.textContent   = text;
    }

    function setProgress(done, total, label) {
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        progressFill.style.width  = pct + '%';
        progressLabel.textContent = label || '';
    }

    function escHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── ready handshake ──────────────────────────────────────────────────────
    vscode.postMessage({ command: 'scriptLoaded' });
})();
