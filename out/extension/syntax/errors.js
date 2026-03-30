"use strict";
// ---- Wolfbook: syntax error diagnostics and decorations ----
//
// Extracted from controller.js (Round 8 refactor).
// All methods receive `self` instead of `this` (their controller instance).

const vscode = require("vscode");

function handleSyntaxErrors(self, cell, errors) {
    const cellText    = cell.document.getText();
    const diagnostics = [];
    const ranges      = [];

    for (const error of errors) {
        let range;
        if (error.line !== undefined && error.column !== undefined) {
            const line   = Math.max(0, error.line - 1);
            const col    = Math.max(0, error.column - 1);
            range = new vscode.Range(
                new vscode.Position(line, col),
                new vscode.Position(line, col + 1)
            );
        } else if (error.character !== undefined) {
            const charPos = Math.max(0, Math.min(error.character, cellText.length));
            const pos     = cell.document.positionAt(charPos);
            range = new vscode.Range(pos, pos.translate(0, 1));
        } else {
            continue;
        }
        const diag = new vscode.Diagnostic(range, error.message || "Syntax error",
            vscode.DiagnosticSeverity.Error);
        diag.source = "Wolfram";
        diagnostics.push(diag);
        ranges.push(range);
    }

    // Do NOT register as VS Code diagnostics — that would pollute the Problems
    // panel and cause Copilot to prioritise these over real kernel runtime errors.
    // Visual-only: the pulsing red decoration is sufficient for the user.
    self.applySyntaxErrorDecorations(cell, ranges);
}

function applySyntaxErrorDecorations(self, cell, ranges) {
    if (ranges.length === 0) return;
    const cellKey = cell.document.uri.toString();
    self.cellDecorations.set(cellKey, ranges);
    const editor = vscode.window.visibleTextEditors.find(
        e => e.document.uri.toString() === cellKey
    );
    if (!editor) return;

    // Pulsing animation.
    // Stop when cellDecorations no longer has this key — this happens when
    // clearSyntaxErrorDecorations() is called (e.g. re-evaluate, abort, kernel
    // restart).  Also guard every setDecorations call with try/catch: if the
    // editor is disposed between pulses (e.g. the notebook cell was closed while
    // the idlesub syntax-check result came back), VS Code throws "Editor is not
    // a valid editor" which must not propagate as an uncaught timer exception.
    let pulseCount = 0;
    const pulse = () => {
        if (!self.cellDecorations.has(cellKey)) return; // cancelled
        if (pulseCount >= 6) {
            try { editor.setDecorations(self.syntaxErrorDecoration, ranges); } catch (_) {}
            return;
        }
        const dt = vscode.window.createTextEditorDecorationType({
            backgroundColor: pulseCount % 2 === 0 ? "rgba(255,0,0,0.5)" : "rgba(255,0,0,0.2)",
            border: "2px solid rgba(255,0,0,0.8)",
            borderRadius: "3px",
            isWholeLine: false,
        });
        try { editor.setDecorations(dt, ranges); } catch (_) {}
        pulseCount++;
        setTimeout(() => { dt.dispose(); pulse(); }, 200);
    };
    pulse();
}

function clearSyntaxErrorDecorations(self, cell) {
    const cellKey = cell.document.uri.toString();
    self.cellDecorations.delete(cellKey); // stops any running pulse() animation
    const editor = vscode.window.visibleTextEditors.find(
        e => e.document.uri.toString() === cellKey
    );
    if (editor) { try { editor.setDecorations(self.syntaxErrorDecoration, []); } catch (_) {} }
}

// ---- Runtime kernel-message line highlighting (pink/rose whole-line) ----

function applyRuntimeMsgDecoration(self, cell, startLine, endLine) {
    const cellKey = cell.document.uri.toString();
    const existing = self.runtimeMsgDecorationCells.get(cellKey) || [];
    const newRange  = new vscode.Range(
        new vscode.Position(Math.max(0, startLine), 0),
        new vscode.Position(Math.max(0, endLine),   0)
    );
    const merged = [...existing, newRange];
    self.runtimeMsgDecorationCells.set(cellKey, merged);
    const editor = vscode.window.visibleTextEditors.find(
        e => e.document.uri.toString() === cellKey
    );
    if (editor) editor.setDecorations(self.runtimeMsgDecoration, merged);
}

function clearRuntimeMsgDecoration(self, cell) {
    const cellKey = cell.document.uri.toString();
    self.runtimeMsgDecorationCells.delete(cellKey);
    const editor = vscode.window.visibleTextEditors.find(
        e => e.document.uri.toString() === cellKey
    );
    if (editor) editor.setDecorations(self.runtimeMsgDecoration, []);
}

module.exports = { handleSyntaxErrors, applySyntaxErrorDecorations, clearSyntaxErrorDecorations, applyRuntimeMsgDecoration, clearRuntimeMsgDecoration };
