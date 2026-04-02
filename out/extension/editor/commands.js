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
    const _abortT0 = Date.now();
    self.writeDebugLog(`[ABORT] abortEvaluation called | isAborting=${self.isAborting} _abortPending=${self._abortPending} queueLen=${self.executionQueue.queueLength()}`);

    if (self.isAborting || self._abortPending) {
        self.writeDebugLog(`[ABORT] already isAborting=${self.isAborting} _abortPending=${self._abortPending} — force-reset to non-evaluating state`);
        // Force-reset: the first abort may have failed (dead link, etc.).
        // Always bring VS Code back to non-evaluating state on second press.
        self.isAborting     = false;
        self._abortPending  = false;
        self._evalDispatched = false;
        self._interruptHandlerInstalled = false;
        self.executionQueue.clear();
        scrollLog('[abort] force-reset on second abort press');
        return;
    }
    if (!self.session) {
        self.writeDebugLog('[ABORT] no session — just clearing queue');
        self.executionQueue.clear();
        return;
    }

    // Signal widget loops to skip their current dialog cycle immediately.
    self._abortPending = true;

    const doAbort = () => {
        self.writeDebugLog(`[ABORT] doAbort fired | dt=${Date.now()-_abortT0}ms | queueLen=${self.executionQueue.queueLength()} | started=${self.executionQueue.queue[0]?.started}`);
        self._abortPending = false;
        self._evalDispatched = false;
        self._interruptHandlerInstalled = false;
        self._cellEpoch     = ((self._cellEpoch || 0) + 1) & 0xFFFFFF;
        self._dispatchEpoch = (self._dispatchEpoch + 1) & 0xFFFFFF;
        // Reset any other flags that can get stuck
        self._refineGuardActive   = false;
        self._dialogPrintCollector = null;

        // Always close any stale dialog state before abort — closeAllDialogs()
        // rejects all pending dialogEval/exitDialog promises immediately.
        self.session.closeAllDialogs?.();

        const didAbort = self.session.abort();
        self.writeDebugLog(`[ABORT] session.abort() => ${didAbort} | dt=${Date.now()-_abortT0}ms`);
        scrollLog('[abort] session.abort() =>', didAbort);

        if (!didAbort) {
            self.writeDebugLog('[ABORT] didAbort=false — clearing queue without setting isAborting');
            self.executionQueue.clear();
            return;
        }

        // Only set isAborting if the checkout loop is still alive to receive
        // the aborted packet. If execution already finished (queue empty or
        // not started), skip it — there's nothing to clear it, and isAborting
        // would block all future evaluations.
        const hasActiveCheckout = self.executionQueue.queue.length > 0 &&
                                  self.executionQueue.queue[0].started;
        self.writeDebugLog(`[ABORT] hasActiveCheckout=${hasActiveCheckout} | queueLen=${self.executionQueue.queueLength()}`);
        self.executionQueue.clear();

        if (!hasActiveCheckout) {
            self.writeDebugLog('[ABORT] no active checkout — not setting isAborting, done');
            scrollLog('[abort] no active checkout — not setting isAborting');
            return;
        }

        self.isAborting = true;
        self.writeDebugLog('[ABORT] isAborting = true — waiting for aborted packet from kernel');

        // If the first SIGINT is ignored (kernel in a CheckAbort-less region),
        // retry 3 more times at increasing intervals before giving up.
        // Do NOT auto-restart — that loses all variables.  Instead, show a
        // warning so the user can decide whether to restart manually.
        const _retryDelays = [2000, 5000, 10000];
        let _retryIdx = 0;
        const _scheduleRetry = () => {
            if (_retryIdx >= _retryDelays.length) {
                // Retries exhausted — kernel is not responding to SIGINT at all.
                // Clear isAborting so future evaluations aren't permanently blocked,
                // but leave the stuck evaluate() in place (kernel may still finish).
                if (self.isAborting) {
                    self.isAborting = false;
                    self.writeDebugLog('[ABORT] all retries exhausted — kernel not responding to abort. Cleared isAborting. User must restart manually if needed.');
                    scrollLog('[abort] all retries exhausted — kernel not responding');
                    vscode.window.showWarningMessage(
                        'Kernel is not responding to abort (computation may be in a non-interruptible loop). ' +
                        'Either wait for it to finish, or restart the kernel.',
                        'Restart Kernel'
                    ).then(choice => {
                        if (choice === 'Restart Kernel') self.restartKernel();
                    });
                }
                return;
            }
            const delay = _retryDelays[_retryIdx++];
            setTimeout(() => {
                if (!self.isAborting) return; // abort was already handled — done
                if (!self.session) return;
                self.writeDebugLog(`[ABORT] retry ${_retryIdx}/${_retryDelays.length} — sending another SIGINT | dt=${Date.now()-_abortT0}ms`);
                scrollLog(`[abort] retry ${_retryIdx} — sending another SIGINT`);
                self.session.abort();
                _scheduleRetry();
            }, delay);
        };
        _scheduleRetry();
    };

    self.writeDebugLog('[ABORT] firing doAbort');
    doAbort();
}

function restartKernel(self) {
    const _rstT0 = Date.now();
    self.writeDebugLog(`[RESTART] restartKernel called | isAborting=${self.isAborting} _abortPending=${self._abortPending} queueLen=${self.executionQueue.queueLength()} session=${!!self.session}`);
    if (self.isAborting) {
        self.writeDebugLog('[RESTART] overriding in-progress abort');
    }
    // Reset ALL controller-level flags to defaults
    self._abortPending          = false;
    self.isAborting              = false;
    self._evalDispatched         = false;
    self._interruptHandlerInstalled = false;
    self._lastMainImgDir         = null;
    self._lastMainImgRel         = null;
    self._refineGuardActive     = false;
    self._dialogPrintCollector  = null;
    self._cellEpoch             = ((self._cellEpoch || 0) + 1) & 0xFFFFFF;
    self._dispatchEpoch         = (self._dispatchEpoch + 1) & 0xFFFFFF;
    self.executionQueue.clear();
    self.writeDebugLog(`[RESTART] all flags reset, queue cleared | dt=${Date.now()-_rstT0}ms`);

    const hadKernel = !!self.session;
    self.quitKernel();
    self.writeDebugLog(`[RESTART] quitKernel done | hadKernel=${hadKernel} | dt=${Date.now()-_rstT0}ms`);

    if (hadKernel || true) {
        setTimeout(() => {
            self.writeDebugLog(`[RESTART] launching new kernel | dt=${Date.now()-_rstT0}ms`);
            self.launchKernel().then(() => {
                self.writeDebugLog(`[RESTART] launchKernel resolved OK | total dt=${Date.now()-_rstT0}ms`);
            }).catch(err => {
                self.writeDebugLog(`[RESTART] launchKernel FAILED: ${err.message}`);
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
