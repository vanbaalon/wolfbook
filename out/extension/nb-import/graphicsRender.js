'use strict';
/**
 * graphicsRender.js — render the graphics boxes of an imported .nb to PNG files.
 *
 * A Mathematica notebook stores plots and pasted images as box expressions
 * (GraphicsBox / Graphics3DBox / RasterBox[CompressedData[...]]). Those cannot be
 * typeset as LaTeX, so they are rasterised by a Wolfram kernel into the same
 * `img/<notebook-name>/` folder the live kernel already writes into, and
 * referenced with the same <img> contract (see resources/render-expr.wl:413-439).
 *
 * Filenames are content-hashed, so the kernel runs only the first time a given
 * graphic is seen — reopening the notebook is instant and needs no kernel.
 *
 * vscode-free: the caller supplies the image directory.
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { findRunner } = require('./kernelAssist');

// The live kernel path uses 144 dpi (2x the 72 dpi Wolfram default) — matching it
// means our PNGs display at the same physical size as freshly evaluated ones.
const IMAGE_RESOLUTION = 144;
const DEVICE_SCALE = IMAGE_RESOLUTION / 72;

/** Deterministic file name for a graphics box — identical boxes reuse the file. */
function graphicsFileName(boxSource) {
    return 'nb_' + crypto.createHash('sha1').update(boxSource, 'utf8').digest('hex').slice(0, 12) + '.png';
}

// ---------------------------------------------------------------------------
// PNG header

/** Pixel size of a PNG, read from its IHDR chunk. Returns null if unreadable. */
function pngDimensions(fsPath) {
    let fd = null;
    try {
        const buf = Buffer.alloc(24);
        fd = fs.openSync(fsPath, 'r');
        if (fs.readSync(fd, buf, 0, 24, 0) < 24) return null;
        if (buf.readUInt32BE(0) !== 0x89504e47) return null;      // \x89PNG
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    } catch (_) {
        return null;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    }
}

/** Display size in CSS px: the raster is 2x, so halve it (as the paste-image
 *  command does in editor/commands.js). */
function displaySize(fsPath) {
    const d = pngDimensions(fsPath);
    if (!d) return null;
    return { w: Math.max(1, Math.round(d.w / DEVICE_SCALE)), h: Math.max(1, Math.round(d.h / DEVICE_SCALE)) };
}

// ---------------------------------------------------------------------------
// HTML / markdown fragments

function attrEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The <img> tag the live kernel emits. `data-wl-img` (absolute) is mandatory:
 * checkout.js's cleanupImgDir() deletes any png in the image folder that no
 * cell references through that attribute.
 */
function imgTag(absPath, relPath, size) {
    const dim = size ? ` width="${size.w}" height="${size.h}"` : '';
    return '<img class="vscode-wolfram-png-output" data-wl-img="' + attrEscape(absPath) +
           '" src="' + attrEscape(relPath) + '"' + dim + '/>';
}

/** A graphics cell output, in the same shape as nbModel's LaTeX outputs. */
function graphicsOutput(outN, absPath, relPath, size, id) {
    const html =
        '<span class="vscode-wolfram-gfx-marker" style="display:none;"></span>' +
        '<div class="wl-output-block">' +
        '<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;min-height:22px;" ' +
        'data-out-n="' + attrEscape(outN) + '" data-sub-idx="0" data-output-format="PNG" ' +
        'data-output-is-graphics="1">' +
        '<span style="font-size:10px;color:#888;margin-right:8px;">Out[' + attrEscape(outN) + ']=</span>' +
        '</div>' +
        '<div class="wl-output-content">' + imgTag(absPath, relPath, size) + '</div></div>';
    return {
        items: [
            { data: html, mime: 'x-application/wolfram-language-html' },
            { data: 'Out[' + outN + ']= (* graphics: ' + relPath + ' *)', mime: 'text/plain' },
        ],
        id: id || ('nbimport-gfx-' + outN),
    };
}

// ---------------------------------------------------------------------------
// The kernel-side script

const WL_SCRIPT = String.raw`
inFile = Environment["WB_GFX_IN"];
outFile = Environment["WB_GFX_OUT"];
payload = Quiet@Check[Import[inFile, "RawJSON"], $Failed];
If[payload === $Failed, Print["WBGFX_ERROR: cannot read payload"]; Exit[2]];

renderOne[entry_] := Module[{boxStr, target, boxes, res},
  boxStr = Lookup[entry, "boxSource", ""];
  target = Lookup[entry, "outPath", ""];
  If[boxStr === "" || target === "", Return[False]];
  boxes = Quiet@Check[ToExpression[boxStr, InputForm], $Failed];
  If[boxes === $Failed, Return[False]];
  (* RawBoxes renders the boxes as stored: no re-interpretation, so the TagBox
     and ImageTag wrappers around a RasterBox survive intact. *)
  res = Quiet@Check[Export[target, RawBoxes[boxes], "PNG",
          Background -> None, ImageResolution -> ${IMAGE_RESOLUTION}], $Failed];
  StringQ[res] && FileExistsQ[target]
];

results = Table[
  Module[{ok},
    ok = TimeConstrained[Quiet@Check[renderOne[entry], False], 90, False];
    <|"id" -> Lookup[entry, "id", -1], "ok" -> TrueQ[ok]|>
  ],
  {entry, Lookup[payload, "items", {}]}
];

stream = OpenWrite[outFile, CharacterEncoding -> "ASCII"];
WriteString[stream, ExportString[<|"results" -> results|>, "RawJSON", "Compact" -> True]];
Close[stream];
Print["WBGFX_OK"];
`;

