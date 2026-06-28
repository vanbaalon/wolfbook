/* global acquireVsCodeApi */
'use strict';
// Charm Debugger webview — runs inside the VS Code WebviewPanel sandbox.

(function () {
    const vscode = acquireVsCodeApi();

    // ── state ─────────────────────────────────────────────────────────────────
    let allExamples       = [];
    let selectedExample   = null;
    let filterText        = '';
    let isRunning         = false;
    let defaultPrompt     = '';
    let defaultToolSpecs  = [];  // [{name, description, fullSpec}]
    let runTotalCostUSD   = 0;
    let runLlmCallCount   = 0;

    // ── dom refs ──────────────────────────────────────────────────────────────
    const $ = id => document.getElementById(id);

    // ── message bus ───────────────────────────────────────────────────────────
    window.addEventListener('message', ({ data: msg }) => {
        if (!msg) return;
        switch (msg.command) {
            case 'charmExamples':
                allExamples = Array.isArray(msg.examples) ? msg.examples : [];
                $('exampleStatus').textContent = msg.error
                    ? `Error: ${msg.error}`
                    : `${allExamples.length} run${allExamples.length !== 1 ? 's' : ''}`;
                renderList();
                break;

            case 'prompts.snapshot':
                defaultPrompt    = msg.systemPrompt || '';
                defaultToolSpecs = Array.isArray(msg.toolSpecs) ? msg.toolSpecs : [];
                populatePromptEditor(defaultPrompt);
                populateToolEditors(defaultToolSpecs);
                break;

            case 'isolatedRun.event': {
                const ev = msg.event || {};
                if (ev.type === 'prefill.task') {
                    // Pre-fill the charm editor with a task from the Control Room
                    // "Quick Compute" mode — switch to the Charm tab and set the task.
                    const taskText = String(ev.task || '');
                    const freshCharm = { id: 'C01', title: taskText.slice(0, 60), task: taskText, deliverables: [], constraints: [], validationChecks: [] };
                    const freshQuest = { id: 'Q01', title: taskText.slice(0, 60), objective: taskText, successCriteria: [] };
                    $('questEditor').value = JSON.stringify(freshQuest, null, 2);
                    $('charmEditor').value = JSON.stringify(freshCharm, null, 2);
                    // Switch to the Charm tab and show templates hidden
                    const charmTab = document.querySelector('[data-tab="charm"]');
                    if (charmTab) charmTab.click();
                    const tplSection = $('taskTemplateSection');
                    if (tplSection) tplSection.hidden = true;
                } else {
                    appendRunEvent(ev);
                }
                break;
            }

            case 'isolatedRun.done':
                finishRun(msg.scroll, msg.error);
                break;
        }
    });

    // ── list rendering ────────────────────────────────────────────────────────
    function renderList() {
        const q = filterText.toLowerCase();
        const rows = allExamples.filter(ex => {
            if (!q) return true;
            return [
                (ex.quest && (ex.quest.title || ex.quest.id)) || '',
                (ex.charm && (ex.charm.goal || ex.charm.title || ex.charmId)) || '',
                (ex.verdict && ex.verdict.verdict) || '',
                ex.runFile || '',
            ].join(' ').toLowerCase().includes(q);
        });

        const list = $('exampleList');
        if (rows.length === 0) {
            list.innerHTML = `<div class="cd-empty-list">${
                allExamples.length === 0
                    ? 'No charm runs in telemetry yet. Run a research task first.'
                    : 'No examples match the filter.'
            }</div>`;
            return;
        }
        list.innerHTML = '';
        rows.forEach(ex => list.appendChild(buildListRow(ex)));
    }

    function buildListRow(ex) {
        const questTitle = (ex.quest && (ex.quest.title || ex.quest.id)) || '(unknown quest)';
        const charmGoal  = (ex.charm && (ex.charm.goal || ex.charm.title || ex.charm.id)) || ex.charmId || '';
        const runFile    = ex.runFile || '';
        const verdict    = (ex.verdict && ex.verdict.verdict) || 'unknown';
        const conf       = ex.scroll && typeof ex.scroll.confidence === 'number' ? ex.scroll.confidence : null;
        const turns      = ex.cost && ex.cost.llmTurns != null ? ex.cost.llmTurns : null;
        const sr         = ex.scroll && ex.scroll.self_review;

        const row = document.createElement('div');
        row.className = 'cd-row' + (selectedExample === ex ? ' selected' : '');
        row.innerHTML = `
            <div class="cd-row-top">
                <div class="cd-quest-name" title="${esc(questTitle)}">${esc(questTitle)}</div>
            </div>
            ${charmGoal ? `<div class="cd-charm-name" title="${esc(charmGoal)}">${esc(charmGoal)}</div>` : ''}
            <div class="cd-run-file">${esc(runFile)}</div>
            <div class="cd-row-chips">
                <span class="cd-verdict ${verdictCls(verdict)}">${esc(verdict)}</span>
                ${conf !== null ? `<span class="cd-chip ${confCls(conf)}">${(conf*100).toFixed(0)}%</span>` : ''}
                ${turns !== null ? `<span class="cd-chip">${turns}t</span>` : ''}
                ${srChip(sr)}
            </div>`;
        row.addEventListener('click', () => selectExample(ex));
        return row;
    }

    // ── example selection ─────────────────────────────────────────────────────
    function selectExample(ex) {
        selectedExample = ex;
        activeTemplateIdx = -1;
        $('taskTemplateSection').hidden = true; // hide picker when selecting from telemetry
        renderList(); // re-render to update selected highlight

        // Show debug panel
        $('noSelection').hidden = true;
        $('debugPanel').hidden  = false;

        // Populate charm header
        const questTitle = (ex.quest && (ex.quest.title || ex.quest.id)) || 'Unknown Quest';
        const charmGoal  = (ex.charm && (ex.charm.goal || ex.charm.title || ex.charm.id)) || ex.charmId || 'Unknown Charm';
        $('selectedCharmTitle').textContent = `${questTitle}  /  ${charmGoal}`;

        // Populate charm/quest editors
        populateCharmEditors(ex);

        // Clear run feed from previous
        $('runFeed').innerHTML = '';
        $('runResult').hidden = true;
        setRunStatus('idle', '');

        // Ensure right tab is on Live Run
        switchTab('run');
    }

    // ── tab switching ─────────────────────────────────────────────────────────
    document.querySelectorAll('.cd-tab').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    function switchTab(tabName) {
        document.querySelectorAll('.cd-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
        document.querySelectorAll('.cd-tab-pane').forEach(p => {
            p.hidden = p.id !== `tab-${tabName}`;
        });
    }

    // ── prompt editor ─────────────────────────────────────────────────────────
    function populatePromptEditor(text) {
        const ta = $('promptEditor');
        if (!ta.dataset.dirty) ta.value = text;
        updatePromptCharCount();
    }

    $('promptEditor').addEventListener('input', () => {
        $('promptEditor').dataset.dirty = '1';
        updatePromptCharCount();
    });

    function updatePromptCharCount() {
        const n = $('promptEditor').value.length;
        $('promptCharCount').textContent = `${n} chars (~${Math.round(n/4)} tokens)`;
    }

    $('resetPromptBtn').addEventListener('click', () => {
        $('promptEditor').value = defaultPrompt;
        delete $('promptEditor').dataset.dirty;
        updatePromptCharCount();
    });

    // ── tool editors ──────────────────────────────────────────────────────────
    function populateToolEditors(specs) {
        const container = $('toolEditors');
        if (!container.dataset.dirty) {
            container.innerHTML = '';
            for (const spec of specs) {
                const g = document.createElement('div');
                g.className = 'cd-tool-editor-group';
                g.dataset.toolName = spec.name;
                g.innerHTML = `
                    <div class="cd-tool-name">${esc(spec.name)}</div>
                    <textarea class="cd-tool-desc-editor" spellcheck="false">${esc(spec.description || '')}</textarea>`;
                container.appendChild(g);
            }
        }
    }

    $('resetToolsBtn').addEventListener('click', () => {
        delete $('toolEditors').dataset.dirty;
        populateToolEditors(defaultToolSpecs);
    });

    $('toolEditors').addEventListener('input', () => {
        $('toolEditors').dataset.dirty = '1';
    });

    function gatherToolDescriptions() {
        const result = {};
        document.querySelectorAll('.cd-tool-editor-group').forEach(g => {
            const name = g.dataset.toolName;
            const ta   = g.querySelector('textarea');
            if (name && ta) result[name] = ta.value;
        });
        return result;
    }

    // ── charm/quest editors ───────────────────────────────────────────────────
    function populateCharmEditors(ex) {
        // Quest editor: show editable JSON of the quest fields fairy uses
        const questBlock = {
            id:              (ex.quest && ex.quest.id)              || 'Q01',
            title:           (ex.quest && ex.quest.title)           || '',
            objective:       (ex.quest && ex.quest.objective)       || (ex.quest && ex.quest.description) || '',
            successCriteria: (ex.quest && ex.quest.successCriteria) || [],
        };
        const charmBlock = {
            id:               (ex.charm && ex.charm.id)               || 'C01',
            title:            (ex.charm && (ex.charm.title || ex.charm.goal)) || '',
            task:             (ex.charm && ex.charm.task)             || (ex.charm && ex.charm.goal) || '',
            deliverables:     (ex.charm && ex.charm.deliverables)     || [],
            constraints:      (ex.charm && ex.charm.constraints)      || [],
            validationChecks: (ex.charm && ex.charm.validationChecks) || [],
        };
        $('questEditor').value = JSON.stringify(questBlock, null, 2);
        $('charmEditor').value = JSON.stringify(charmBlock, null, 2);
        $('validationEditor').value = ((ex.charm && ex.charm.validationChecks) || []).join('\n');
    }

    function gatherCharmOverrides() {
        let quest = null, charm = null;
        try { quest = JSON.parse($('questEditor').value); } catch (_) {}
        try { charm = JSON.parse($('charmEditor').value); } catch (_) {}

        // Apply validationChecks from the dedicated editor (overrides the JSON field)
        const vcLines = $('validationEditor').value.split('\n').map(s => s.trim()).filter(Boolean);
        if (charm && vcLines.length > 0) charm.validationChecks = vcLines;

        return { quest, charm };
    }

    // ── task templates ────────────────────────────────────────────────────────
    const TEMPLATES = [
        {
            label: 'Trivial integral',
            code:  'Integrate[Sin[x]^2, {x,0,π}]',
            hint:  'Smoke test — single closed-form result, should always deliver',
            quest: {
                id: 'Q-smoke', title: 'Smoke test — trivial integral',
                objective: 'Verify end-to-end Fairy delivery with a trivial closed-form result.',
                successCriteria: ['result equals Pi/2'],
            },
            charm: {
                id: 'C01', title: 'Compute definite integral',
                task: 'Compute Integrate[Sin[x]^2, {x, 0, Pi}] and record the exact symbolic result.',
                deliverables: ['exact closed-form value'],
                constraints: [], validationChecks: [],
            },
        },
        {
            label: 'Two-step pipeline',
            code:  'f[x_]:=x³+x → Integrate[f,{x,0,1}]',
            hint:  'Define a function, then integrate it — tests multi-step chain',
            quest: {
                id: 'Q-pipeline', title: 'Two-step define-then-apply',
                objective: 'Define f and integrate it — tests dependency chain between two steps.',
                successCriteria: ['integral evaluates to 3/4'],
            },
            charm: {
                id: 'C01', title: 'Integrate f over [0,1]',
                task: 'Define f[x_] := x^3 + x. Then compute Integrate[f[x], {x, 0, 1}] and record the exact result.',
                deliverables: ['exact value of the integral'],
                constraints: [], validationChecks: [],
            },
        },
        {
            label: 'Redefinition test',
            code:  'g=3, g=5 → g² (harness drops g=3)',
            hint:  'Regression: harness must auto-drop the earlier g=3 step, no invalidate',
            quest: {
                id: 'Q-redef', title: 'Redefinition harness test',
                objective: 'Verify the harness resolves symbol redefinition without invalidate calls.',
                successCriteria: ['delivers g^2 = 25', 'no invalidate in telemetry'],
            },
            charm: {
                id: 'C01', title: 'Compute g squared after redefinition',
                task: 'First try g = 3 (wrong). Then redefine g = 5 (correct). Compute g^2 and record the result. The final chain should keep only the g=5 step.',
                deliverables: ['g^2 = 25'],
                constraints: [], validationChecks: [],
            },
        },
        {
            label: 'Matrix eigenvalues',
            code:  'Eigenvalues[{{1,2},{3,4}}]',
            hint:  'Single-step result with irrational numbers — tests in-kernel comparison',
            quest: {
                id: 'Q-eigen', title: 'Matrix eigenvalues',
                objective: 'Compute eigenvalues of a concrete 2×2 matrix in exact radical form.',
                successCriteria: ['two eigenvalues returned as exact radicals'],
            },
            charm: {
                id: 'C01', title: 'Eigenvalues of {{1,2},{3,4}}',
                task: 'Compute Eigenvalues[{{1, 2}, {3, 4}}] and record the exact result (in radical form).',
                deliverables: ['exact eigenvalues'],
                constraints: [], validationChecks: [],
            },
        },
        {
            label: 'Blank / custom',
            code:  '— write your own task below —',
            hint:  'Fill in the quest and charm editors freely',
            quest: {
                id: 'Q-custom', title: 'Custom task',
                objective: 'Describe the goal here.',
                successCriteria: [],
            },
            charm: {
                id: 'C01', title: 'Custom computation',
                task: 'Describe the task here.',
                deliverables: [], constraints: [], validationChecks: [],
            },
        },
    ];

    let activeTemplateIdx = -1;

    function renderTemplates() {
        const grid = $('templateGrid');
        if (!grid) return;
        grid.innerHTML = '';
        TEMPLATES.forEach((t, idx) => {
            const card = document.createElement('div');
            card.className = 'cd-template-card' + (idx === activeTemplateIdx ? ' cd-template-card--active' : '');
            card.innerHTML =
                `<div class="cd-template-card-title">${esc(t.label)}</div>` +
                `<div class="cd-template-card-code">${esc(t.code)}</div>` +
                `<div class="cd-template-card-hint">${esc(t.hint)}</div>`;
            card.addEventListener('click', () => applyTemplate(t, idx));
            grid.appendChild(card);
        });
    }

    function applyTemplate(t, idx) {
        activeTemplateIdx = idx;
        // Update the stored example so startRun has a fallback.
        selectedExample = { quest: { ...t.quest }, charm: { ...t.charm } };
        // Fill editors.
        $('questEditor').value  = JSON.stringify(t.quest, null, 2);
        $('charmEditor').value  = JSON.stringify(t.charm, null, 2);
        $('validationEditor').value = '';
        // Re-render cards to update active highlight.
        renderTemplates();
    }

    // ── new task ──────────────────────────────────────────────────────────────
    $('newTaskBtn').addEventListener('click', () => {
        if (isRunning) return;
        activeTemplateIdx = -1;
        // Start with blank template pre-selected (last one).
        const blank = TEMPLATES[TEMPLATES.length - 1];
        selectedExample = { quest: { ...blank.quest }, charm: { ...blank.charm } };
        renderList(); // deselect any highlighted row
        $('noSelection').hidden = true;
        $('debugPanel').hidden  = false;
        $('selectedCharmTitle').textContent = 'New direct task';
        $('runFeed').innerHTML  = '';
        $('runResult').hidden   = true;
        setRunStatus('idle', '');
        // Show the template picker and populate with blank as initial state.
        $('taskTemplateSection').hidden = false;
        renderTemplates();
        // Apply blank template to seed the editors.
        applyTemplate(blank, TEMPLATES.length - 1);
        // Switch to Charm tab so user sees template picker + editors.
        switchTab('charm');
    });

    $('dismissTemplatesBtn').addEventListener('click', () => {
        $('taskTemplateSection').hidden = true;
    });

    // ── run controls ──────────────────────────────────────────────────────────
    $('runBtn').addEventListener('click', () => {
        if (isRunning) return;
        // Allow run even without a telemetry example — quest/charm come from editors.
        const { quest, charm } = gatherCharmOverrides();
        if (!quest || !quest.id || !charm || !charm.id) {
            setRunStatus('done-err', '✗ Fill in Quest and Charm editors first (Charm/Quest tab)');
            return;
        }
        startRun();
    });

    $('abortBtn').addEventListener('click', () => {
        vscode.postMessage({ command: 'abortIsolatedRun' });
    });

    function startRun() {
        isRunning = true;
        runTotalCostUSD = 0;
        runLlmCallCount = 0;
        $('runBtn').disabled  = true;
        $('abortBtn').disabled = false;
        $('runFeed').innerHTML = '';
        $('runCostBar').hidden = true;
        $('runResult').hidden  = true;
        setRunStatus('running', '⚡ Running…');
        switchTab('run');

        const { quest, charm } = gatherCharmOverrides();
        const overrides = {
            systemPrompt:    $('promptEditor').value,
            toolDescriptions: gatherToolDescriptions(),
            quest:  quest  || undefined,
            charm:  charm  || undefined,
        };
        // Pass selectedExample only as fallback; overrides.quest/charm take precedence.
        vscode.postMessage({ command: 'rerunCharm', example: selectedExample || {}, overrides });
    }

    function finishRun(scroll, error) {
        isRunning = false;
        $('runBtn').disabled   = false;
        $('abortBtn').disabled = true;

        if (error) {
            setRunStatus('done-err', `✗ ${error}`);
            return;
        }
        if (!scroll) {
            setRunStatus('done-err', '✗ No scroll returned');
            return;
        }

        const conf = typeof scroll.confidence === 'number' ? scroll.confidence : null;
        const costNote = runTotalCostUSD > 0 ? ` · $${runTotalCostUSD.toFixed(4)}` : '';
        setRunStatus('done-ok', `✓ Done — conf: ${conf !== null ? (conf*100).toFixed(0)+'%' : '?'}${costNote}`);
        showRunResult(scroll);
    }

    function setRunStatus(cls, text) {
        const el = $('runStatus');
        el.className = `cd-run-status ${cls}`;
        el.textContent = text;
    }

    function updateCostBar() {
        const bar = $('runCostBar');
        bar.hidden = false;
        bar.innerHTML =
            `<span class="cd-cost-label">Cost so far:</span>` +
            `<span class="cd-cost-total">$${runTotalCostUSD.toFixed(4)}</span>` +
            `<span class="cd-cost-calls">${runLlmCallCount} LLM call${runLlmCallCount !== 1 ? 's' : ''}</span>`;
    }

    // ── run feed ──────────────────────────────────────────────────────────────
    function appendRunEvent(ev) {
        if (!ev) return;
        const kind    = ev.kind || ev.event || '';
        const data    = ev.data || ev;
        const ts      = (ev.timestamp || '').replace('T', ' ').replace(/\.\d+Z$/, '');
        const tsShort = ts.split(' ')[1] || '';
        const feedEl  = $('runFeed');

        // Skip per-chunk reasoning tokens — too noisy, no signal.
        if (kind === 'llm.reasoning_progress') return;

        // response_progress: sliding preview — update the last row for this turn in-place.
        if (kind === 'llm.response_progress') {
            const turnIdx = String(data.turnIndex ?? 'x');
            let previewRow = feedEl.querySelector(`[data-preview-turn="${turnIdx}"]`);
            if (!previewRow) {
                previewRow = document.createElement('div');
                previewRow.className = 'cd-feed-row';
                previewRow.dataset.previewTurn = turnIdx;
                feedEl.appendChild(previewRow);
            }
            // Show the tail of the accumulated content so it stays visible without truncating.
            const full    = String(data.content || data.text || '');
            const preview = full.length > 400 ? '…' + full.slice(-400) : full;
            previewRow.innerHTML = `
                <span class="cd-feed-ts">${esc(tsShort)}</span>
                <span class="cd-feed-kind fairy">llm.response…</span>
                <span class="cd-feed-detail">${esc(preview)}</span>`;
            feedEl.scrollTop = feedEl.scrollHeight;
            return;
        }

        // llm.call fires after all progress events for a turn — replace the preview row.
        if (kind === 'llm.call') {
            const turnIdx = String(data.turnIndex ?? 'x');
            const previewRow = feedEl.querySelector(`[data-preview-turn="${turnIdx}"]`);
            if (previewRow) previewRow.remove();
            // Accumulate cost.
            const callCost = typeof data.costUSD === 'number' ? data.costUSD : 0;
            runTotalCostUSD += callCost;
            runLlmCallCount += 1;
            updateCostBar();
        }

        // Summarise key fields into a one-line detail string.
        let detail = '';
        if (kind === 'fairy.turn_summary') {
            detail = `turn #${data.turnIndex ?? '?'} · ${data.toolCallCount ?? 0} calls · toolTurns=${data.toolTurns ?? '?'}${data.inSelfCritique ? ' [Phase B]' : ''}`;
        } else if (kind === 'llm.call') {
            // Usage fields use camelCase (inputTokens/outputTokens) from fairy.js.
            const u   = data.usage || {};
            const it  = u.inputTokens  ?? u.prompt_tokens;
            const ot  = u.outputTokens ?? u.completion_tokens;
            const cr  = u.cacheReadTokens;
            const model   = data.model ? String(data.model).split('/').pop() : '';
            const tokens  = (it != null || ot != null) ? `${it ?? '?'}→${ot ?? '?'} tok` : '';
            const cache   = cr ? ` (${cr} cached)` : '';
            const costStr = typeof data.costUSD === 'number' ? ` · $${data.costUSD.toFixed(4)}` : '';
            const latency = data.latencyMs ? ` · ${(data.latencyMs / 1000).toFixed(1)}s` : '';
            detail = [model, tokens + cache + costStr + latency].filter(Boolean).join(' · ')
                  || summariseData(data);
        } else if (kind === 'tool.call') {
            detail = `${data.name || ''}(${shortArgs(data.arguments)})`;
        } else if (kind === 'correlated.tool') {
            detail = `${data.name || ''} → ${data.result && data.result.ok ? '✓' : '✗'} ${shortResult(data.result)}`;
        } else if (kind === 'scroll.submitted') {
            detail = `confidence=${typeof data.confidence === 'number' ? data.confidence.toFixed(2) : '?'} · ${data.findingsCount ?? 0} findings`;
        } else if (kind === 'charm.self_review_started') {
            detail = `${data.validationCheckCount ?? 0} checks · after ${data.phaseAToolTurns ?? '?'} tool turns`;
        } else if (kind === 'charm.self_review') {
            detail = `passed=${data.passed ?? 0} failed=${data.failed ?? 0}`;
        } else if (kind === 'omen') {
            detail = `[${data.kind || ''}] ${String(data.message || '').slice(0, 120)}`;
        } else if (kind === 'fairy.started') {
            detail = `${data.provider || ''} / ${data.model || ''}`;
        } else {
            detail = summariseData(data);
        }

        const row = document.createElement('div');
        row.className = 'cd-feed-row';
        row.innerHTML = `
            <span class="cd-feed-ts">${esc(tsShort)}</span>
            <span class="cd-feed-kind ${kindCls(kind)}">${esc(kind)}</span>
            <span class="cd-feed-detail">${esc(detail)}</span>`;
        feedEl.appendChild(row);
        feedEl.scrollTop = feedEl.scrollHeight;
    }

    // ── run result display ────────────────────────────────────────────────────
    function showRunResult(scroll) {
        const el = $('runResult');
        el.hidden = false;

        const findings = Array.isArray(scroll.findings) ? scroll.findings : [];
        const sr = scroll.self_review;

        let html = `<h4>Result</h4><div class="cd-result-scroll">`;
        html += `<strong>Summary:</strong> ${esc(String(scroll.summary || '').slice(0, 300))}<br>`;
        html += `<strong>Confidence:</strong> ${typeof scroll.confidence === 'number' ? (scroll.confidence*100).toFixed(0)+'%' : '?'}<br>`;
        if (runTotalCostUSD > 0) {
            html += `<strong>Cost:</strong> $${runTotalCostUSD.toFixed(4)} over ${runLlmCallCount} LLM call${runLlmCallCount !== 1 ? 's' : ''}<br>`;
        }
        if (sr) {
            const p = (sr.passed || []).length, f = (sr.failed || []).length;
            html += `<strong>Self-review:</strong> ✓${p} passed / ✗${f} failed — ${esc(sr.confidence_note || '')}<br>`;
        }
        html += `</div>`;

        if (findings.length > 0) {
            html += `<h4 style="margin-top:8px">Findings</h4><ul class="cd-result-findings">`;
            findings.slice(0, 8).forEach(f => { html += `<li>${esc(String(f || '').slice(0, 300))}</li>`; });
            if (findings.length > 8) html += `<li style="opacity:.6">… ${findings.length-8} more</li>`;
            html += `</ul>`;
        }

        html += `<button class="cd-btn cd-btn--sm" style="margin-top:8px" onclick="
            var j=this.nextElementSibling; j.classList.toggle('open'); this.textContent=j.classList.contains('open')?'Hide JSON':'View full Scroll JSON';
        ">View full Scroll JSON</button>`;
        html += `<div class="cd-result-json">${esc(JSON.stringify(scroll, null, 2))}</div>`;

        el.innerHTML = html;
    }

    // ── controls wiring ───────────────────────────────────────────────────────
    $('filterInput').addEventListener('input', () => {
        filterText = $('filterInput').value.trim();
        renderList();
    });

    $('refreshBtn').addEventListener('click', () => {
        $('exampleStatus').textContent = 'Loading…';
        vscode.postMessage({ command: 'listCharmExamples' });
    });

    // ── helpers ───────────────────────────────────────────────────────────────
    function esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function verdictCls(v) {
        return { success:'success', partial_success:'partial_success', failed:'failed', needs_review:'needs_review' }[v] || 'unknown';
    }
    function confCls(c) { return c >= 0.7 ? 'hi' : c >= 0.4 ? 'mid' : 'lo'; }
    function srChip(sr) {
        if (!sr) return '';
        const p = (sr.passed||[]).length, f = (sr.failed||[]).length;
        if (f > 0) return `<span class="cd-chip sr-fail">✗${f}</span>`;
        if (p > 0) return `<span class="cd-chip sr-pass">✓${p}</span>`;
        return '';
    }
    function kindCls(kind) {
        if (!kind) return '';
        if (kind.startsWith('omen')) return 'omen';
        if (kind.startsWith('fairy')) return 'fairy';
        if (kind.startsWith('tool') || kind.startsWith('correlated')) return 'tool';
        if (kind.startsWith('scroll')) return 'scroll';
        if (kind.startsWith('checkpoint')) return 'checkpoint';
        if (kind.startsWith('charm')) return 'charm';
        return '';
    }
    function shortArgs(args) {
        if (!args) return '';
        const expr = args.expression || args.action || '';
        return String(expr).slice(0, 60) + (String(expr).length > 60 ? '…' : '');
    }
    function shortResult(result) {
        if (!result) return '';
        const v = (result.raw && result.raw.value) || result.value || result.error || '';
        return String(v).slice(0, 80) + (String(v).length > 80 ? '…' : '');
    }
    function summariseData(data) {
        try {
            const s = JSON.stringify(data);
            return s.length > 120 ? s.slice(0, 120) + '…' : s;
        } catch (_) { return ''; }
    }

    // ── boot ──────────────────────────────────────────────────────────────────
    vscode.postMessage({ command: 'scriptLoaded' });
})();
