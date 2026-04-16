// askSpecialistPanel.webview.js — Runs inside the VS Code webview (NOT in Node.js).
// Loaded via webview.asWebviewUri() so CSP allows it without nonce issues.
(function () {
    'use strict';
    const vscode        = acquireVsCodeApi();
    const standby       = document.getElementById('standby');
    const questionArea  = document.getElementById('question-area');
    const questionHtml  = document.getElementById('question-html');
    const replyInput    = document.getElementById('reply-input');
    const submitBtn     = document.getElementById('submit-btn');
    const dismissBtn    = document.getElementById('dismiss-btn');
    const blinkWrapper  = document.getElementById('blink-wrapper');

    let blinkInterval = null;
    let blinkActive   = false;

    // ── Attention: blinking background ─────────────────────────────────────
    // CSS class `blink-on` is toggled every 600 ms. The CSS defines it as an
    // accent background. We use JS toggle instead of CSS animation so it stops
    // immediately on dismiss without needing animation-play-state hacks.
    function startBlink() {
        if (blinkInterval) return;
        blinkActive = true;
        blinkInterval = setInterval(() => {
            blinkWrapper.classList.toggle('blink-on');
        }, 600);
    }

    function stopBlink() {
        blinkActive = false;
        if (blinkInterval) {
            clearInterval(blinkInterval);
            blinkInterval = null;
        }
        blinkWrapper.classList.remove('blink-on');
    }

    // ── Sound: brief attention beep via Web Audio API ─────────────────────
    function playBeep() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Two short beeps: 880 Hz then 1100 Hz
            function beep(freq, startTime, duration) {
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.setValueAtTime(freq, startTime);
                gain.gain.setValueAtTime(0.25, startTime);
                gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
                osc.start(startTime);
                osc.stop(startTime + duration);
            }
            beep(880,  ctx.currentTime,        0.18);
            beep(1100, ctx.currentTime + 0.22, 0.18);
        } catch (_) { /* AudioContext not available — silently skip */ }
    }

    // ── Show question ───────────────────────────────────────────────────────
    function showQuestion(html) {
        questionHtml.innerHTML = html;
        standby.style.display      = 'none';
        questionArea.style.display = 'block';
        replyInput.value           = '';
        replyInput.focus();
        startBlink();
        playBeep();
    }

    // ── Hide / clear state ─────────────────────────────────────────────────
    function clearPanel() {
        stopBlink();
        questionHtml.innerHTML     = '';
        replyInput.value           = '';
        standby.style.display      = 'block';
        questionArea.style.display = 'none';
    }

    // ── Submit ──────────────────────────────────────────────────────────────
    function submitReply() {
        const text = replyInput.value.trim();
        stopBlink();
        vscode.postMessage({ command: 'reply', text });
        clearPanel();
    }

    // ── Dismiss ─────────────────────────────────────────────────────────────
    function dismissPanel() {
        stopBlink();
        vscode.postMessage({ command: 'dismiss' });
        clearPanel();
    }

    submitBtn.addEventListener('click', submitReply);
    dismissBtn.addEventListener('click', dismissPanel);

    // Ctrl+Enter / Cmd+Enter to submit
    replyInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submitReply();
        }
    });

    // ── Messages from extension ─────────────────────────────────────────────
    window.addEventListener('message', function (event) {
        const msg = event.data;
        if (msg.command === 'ask') {
            showQuestion(msg.html);
        } else if (msg.command === 'clear') {
            clearPanel();
        }
    });
}());