function asciiJson(obj) {
    return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, c =>
        '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// ---------------------------------------------------------------------------

/**
 * Rasterise graphics boxes into `imgDir`.
 *
 * @param {Array<{id:string, boxSource:string, file:string}>} tasks
 * @param {object} opts { imgDir, timeoutMs = 300000, kernelPath, signal, onProgress }
 * @returns {Promise<{ok:boolean, unavailable?:boolean, error?:string,
 *                    rendered:Object<string,{absPath:string, size:{w,h}|null}>,
 *                    fromCache:number, kernelRan:boolean}>}
 */
async function renderGraphics(tasks, opts) {
    opts = opts || {};
    const imgDir = opts.imgDir;
    const rendered = Object.create(null);
    if (!Array.isArray(tasks) || !tasks.length || !imgDir) {
        return { ok: true, rendered, fromCache: 0, kernelRan: false };
    }

    try { fs.mkdirSync(imgDir, { recursive: true }); }
    catch (e) { return { ok: false, error: 'cannot create ' + imgDir + ': ' + e.message, rendered, fromCache: 0, kernelRan: false }; }

    // Content-hashed names mean an already-rendered graphic needs no kernel.
    const todo = [];
    let fromCache = 0;
    for (const t of tasks) {
        const absPath = path.join(imgDir, t.file);
        if (fs.existsSync(absPath)) {
            rendered[t.id] = { absPath, size: displaySize(absPath) };
            fromCache++;
        } else {
            todo.push({ id: t.id, boxSource: t.boxSource, outPath: absPath });
        }
    }
    if (!todo.length) return { ok: true, rendered, fromCache, kernelRan: false };

    const runner  = findRunner(opts.kernelPath);
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-nbgfx-'));
    const inFile  = path.join(tmpDir, 'payload.json');
    const outFile = path.join(tmpDir, 'result.json');
    const wlFile  = path.join(tmpDir, 'render.wls');
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };

    try {
        fs.writeFileSync(inFile, asciiJson({ items: todo }), 'ascii');
        fs.writeFileSync(wlFile, WL_SCRIPT, 'utf8');
    } catch (e) {
        cleanup();
        return { ok: false, error: 'could not stage temp files: ' + e.message, rendered, fromCache, kernelRan: false };
    }

    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(runner.cmd, runner.args.concat([wlFile]), {
                env: Object.assign({}, process.env, { WB_GFX_IN: inFile, WB_GFX_OUT: outFile }),
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (e) {
            cleanup();
            resolve({ ok: false, unavailable: true, error: String(e.message || e), rendered, fromCache, kernelRan: false });
            return;
        }

        let stderr = '', settled = false;
        const finish = (res) => { if (settled) return; settled = true; cleanup(); resolve(res); };

        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            collect();
            finish({ ok: false, error: 'kernel timed out', rendered, fromCache, kernelRan: true });
        }, opts.timeoutMs || 300000);

        if (opts.signal) {
            opts.signal.addEventListener?.('abort', () => {
                try { child.kill('SIGKILL'); } catch (_) {}
                clearTimeout(timer);
                collect();
                finish({ ok: false, error: 'cancelled', rendered, fromCache, kernelRan: true });
            }, { once: true });
        }

        // Believe the filesystem, not the report: a partial run still yields
        // every image that made it to disk.
        const collect = () => {
            for (const t of todo) {
                if (rendered[t.id]) continue;
                if (fs.existsSync(t.outPath)) rendered[t.id] = { absPath: t.outPath, size: displaySize(t.outPath) };
            }
        };

        child.stderr.on('data', d => { stderr += String(d); });
        child.on('error', (e) => {
            clearTimeout(timer);
            finish({ ok: false, unavailable: true, error: String(e.message || e), rendered, fromCache, kernelRan: false });
        });
        child.on('close', () => {
            clearTimeout(timer);
            collect();
            const missing = todo.length - Object.keys(rendered).length + fromCache;
            finish({
                ok: missing === 0,
                error: missing > 0 ? (missing + ' graphic(s) could not be rendered' +
                                      (stderr.trim() ? ': ' + stderr.trim().split('\n').pop() : '')) : undefined,
                rendered, fromCache, kernelRan: true,
            });
        });
    });
}

module.exports = {
    renderGraphics,
    graphicsFileName,
    graphicsOutput,
    imgTag,
    pngDimensions,
    displaySize,
    IMAGE_RESOLUTION,
};
