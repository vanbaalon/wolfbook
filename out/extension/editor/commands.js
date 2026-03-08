"use strict";
// ---- Wolfbook: editor commands (pasteImageAsCell, abortEvaluation, restartKernel, writeFileChecked) ----
//
// Extracted from controller.js (Round 7 refactor).
// All methods receive `self` instead of `this` (their controller instance).

const vscode     = require("vscode");
const path       = require("path");
const os         = require("os");
const fs         = require("fs");
const { writeFile } = require("fs");
const { scrollLog } = require('../utils/dev-logger');

async function pasteImageAsCell(self, args = {}) {
    self.outputPanel.print('[PasteImage] triggered, platform=' + process.platform);

    if (process.platform !== 'darwin') {
        vscode.window.showWarningMessage('Paste Image is currently supported on macOS only.');
        return;
    }

    // ---- Locate active notebook + currently selected cell ----
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) {
        self.outputPanel.print('[PasteImage] ERROR: no active notebook editor');
        vscode.window.showWarningMessage('No active notebook editor.');
        return;
    }
    const sel = editor.selections;
    if (!sel || sel.length === 0) {
        self.outputPanel.print('[PasteImage] ERROR: no cell selected');
        vscode.window.showWarningMessage('No cell selected.');
        return;
    }
    const cell = editor.notebook.cellAt(sel[0].start);
    self.outputPanel.print(`[PasteImage] active cell index=${cell.index}`);

    // ---- Extract clipboard image to a temp PNG via osascript ----
    // Tries PNG first; falls back to TIFF (macOS default for screenshots/
    // images copied from apps), then converts to PNG using sips.
    const { spawnSync } = require('child_process');
    const ts        = Date.now();
    const tmpPng    = path.join(os.tmpdir(), `wl_paste_${ts}.png`);
    const tmpTiff   = path.join(os.tmpdir(), `wl_paste_${ts}.tiff`);
    const tmpScript = path.join(os.tmpdir(), `wl_asc_${ts}.scpt`);
    const ascript = [
        // Try PNG first
        'set wroteFile to false',
        'try',
        `  set imgData to the clipboard as «class PNGf»`,
        `  set fRef to open for access POSIX file ${JSON.stringify(tmpPng)} with write permission`,
        '  write imgData to fRef',
        '  close access fRef',
        '  set wroteFile to true',
        'end try',
        // Fall back to TIFF if PNG not available
        'if not wroteFile then',
        '  try',
        `    set imgData to the clipboard as «class TIFF»`,
        `    set fRef to open for access POSIX file ${JSON.stringify(tmpTiff)} with write permission`,
        '    write imgData to fRef',
        '    close access fRef',
        '  on error errMsg',
        `    set fErr to open for access POSIX file "${tmpPng}.err" with write permission`,
        '    write errMsg to fErr',
        '    close access fErr',
        '  end try',
        'end if',
    ].join('\n');
    self.outputPanel.print(`[PasteImage] running osascript, tmpPng=${tmpPng}`);
    let spawnResult;
    try {
        fs.writeFileSync(tmpScript, ascript, 'utf8');
        spawnResult = spawnSync('osascript', [tmpScript], { timeout: 6000 });
    } catch (spawnErr) {
        self.outputPanel.print('[PasteImage] osascript spawn ERROR: ' + spawnErr.message);
    } finally {
        try { fs.unlinkSync(tmpScript); } catch(_) {}
    }
    if (spawnResult) {
        self.outputPanel.print(
            `[PasteImage] osascript exit=${spawnResult.status}` +
            (spawnResult.stderr ? ' stderr=' + spawnResult.stderr.toString().trim() : '')
        );
    }
    // Report AppleScript error if any
    const errFile = tmpPng + '.err';
    if (fs.existsSync(errFile)) {
        try {
            self.outputPanel.print('[PasteImage] AppleScript error: ' + fs.readFileSync(errFile, 'utf8').trim());
            fs.unlinkSync(errFile);
        } catch(_) {}
    }
    // Convert TIFF → PNG via sips (built into macOS) if we got a TIFF
    if (!fs.existsSync(tmpPng) && fs.existsSync(tmpTiff)) {
        self.outputPanel.print('[PasteImage] clipboard was TIFF — converting with sips');
        const sips = spawnSync('sips', ['--setProperty', 'format', 'png', tmpTiff, '--out', tmpPng], { timeout: 8000 });
        self.outputPanel.print(`[PasteImage] sips exit=${sips.status}` +
            (sips.stderr ? ' ' + sips.stderr.toString().trim() : ''));
        try { fs.unlinkSync(tmpTiff); } catch(_) {}
    }
    const pngExists = fs.existsSync(tmpPng);
    const pngSize   = pngExists ? fs.statSync(tmpPng).size : 0;
    self.outputPanel.print(`[PasteImage] tmpPng exists=${pngExists} size=${pngSize}`);

    if (!pngExists || pngSize === 0) {
        try { if (pngExists) fs.unlinkSync(tmpPng); } catch(_) {}
        self.outputPanel.print('[PasteImage] no PNG on clipboard — aborting');
        vscode.window.showWarningMessage(
            'No image found on clipboard — copy an image first, then press ⌘⇧V.'
        );
        return;
    }

    // ---- Ask above or below (skip dialog when called from between-cell toolbar) ----
    let insertAbove = false;
    if (!args.insertBelow) {
        // Brief delay so the cmd+shift+v keypress event settles before the
        // QuickPick opens — otherwise the residual kepress dismisses/accepts it instantly.
        await new Promise(resolve => setTimeout(resolve, 150));
        const choice = await vscode.window.showQuickPick(
            ['↑  Insert Above current cell', '↓  Insert Below current cell'],
            { title: 'Paste Image As Cell', placeHolder: 'Where should the image cell go?' }
        );
        if (!choice) {
            try { fs.unlinkSync(tmpPng); } catch(_) {}
            self.outputPanel.print('[PasteImage] user cancelled position dialog');
            return;
        }
        insertAbove = choice.startsWith('↑');
    }
    self.outputPanel.print(`[PasteImage] insertAbove=${insertAbove}`);

    // ---- Compute destination inside the notebook img/ folder ----
    const notebook  = editor.notebook;
    const nbFsPath  = notebook.uri.fsPath;
    const nbBase    = path.basename(nbFsPath, path.extname(nbFsPath));
    const imgDirAbs = path.join(path.dirname(nbFsPath), 'img', nbBase);
    const imgRel    = 'img/' + nbBase;
    const fname     = `paste_${Date.now()}.png`;
    const dstPath   = path.join(imgDirAbs, fname);
    self.outputPanel.print(`[PasteImage] dstPath=${dstPath}`);

    try { fs.mkdirSync(imgDirAbs, { recursive: true }); } catch(_) {}

    // ---- Convert / copy (Wolfram normalises format; plain copy as fallback) ----
    const status = vscode.window.setStatusBarMessage('⏳ Saving clipboard image…');
    try {
        if (self.session && self.kernelStatusString === 'resolved') {
            // Mathematica Import→Export: handles TIFF/BMP/EMF/etc. → PNG
            self.outputPanel.print('[PasteImage] kernel available — using Wolfram Export/Import');
            const wlSrc = self.escapeWL(tmpPng);
            const wlDst = self.escapeWL(dstPath);
            const exportResult = await self.session.sub(`Export["${wlDst}", Import["${wlSrc}"]]`);
            self.outputPanel.print('[PasteImage] Wolfram export result: ' + JSON.stringify(exportResult));
        } else {
            self.outputPanel.print('[PasteImage] kernel not running — using direct file copy');
        }
        if (!fs.existsSync(dstPath)) {
            self.outputPanel.print('[PasteImage] dst missing after Export — falling back to fs.copy');
            fs.copyFileSync(tmpPng, dstPath);
        }
    } catch (saveErr) {
        self.outputPanel.print('[PasteImage] save ERROR: ' + saveErr.message + ' — falling back to fs.copy');
        try { fs.copyFileSync(tmpPng, dstPath); } catch(copyErr) {
            self.outputPanel.print('[PasteImage] fs.copy also failed: ' + copyErr.message);
        }
    } finally {
        status.dispose();
        try { fs.unlinkSync(tmpPng); } catch(_) {}
    }

    if (!fs.existsSync(dstPath)) {
        self.outputPanel.print('[PasteImage] ERROR: dstPath not created');
        vscode.window.showErrorMessage('Failed to save pasted image.');
        return;
    }
    self.outputPanel.print(`[PasteImage] image saved OK (${fs.statSync(dstPath).size} bytes)`);

    // ---- Read PNG dimensions from header (bytes 16-23) to set explicit half-width ----
    let widthAttr = '';
    try {
        const hdr = Buffer.alloc(24);
        const fd  = fs.openSync(dstPath, 'r');
        fs.readSync(fd, hdr, 0, 24, 0);
        fs.closeSync(fd);
        const pxWidth = hdr.readUInt32BE(16);
        widthAttr = ` width="${Math.round(pxWidth / 2)}"`;
        self.outputPanel.print(`[PasteImage] PNG width=${pxWidth}px → display ${Math.round(pxWidth / 2)}px`);
    } catch (e) {
        self.outputPanel.print('[PasteImage] could not read PNG dimensions: ' + e.message);
    }

    // ---- Insert a Markdown cell with the image ----
    const cellData  = new vscode.NotebookCellData(
        vscode.NotebookCellKind.Markup,
        `<img src="${imgRel}/${fname}"${widthAttr} alt="pasted image"/>`,
        'markdown'
    );
    const insertIdx = insertAbove ? cell.index : cell.index + 1;
    self.outputPanel.print(`[PasteImage] inserting Markdown cell at index ${insertIdx}`);
    const edit      = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertIdx, [cellData])]);
    await vscode.workspace.applyEdit(edit);
    self.outputPanel.print('[PasteImage] done ✓');
}

