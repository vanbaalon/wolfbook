// watchPanel.webview.js — Runs inside the VS Code webview panel (NOT in Node.js).
// Loaded via webview.asWebviewUri() so CSP allows it without nonce issues.
// NOTE: acquireVsCodeApi() was already called in the inline <script> block and
// stored as window._vscode. We reuse that reference here.
(function () {
    const vscode      = window._vscode || acquireVsCodeApi();
    const stepHeader  = document.getElementById('step-header');
    const timingEl    = document.getElementById('timing');
    const emptyMsg    = document.getElementById('empty-msg');
    const varTable    = document.getElementById('var-table');
    const varBody     = document.getElementById('var-body');
    const addInput    = document.getElementById('add-input');
    const addBtn      = document.getElementById('add-btn');
    const refreshBtn  = document.getElementById('refresh-btn');

    refreshBtn.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));

    var bpClearBtn = document.getElementById('bp-clear-btn');
    if (bpClearBtn) {
        bpClearBtn.addEventListener('click', function() {
            vscode.postMessage({ command: 'clearBreakpoints' });
        });
    }

    // ── Formatting ─────────────────────────────────────────────────────────
    function formatTiming(ms) {
        if (ms === null || ms === undefined) return '';
        if (ms < 0.001) return (ms * 1e6).toFixed(1) + ' \u03bcs';
        if (ms < 1)     return (ms * 1e3).toFixed(2) + ' ms';
        return ms.toFixed(3) + ' s';
    }

    // ── Table rendering ────────────────────────────────────────────────────
    function renderTable(variables) {
        varBody.innerHTML = '';
        if (!variables || variables.length === 0) {
            varTable.style.display = 'none';
            emptyMsg.style.display = '';
            return;
        }
        varTable.style.display = '';
        emptyMsg.style.display = 'none';
        for (const entry of variables) {
            const name     = entry.name;
            const shortVal = entry.shortVal;
            const fullVal  = entry.fullVal;
            const isWatch  = entry.isWatch;
            const tr = document.createElement('tr');
            const tdName = document.createElement('td');
            tdName.textContent = name;
            const tdVal = document.createElement('td');
            tdVal.className = 'val';
            tdVal.textContent = shortVal;
            if (fullVal && fullVal !== shortVal) tdVal.title = fullVal;
            const tdOpen = document.createElement('td');
            tdOpen.className = 'open-btn';
            if (fullVal) {
                tdOpen.textContent = '\u29c9';
                tdOpen.title = fullVal !== shortVal ? 'Open full value in editor' : 'Open value in editor';
                tdOpen.addEventListener('click', (function(n, fv) {
                    return function() { vscode.postMessage({ command: 'openInEditor', name: n, fullVal: fv }); };
                })(name, fullVal));
            }
            const tdRm = document.createElement('td');
            tdRm.className = 'remove';
            if (isWatch) {
                tdRm.textContent = '\u00d7';
                tdRm.addEventListener('click', (function(n) {
                    return function() { vscode.postMessage({ command: 'removeWatch', name: n }); };
                })(name));
            }
            tr.appendChild(tdName);
            tr.appendChild(tdVal);
            tr.appendChild(tdOpen);
            tr.appendChild(tdRm);
            varBody.appendChild(tr);
        }
    }

    // ── Message handler (extension → webview) ──────────────────────────────
    window.addEventListener('message', function(e) {
        var msg = e.data;

        if (msg.command === 'update') {
            setDebugging(true);
            var si        = msg.stepInfo || {};
            var depth     = si.depth     !== undefined ? si.depth     : '?';
            var localStep = si.localStep !== undefined ? si.localStep : '?';
            var iterVars  = si.iterVars  || {};
            var iterParts = Object.keys(iterVars).map(function(k) { return k + ' = ' + iterVars[k]; });
            var iterStr   = iterParts.length ? ' \u2014 ' + iterParts.join(', ') : '';
            stepHeader.textContent = 'Debug: step ' + depth + '.' + localStep + iterStr;
            var t = msg.timing;
            timingEl.textContent = t != null ? '\u23f1 last: ' + formatTiming(t) : '';
            renderTable(msg.variables || []);

        } else if (msg.command === 'liveUpdate') {
            stepHeader.textContent = 'Live watch';
            timingEl.textContent   = '';
            emptyMsg.textContent   = 'Add variables below to monitor them.';
            renderTable(msg.variables || []);

        } else if (msg.command === 'initWatchList') {
            // Show watch list names with placeholder values immediately (before kernel eval)
            var names = msg.names || [];
            if (names.length > 0) {
                var placeholders = names.map(function(n) {
                    return { name: n, shortVal: '\u2026', fullVal: '', isWatch: true };
                });
                renderTable(placeholders);
            } else {
                varBody.innerHTML = '';
                varTable.style.display = 'none';
                emptyMsg.style.display = '';
            }

        } else if (msg.command === 'clear') {
            stepHeader.textContent = 'Live watch';
            timingEl.textContent   = '';
            emptyMsg.textContent   = 'Add variables below to monitor them.';
            varBody.innerHTML      = '';
            varTable.style.display = 'none';
            emptyMsg.style.display = '';
            setDebugging(false);

        } else if (msg.command === 'setDebugActive') {
            setDebugging(msg.active);
            stepHeader.textContent = msg.active ? 'Debug active' : 'Live watch';

        } else if (msg.command === 'log') {
            appendLog(msg.text);

        } else if (msg.command === 'updateBreakpoints') {
            var bpList  = msg.breakpoints || [];   // [{uri, cellLabel, lines:[]}]
            var bpEl    = document.getElementById('bp-list');
            var bpEmpty = document.getElementById('bp-empty');
            if (!bpEl) return;
            bpEl.innerHTML = '';
            var total = 0;
            bpList.forEach(function(bp) {
                bp.lines.forEach(function(lineNum) {
                    total++;
                    var row = document.createElement('div');
                    row.className = 'bp-row';
                    var label = document.createElement('span');
                    label.className = 'bp-row-label';
                    label.textContent = (bp.cellLabel || bp.uri) + ':' + (lineNum + 1);
                    label.title = bp.uri + ' line ' + (lineNum + 1);
                    var rmBtn = document.createElement('button');
                    rmBtn.className = 'bp-rm';
                    rmBtn.textContent = '\u00d7';
                    rmBtn.title = 'Remove breakpoint';
                    (function(uri, ln) {
                        rmBtn.addEventListener('click', function() {
                            vscode.postMessage({ command: 'removeBreakpoint', uri: uri, line: ln });
                        });
                    })(bp.uri, lineNum);
                    row.appendChild(label);
                    row.appendChild(rmBtn);
                    bpEl.appendChild(row);
                });
            });
            bpEmpty.style.display = total === 0 ? '' : 'none';
        }

        else if (msg.command === 'evalSelUpdate') {
            showEvalSel();
            evalSelFormat.textContent = msg.format || '';
            setEvalSelExpr(msg.expr);
            evalSelContent.innerHTML = msg.html || '';
            if (evalSelOpen) evalSelOpen.style.display = msg.hasOpen ? '' : 'none';
        }
        else if (msg.command === 'evalSelSpinner') {
            showEvalSel();
            evalSelFormat.textContent = '';
            setEvalSelExpr(msg.expr);
            evalSelContent.innerHTML = '<span class="eval-sel-spinner">\u23f3</span> Evaluating\u2026';
            if (evalSelOpen) evalSelOpen.style.display = 'none';
        }
        else if (msg.command === 'evalSelError') {
            showEvalSel();
            evalSelFormat.textContent = '';
            setEvalSelExpr(msg.expr);
            evalSelContent.innerHTML = '<div class="eval-sel-error">\u26a0 ' + escHtml(msg.msg || 'Unknown error') + '</div>';
            if (evalSelOpen) evalSelOpen.style.display = 'none';
        }
        else if (msg.command === 'evalSelClear') {
            hideEvalSel();
            evalSelContent.innerHTML = '';
            evalSelExpr.textContent = '';
            if (evalSelOpen) evalSelOpen.style.display = 'none';
        }
        else if (msg.command === 'setBackground') {
            // null/empty → clear inline override, fall back to CSS var (sidebar bg)
            document.body.style.backgroundColor = msg.color || '';
        }
        else if (msg.command === 'hoverDoc') {
            var hoverDocSection = document.getElementById('hover-doc-section');
            var hoverDocSymbol  = document.getElementById('hover-doc-symbol');
            var hoverDocContent = document.getElementById('hover-doc-content');
            if (hoverDocSymbol)  hoverDocSymbol.textContent  = msg.symbol || '';
            if (hoverDocContent) hoverDocContent.innerHTML   = msg.html   || '';
            if (hoverDocSection) { hoverDocSection.style.display = 'block'; hoverDocSection.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        }
        else if (msg.command === 'mcpState') {
            if (window._mcpToggle) {
                window._mcpToggle.checked = !!msg.enabled;
                if (window._mcpUpdateLabel) window._mcpUpdateLabel();
            }
        }
        else if (msg.command === 'mcpInfo') {
            renderMcpInfo(msg);
        }
        else if (msg.command === 'collabState') {
            if (window._collabToggle) {
                window._collabToggle.checked = !!msg.enabled;
            }
        }
    });

    // ── Toggle change handlers ─────────────────────────────────────────────
    if (window._mcpToggle) {
        window._mcpToggle.addEventListener('change', function() {
            if (window._mcpUpdateLabel) window._mcpUpdateLabel();
            vscode.postMessage({ command: 'mcpToggle', enabled: window._mcpToggle.checked });
        });
    }
    if (window._collabToggle) {
        window._collabToggle.addEventListener('change', function() {
            console.log('[wolfbook-collab] toggle changed, checked=' + window._collabToggle.checked);
            vscode.postMessage({ command: 'collabToggle', enabled: window._collabToggle.checked });
        });
    } else {
        console.warn('[wolfbook-collab] _collabToggle NOT found in DOM');
    }

    // ── MCP info panel renderer ────────────────────────────────────────────

    /**
     * Populate the #mcp-info-panel div with dynamically-generated configuration
     * info. Called whenever the extension sends a `mcpInfo` message.
     */
    function renderMcpInfo(info) {
        var panel = window._mcpInfoPanel;
        if (!panel) return;

        var port       = info.port       || 0;
        var bridge     = info.bridgePath || '';
        var node       = info.nodeBin    || '';
        var disabled   = !!info.isDisabled;
        var secondary  = !!info.isSecondary;
        var cfgPaths   = info.configPaths  || {};
        var configured = info.configured   || {};

        // Status line
        var statusColor = disabled ? '#888' : '#3fb950';
        var statusDot   = disabled ? '○' : '●';
        var statusText  = disabled  ? 'Disabled'
                        : secondary ? 'Running · secondary window (shares port ' + port + ')'
                        : 'Running · port ' + port;

        // Build config file rows
        var agents = [
            { key: 'claudeDesktop', label: 'Claude Desktop',
              cmd: 'wolfbook.configureClaude',    cmdLabel: 'Auto-configure' },
            { key: 'claudeCode',    label: 'Claude Code',
              cmd: null,                          cmdLabel: null },
            { key: 'cline',         label: 'Cline / RooCode',
              cmd: 'wolfbook.configureCline',     cmdLabel: 'Auto-configure' },
            { key: 'antigravity',   label: 'Antigravity (Gemini CLI)',
              cmd: 'wolfbook.configureAntigravity', cmdLabel: 'Auto-configure' },
            { key: 'codex',         label: 'OpenAI Codex CLI',
              cmd: null,                          cmdLabel: null },
        ];

        var esc = function(s) {
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        };

        var agentRows = agents.map(function(a) {
            var cfgPath = cfgPaths[a.key] || '—';
            var ok      = configured[a.key];
            var tick    = ok
                ? '<span style="color:#3fb950;" title="wolfbook entry present">✓</span>'
                : '<span style="color:#888;" title="not yet configured">✗</span>';
            var autoBtn = (a.cmd && !ok)
                ? ' <a href="#" data-cmd="' + esc(a.cmd) + '" style="color:var(--vscode-textLink-foreground,#4e94ce); text-decoration:none;" title="Run the auto-configure VS Code command">' + esc(a.cmdLabel) + '</a>'
                : '';
            return '<tr><td style="padding-right:6px; white-space:nowrap;">' + tick + ' ' + esc(a.label) + autoBtn + '</td>'
                 + '<td style="opacity:0.6; word-break:break-all;">' + esc(cfgPath) + '</td></tr>';
        }).join('');

        // Manual snippet
        var snippet = JSON.stringify({ command: node, args: [bridge] }, null, 2);

        var html = [
            '<div style="margin-bottom:6px;">',
            '  <span style="color:' + statusColor + '; font-weight:600;">' + statusDot + ' ' + esc(statusText) + '</span>',
            '</div>',

            '<table style="border-collapse:collapse; width:100%; margin-bottom:8px;">',
            '  <tr><td style="padding-right:6px; white-space:nowrap; opacity:0.7;">Node</td>',
            '      <td style="opacity:0.6; word-break:break-all;">' + esc(node || '(not found)') + '</td></tr>',
            '  <tr><td style="padding-right:6px; white-space:nowrap; opacity:0.7;">Bridge</td>',
            '      <td style="opacity:0.6; word-break:break-all;">' + esc(bridge) + '</td></tr>',
            '</table>',

            '<div style="opacity:0.75; margin-bottom:3px; font-weight:600;">Agent config files</div>',
            '<table style="border-collapse:collapse; width:100%; margin-bottom:8px;">',
            agentRows,
            '</table>',

            '<div style="opacity:0.75; margin-bottom:3px; font-weight:600;">Manual config snippet</div>',
            '<div style="opacity:0.6; margin-bottom:2px; font-size:10px;">Add to your agent\'s MCP config under <code>mcpServers.wolfbook</code> (or equivalent):</div>',
            '<pre style="margin:0 0 8px; padding:6px 8px; background:var(--vscode-textCodeBlock-background,#1e1e1e); border-radius:3px; overflow-x:auto; font-size:10.5px; line-height:1.5; white-space:pre-wrap;">' + esc(snippet) + '</pre>',

            '<div style="opacity:0.75; margin-bottom:3px; font-weight:600;">Tips</div>',
            '<ul style="margin:0 0 2px; padding-left:14px; opacity:0.7; line-height:1.6;">',
            '  <li>Toggle requires a <strong>window reload</strong> to take effect.</li>',
            '  <li>Each VS Code window joins as a client; the <em>primary</em> window runs the HTTP server — secondaries share its port.</li>',
            '  <li>Tool calls target the <em>last active</em> Wolfbook notebook in this window. Use <code>wolfbook_setTarget</code> to pin a specific file.</li>',
            '  <li>Port range: ' + (port || 27182) + '–' + ((port || 27182) + 19) + ' (tries next free port on conflict).</li>',
            '  <li>For Claude Code: add to <code>~/.claude.json</code> under <code>mcpServers</code>, or run <code>claude mcp add wolfbook --transport stdio ' + esc(node) + ' ' + esc(bridge) + '</code>.</li>',
            '  <li>For Codex CLI: add to <code>~/.codex/config.toml</code> under <code>[mcp_servers.wolfbook]</code>.</li>',
            '</ul>',
        ].join('\n');

        panel.innerHTML = html;

        // Wire up auto-configure link clicks
        panel.querySelectorAll('a[data-cmd]').forEach(function(link) {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                vscode.postMessage({ command: 'runVSCodeCommand', id: link.dataset.cmd });
            });
        });
    }

    // ── Add watch ──────────────────────────────────────────────────────────

    /** Balanced-bracket WL syntax check. Returns null on success, error string on failure. */
    function validateWLSyntax(expr) {
        var i = 0, n = expr.length, stack = [];
        while (i < n) {
            var c = expr[i];
            // Skip string literals
            if (c === '"') {
                i++;
                while (i < n) {
                    if (expr[i] === '\\') { i += 2; continue; }
                    if (expr[i] === '"') { i++; break; }
                    i++;
                }
                continue;
            }
            // Skip WL comments (* ... *)
            if (c === '(' && i + 1 < n && expr[i + 1] === '*') {
                var depth = 1; i += 2;
                while (i < n - 1 && depth > 0) {
                    if (expr[i] === '(' && expr[i + 1] === '*') { depth++; i += 2; continue; }
                    if (expr[i] === '*' && expr[i + 1] === ')') { depth--; i += 2; continue; }
                    i++;
                }
                continue;
            }
            if (c === '[' || c === '(' || c === '{') {
                stack.push(c);
            } else if (c === ']' || c === ')' || c === '}') {
                var open = { ']': '[', ')': '(', '}': '{' }[c];
                if (stack.length === 0 || stack[stack.length - 1] !== open) {
                    return 'unmatched closing "' + c + '"';
                }
                stack.pop();
            }
            i++;
        }
        if (stack.length > 0) return 'unclosed "' + stack[stack.length - 1] + '"';
        return null;
    }

    function doAddWatch() {
        var name = addInput.value.trim();
        if (!name) return;
        var syntaxErr = validateWLSyntax(name);
        if (syntaxErr) {
            addInput.style.outline = '1px solid var(--vscode-inputValidation-errorBorder, #f14c4c)';
            addInput.title = 'Syntax error: ' + syntaxErr;
            return;
        }
        addInput.style.outline = '';
        addInput.title = '';
        vscode.postMessage({ command: 'addWatch', name: name });
        addInput.value = '';
        // Show pending row immediately
        emptyMsg.style.display = 'none';
        varTable.style.display = '';
        var tr     = document.createElement('tr');
        var tdName = document.createElement('td');
        tdName.textContent = name;
        var tdVal  = document.createElement('td');
        tdVal.className   = 'val';
        tdVal.textContent = '\u2026';
        var tdRm   = document.createElement('td');
        tdRm.className   = 'remove';
        tdRm.textContent = '\u00d7';
        tdRm.addEventListener('click', (function(n) {
            return function() { vscode.postMessage({ command: 'removeWatch', name: n }); };
        })(name));
        tr.appendChild(tdName);
        tr.appendChild(tdVal);
        tr.appendChild(tdRm);
        varBody.appendChild(tr);
    }
    addBtn.addEventListener('click', doAddWatch);
    addInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') doAddWatch(); });
    addInput.addEventListener('input', function() {
        addInput.style.outline = '';
        addInput.title = '';
    });

    // ── Debug control buttons ──────────────────────────────────────────────
    var dbgBtnMap = {
        'btn-stepOver': 'stepOver',
        'btn-stepInto': 'stepInto',
        'btn-stepOut':  'stepOut',
        'btn-continue': 'continue',
        'btn-runToEnd': 'runToEnd',
        // btn-stop is handled separately (dual start/stop mode)
    };
    Object.keys(dbgBtnMap).forEach(function(id) {
        var action = dbgBtnMap[id];
        var btn    = document.getElementById(id);
        if (btn) btn.addEventListener('click', function() {
            vscode.postMessage({ command: 'debugCommand', action: action });
        });
    });

    // Dual-mode start/stop button
    var stopBtn = document.getElementById('btn-stop');
    if (stopBtn) {
        stopBtn.addEventListener('click', function() {
            var action = stopBtn.dataset.mode === 'stop' ? 'stop' : 'startDebug';
            vscode.postMessage({ command: 'debugCommand', action: action });
        });
    }

    var bpSection = document.getElementById('bp-section');

    function setDebugging(active) {
        var btns = document.querySelectorAll('.dbg-btn');
        for (var i = 0; i < btns.length; i++) {
            var btn = btns[i];
            if (btn.id === 'btn-stop') continue;  // handled separately below
            if (active) btn.classList.add('on');
            else        btn.classList.remove('on');
        }
        // The start/stop button is always .on (clickable), just changes appearance
        var sb = document.getElementById('btn-stop');
        if (sb) {
            sb.classList.add('on');
            if (active) {
                sb.dataset.mode    = 'stop';
                sb.textContent     = '\u25a0';
                sb.title           = 'Stop (\u21e7F5)';
                sb.classList.add('stop-btn');
                sb.classList.remove('start-btn');
            } else {
                sb.dataset.mode    = 'start';
                sb.textContent     = '\u25b6 Debug';
                sb.title           = 'Debug Cell (Cmd+Shift+D)';
                sb.classList.remove('stop-btn');
                sb.classList.add('start-btn');
            }
        }
        // Show breakpoints section only during a debug session
        if (bpSection) bpSection.style.display = active ? '' : 'none';
    }

    // appendLog removed (log pane removed from panel UI)
    function appendLog(_msg) {}

    // ── Eval Selection section ─────────────────────────────────────────────
    var evalSelSection = document.getElementById('eval-sel-section');
    var evalSelFormat  = document.getElementById('eval-sel-format');
    var evalSelExpr    = document.getElementById('eval-sel-expr');
    var evalSelContent = document.getElementById('eval-sel-content');
    var evalSelClear   = document.getElementById('eval-sel-clear');
    var evalSelOpen    = document.getElementById('eval-sel-open');

    function escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function showEvalSel() { evalSelSection.style.display = ''; }
    function hideEvalSel() { evalSelSection.style.display = 'none'; }

    function setEvalSelExpr(expr) {
        var preview = String(expr || '');
        if (preview.length > 100) preview = preview.slice(0, 97) + '\u2026';
        evalSelExpr.textContent = preview;
    }

    if (evalSelClear) {
        evalSelClear.addEventListener('click', function() {
            hideEvalSel();
            vscode.postMessage({ command: 'evalSelClear' });
        });
    }

    if (evalSelOpen) {
        evalSelOpen.addEventListener('click', function() {
            vscode.postMessage({ command: 'openEvalSelFull' });
        });
    }

    // Click handler for "open full result" links generated by the large-output truncation
    if (evalSelContent) {
        evalSelContent.addEventListener('click', function(e) {
            var a = e.target && e.target.closest ? e.target.closest('a[data-open-file]') : null;
            if (a) {
                e.preventDefault();
                vscode.postMessage({ command: 'openFile', path: a.getAttribute('data-open-file') });
            }
        });
    }

    // ── Hover doc clear button ──────────────────────────────────────────────
    var hoverDocSection = document.getElementById('hover-doc-section');
    var hoverDocClear   = document.getElementById('hover-doc-clear');
    if (hoverDocClear) {
        hoverDocClear.addEventListener('click', function() {
            if (hoverDocSection) hoverDocSection.style.display = 'none';
            var c = document.getElementById('hover-doc-content');
            if (c) c.innerHTML = '';
        });
    }

    // Report panel width so the extension host can pass an accurate pageWidth
    // to lineBreakLatex.  The watch panel is narrower than the notebook editor.
    (function _initPanelWidthReporting() {
        function _reportWidth() {
            const el = document.body || document.documentElement;
            const w = el ? el.clientWidth : 0;
            if (w > 0) try { vscode.postMessage({ command: 'panelWidth', widthPx: w }); } catch (_) {}
        }
        _reportWidth();
        try {
            const _ro = new ResizeObserver(_reportWidth);
            _ro.observe(document.body || document.documentElement);
        } catch (_) {}
    })();

    vscode.postMessage({ command: 'scriptLoaded' });
})();
