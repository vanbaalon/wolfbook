// texCompute.js — running a managed computation for a paper.
//
// The kernel-facing half of the feature. What a block MEANS is mmaBlocks, how
// it is SPELLED is mmaWrite, and what happens when you press Run is here.
//
// Three things this owns, each of which the .wslide path gets wrong in a way
// that matters more for a paper than for a slide:
//
//  1. A REAL LEASE. Slides call session.evaluate directly with only an
//     _evalDispatched check, so two evaluations can overlap. Here the kernel is
//     acquired through the arbiter and released in a finally, which is what
//     stops a paper computation from interleaving with a notebook's.
//  2. A REAL PAGE WIDTH. See widthFor() below.
//  3. A KERNEL CHOSEN PER PAPER. KernelManager keys its bindings by fsPath and
//     normalises them through canonicalNotebook, so a .tex path works with no
//     change to the manager at all — a paper picks its kernel exactly the way a
//     notebook does, and the choice survives a reload.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const evalFragment = require('../execution/eval-fragment');
const { acquireKernelForAgent, releaseKernelForAgent, trackedKernelEvaluate } = require('../tools/shared');

// A one-column article at 10pt has \textwidth = 345pt and 1em = 10pt, so its
// LaTeX should break at 35 em — less than half the notebook default of 80.
// Getting this wrong is not cosmetic: the equation runs into the margin.
const FALLBACK_TEXT_WIDTH_PT = 345;
const FALLBACK_EM_PT = 10;

class TexComputeService {
    /**
     * @param {{resolveController?: Function, kernelManager?: object}} deps
     *
     * Both are optional. registerTexSupport is called from extension.js with
     * them and from the headless tests without, and a paper viewer that cannot
     * compute must still open, fold, search and edit — so the absence of a
     * kernel is reported when someone presses Run, not by refusing to load.
     */
    constructor(deps = {}) {
        this._resolveController = deps.resolveController || null;
        this._kernelManager = deps.kernelManager || (deps.resolveController && deps.resolveController.manager) || null;
    }

    available() { return !!this._resolveController; }

    /** The honest sentence to show when Run is pressed and there is no kernel. */
    unavailableReason() {
        return 'This window has no Wolfram kernel available to the paper viewer.';
    }

    // -----------------------------------------------------------------------
    // Kernels
    // -----------------------------------------------------------------------

    /**
     * The kernels this paper could run on, and the one it is bound to.
     * Shaped for a <select> in the card header.
     */
    kernelsFor(texPath) {
        const mgr = this._kernelManager;
        if (!mgr) return { kernels: [], boundId: null };
        let list = [];
        try { list = mgr.list([]) || []; } catch (_) { list = []; }
        let boundId = null;
        try { boundId = mgr.bindingFor(texPath)?.id || null; } catch (_) { boundId = null; }
        return {
            kernels: list.map(k => ({
                id: k.kernel_id,
                label: k.kernel_label || k.kernel_id,
                isDefault: !!k.is_default,
                busy: !!k.busy,
                lifecycle: k.lifecycle || 'offline',
                remote: !!k.remote,
            })),
            boundId,
        };
    }

    async bindKernel(texPath, kernelId) {
        if (!this._kernelManager) throw new Error('no kernel manager');
        return this._kernelManager.bind(texPath, kernelId);
    }

    // -----------------------------------------------------------------------
    // Width
    // -----------------------------------------------------------------------

    /**
     * How wide the LaTeX may be, in em.
     *
     * A LADDER, most-trustworthy first, because every rung can be absent:
     *   1. the user said so outright;
     *   2. the compile measured \textwidth and the current font's em (Stage D);
     *   3. the render told us how wide the printed prose actually is;
     *   4. a one-column article at 10pt.
     *
     * Rung 4 is a real number rather than the notebook's 80 precisely so that a
     * missing measurement is wrong by a little instead of by a factor of two.
     */
    widthFor(opts = {}) {
        const cfg = vscode.workspace.getConfiguration('wolfbook');
        const declared = Number(cfg.get('tex.textWidthPt') ?? 0);
        const emPt = Number(opts.emPt) > 0 ? Number(opts.emPt) : FALLBACK_EM_PT;
        if (declared > 0) return { em: Math.max(10, Math.round(declared / emPt)), source: 'setting' };
        if (Number(opts.textWidthPt) > 0) {
            return { em: Math.max(10, Math.round(Number(opts.textWidthPt) / emPt)), source: 'measured' };
        }
        if (Number(opts.inkWidthBp) > 0) {
            // Printed ink is measured in big points, which are the same unit as
            // TeX points to within 0.4% — far below the resolution of a line
            // break decision, so no conversion is worth the confusion.
            return { em: Math.max(10, Math.round(Number(opts.inkWidthBp) / emPt)), source: 'ink' };
        }
        return { em: Math.round(FALLBACK_TEXT_WIDTH_PT / FALLBACK_EM_PT), source: 'default' };
    }