function abortEvaluation(self) {
    // Dynamic cell loops are NOT killed on abort — they stay alive and naturally
    // transition to "paused" state once busy becomes false after the abort.

    if (self.isAborting || self._abortPending) return;
    if (!self.session) { self.executionQueue.clear(); return; }

    // Signal widget loops to skip their current dialog cycle immediately.
    self._abortPending = true;

    // Queue the actual kernel abort AFTER the current dialog mutex is released.
    // This ensures we never call session.abort() mid-dialogEval, which confuses
    // the WSTP link and prevents the aborted packet from ever arriving.
    // Hard 2s fallback: if the dialog cycle takes longer, abort fires anyway.
    const prevMutex = self._dynDialogMutex;
    let _releaseMutexAbort;
    self._dynDialogMutex = new Promise(r => _releaseMutexAbort = r);

    const doAbort = () => {
        self._abortPending = false;
        self._evalDispatched = false;
        self._cellEpoch     = ((self._cellEpoch || 0) + 1) & 0xFFFFFF;
        self._dispatchEpoch = (self._dispatchEpoch + 1) & 0xFFFFFF;
        _releaseMutexAbort(); // restore the mutex chain for future widget cycles

        // Reset idle-sub mutex so any checkoutExecutionQueue waiting on it
        // can proceed immediately after abort — don't wait for 3s sub() timeout.
        self._dynIdleMutex = Promise.resolve();

        // Always close any stale dialog state before abort — closeAllDialogs()
        // rejects all pending dialogEval/exitDialog promises immediately,
        // so they don't hang while the kernel processes the abort.
        self.session.closeAllDialogs?.();

        const didAbort = self.session.abort();
        scrollLog('[abort] session.abort() =>', didAbort);

        if (!didAbort) {
            self.executionQueue.clear();
            return;
        }

        // Only set isAborting if the checkout loop is still alive to receive
        // the aborted packet. If execution already finished (queue empty or
        // not started), skip it — there's nothing to clear it, and isAborting
        // would block all future evaluations.
        const hasActiveCheckout = self.executionQueue.queue.length > 0 &&
                                  self.executionQueue.queue[0].started;
        self.executionQueue.clear();

        if (!hasActiveCheckout) {
            scrollLog('[abort] no active checkout — not setting isAborting');
            return;
        }

        self.isAborting = true;
        // Safety net: force-clear after 1s in case the aborted packet
        // arrives but no handler processes it (timing edge case).
        setTimeout(() => {
            if (self.isAborting) {
                scrollLog('[abort] safety timeout: forcing isAborting = false after 1s');
                self.isAborting = false;
            }
        }, 1000);
    };

    // Wait for widget loop to release the mutex (max 2s), then abort.
    Promise.race([
        prevMutex,
        new Promise(r => setTimeout(r, 2000))
    ]).then(doAbort);
}

function restartKernel(self) {
    self.writeDebugLog("[RESTART] restartKernel called");
    if (self.isAborting) {
        self.writeDebugLog("[RESTART] overriding in-progress abort");
    }
    self.isAborting = false;
    self.executionQueue.clear();

    const hadKernel = !!self.session;
    self.quitKernel();

    if (hadKernel || true) {
        setTimeout(() => {
            self.launchKernel().catch(err => {
                vscode.window.showErrorMessage(`Failed to restart kernel: ${err.message}`);
            });
        }, 300);
    }
}

function writeFileChecked(self, filePath, text) {
    writeFile(filePath, text, err => {
        if (!err) return;
        vscode.window.showErrorMessage(
            `Unable to write file ${filePath}\n${err.message}`, "Retry", "Save As…", "Dismiss"
        ).then(value => {
            if (value === "Retry") self.writeFileChecked(filePath, text);
            else if (value === "Save As…") {
                vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(filePath),
                    filters: { "All Files": ["*"] }
                }).then(uri => { if (uri) self.writeFileChecked(uri.fsPath, text); });
            }
        });
    });
}

module.exports = { pasteImageAsCell, abortEvaluation, restartKernel, writeFileChecked };