    // -----------------------------------------------------------------------
    // Running
    // -----------------------------------------------------------------------

    /**
     * Evaluate one cell's source.
     *
     * @returns {{result: object} | {busy: object} | {error: string}}
     *
     * A busy kernel is REPORTED, never preempted. Someone else's evaluation is
     * running and interrupting it to draw a figure would be the wrong trade;
     * the caller shows what is running and offers a retry.
     */
    async run(texPath, code, opts = {}) {
        if (!this._resolveController) return { error: this.unavailableReason() };
        let ctrl;
        try {
            ctrl = this._resolveController({ notebook: texPath, kernel_id: opts.kernelId || undefined });
        } catch (e) {
            return { error: e && e.message ? e.message : String(e) };
        }
        if (!ctrl || !ctrl.session) {
            return { error: 'No Wolfram kernel is running. Start one and try again.' };
        }

        const timeoutSeconds = Math.max(1, Math.floor(Number(opts.timeoutSeconds ?? 60)));
        let lease = null;
        try {
            const claim = await acquireKernelForAgent(ctrl, {
                owner: 'wpaper',
                kind: 'paper-computation',
                caption: `WPaper: ${path.basename(texPath || 'paper.tex')}`,
                policy: 'reject',
            });
            if (!claim.lease) {
                return { busy: claim.busy || { message: 'The kernel is busy.' } };
            }
            lease = claim.lease;

            const expr = evalFragment.buildEvalExpr(code, {
                timeoutSeconds,
                imageWidthPx: Math.max(50, Math.floor(Number(opts.imageWidthPx ?? 600))),
                prefer: opts.prefer === 'figure' ? 'figure' : 'auto',
                // A paper needs a PDF; only the card's preview needs the SVG.
                wantPdf: true,
            });
            // The kernel's own TimeConstrained is the real bound; this race only
            // stops the UI hanging if the transport itself never answers.
            const started = Date.now();
            const raced = await Promise.race([
                trackedKernelEvaluate(ctrl, expr, { interactive: false }),
                new Promise((_, rej) => setTimeout(
                    () => rej(new Error(`the kernel did not answer within ${timeoutSeconds + 10}s`)),
                    (timeoutSeconds + 10) * 1000)),
            ]);
            const raw = (raced?.result?.type === 'string' && raced.result.value)
                ? raced.result.value
                : String(raced?.result ?? '');
            const result = evalFragment.parseEvalResult(raw, {
                pageWidthEm: Number(opts.pageWidthEm) > 0 ? Number(opts.pageWidthEm) : undefined,
                katex: opts.katex !== false,
            });
            result.ms = Date.now() - started;
            return { result };
        } catch (e) {
            return { error: e && e.message ? e.message : String(e) };
        } finally {
            try { releaseKernelForAgent(ctrl, lease); } catch (_) {}
        }
    }

    // -----------------------------------------------------------------------
    // Assets
    // -----------------------------------------------------------------------

    /**
     * Write a figure beside the paper and return the path LaTeX should use.
     *
     * CONTENT-HASHED, mirroring texPaste.imagePathFor: the same picture written
     * twice is one file, and — the reason it matters here — recomputing a cell
     * whose result has not changed produces the identical filename, so the
     * output fence it goes into is byte-identical too. "Delete the output,
     * recompute, get the same bytes back" falls out of the naming scheme rather
     * than having to be arranged.
     *
     * @param {string} texPath
     * @param {{base64?: string, text?: string, ext: string}} asset
     * @returns {{rel: string, abs: string}}
     */
    writeAsset(texPath, asset) {
        const bytes = asset.base64
            ? Buffer.from(asset.base64, 'base64')
            : Buffer.from(String(asset.text ?? ''), 'utf8');
        const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12);
        const ext = String(asset.ext || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        const base = path.basename(texPath || 'paper.tex').replace(/\.tex$/i, '') || 'paper';
        const dir = path.join(path.dirname(texPath || '.'), 'img', base);
        const file = `wl_${hash}.${ext}`;
        const abs = path.join(dir, file);
        if (!fs.existsSync(abs)) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(abs, bytes);
        }
        // FORWARD SLASHES ALWAYS — a backslash in \includegraphics is an escape
        // character to TeX, whatever platform wrote the file.
        return { rel: ['img', base, file].join('/'), abs };
    }
}

module.exports = { TexComputeService, FALLBACK_TEXT_WIDTH_PT, FALLBACK_EM_PT };
