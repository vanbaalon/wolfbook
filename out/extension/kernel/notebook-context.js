'use strict';

// A notebook's own evaluation context — Wolfbook's counterpart of Mathematica's
// Evaluation ▸ Notebook's Default Context (CellContext).
//
// The setting lives in the .wb file (`metadata.wolframSettings.context`) so it
// travels with the notebook, exactly as CellContext does in a .nb:
//
//   absent / "Global"   shared Global` context (the default)
//   "Notebook"          a context unique to this notebook, derived from its path
//   "Name`"             an explicit context; notebooks naming the same one share it
//
// The checkout loop ENTERS the context before a cell and LEAVES it afterwards, so
// the kernel sits in Global` between cells and every other caller (MCP
// evaluateExpression, the Watch panel, other notebooks on the same kernel) is
// unaffected. Global` stays LAST on the notebook's $ContextPath: the extension
// calls VsCodeRender / VsCodeSetImgDir / … by bare name and those live in
// Global`. The consequence, identical to Mathematica's, is that a name which
// already exists in Global` still resolves there.
//
// vscode-free so it can be unit-tested.

const crypto = require('crypto');
const path = require('path');

const MODE_GLOBAL = 'Global';
const MODE_NOTEBOOK = 'Notebook';
const CONTEXT_RE = /^[A-Za-z$][A-Za-z0-9$]*`(?:[A-Za-z$][A-Za-z0-9$]*`)*$/;

/** Canonical setting value, or null when the value is not a valid setting. */
function normalizeContextSetting(value) {
    if (value === undefined || value === null) return MODE_GLOBAL;
    const raw = String(value).trim();
    if (!raw) return MODE_GLOBAL;
    const lower = raw.toLowerCase();
    if (lower === 'global' || raw === 'Global`' || lower === 'shared' || lower === 'none') return MODE_GLOBAL;
    if (lower === 'notebook' || lower === 'unique' || lower === 'isolated') return MODE_NOTEBOOK;
    const ctx = raw.endsWith('`') ? raw : `${raw}\``;
    if (!CONTEXT_RE.test(ctx)) return null;
    if (ctx === 'Global`') return MODE_GLOBAL;
    // Evaluating a notebook inside System` or Wolfbook's own contexts would let
    // it redefine the kernel or the extension's helpers.
    if (/^(System|Wolfbook|Internal|Developer)`/.test(ctx)) return null;
    return ctx;
}

/** The unique context for a notebook path: Notebook$<8 hex>` */
function uniqueContextFor(notebookPath) {
    let key = path.normalize(String(notebookPath || '')).replace(/[\\/]+$/, '');
    if (process.platform === 'win32') key = key.toLowerCase();
    return `Notebook$${crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)}\``;
}

/** The context a notebook evaluates in, or null for the shared Global` context. */
function resolveNotebookContext(notebook) {
    const setting = normalizeContextSetting(notebook?.metadata?.wolframSettings?.context);
    if (!setting || setting === MODE_GLOBAL) return null;
    if (setting === MODE_NOTEBOOK) return uniqueContextFor(notebook?.uri?.fsPath || notebook?.uri?.path || '');
    return setting;
}

function _wlString(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

// Only System` symbols and fully-qualified Wolfbook`Private` ones appear below:
// this code is itself parsed in whatever $Context the kernel is in, so any bare
// helper name (a With/Module variable, say) would be interned into Global`.
function enterContextCode(ctx) {
    const c = _wlString(ctx);
    return 'Quiet[' +
        'If[!MatchQ[Wolfbook`Private`$wbNbCtxOuter, {_String, {___String}}], ' +
            'Wolfbook`Private`$wbNbCtxOuter = {$Context, $ContextPath}]; ' +
        `$Context = ${c}; ` +
        `$ContextPath = If[MatchQ[Wolfbook\`Private\`$wbNbCtxPath[${c}], {___String}], ` +
            `Wolfbook\`Private\`$wbNbCtxPath[${c}], ` +
            `Join[{${c}}, DeleteCases[Last[Wolfbook\`Private\`$wbNbCtxOuter], ${c} | "Global\`"], {"Global\`"}]]; ` +
        'Null]';
}

// Remembers the notebook's $ContextPath (a Needs[] in that notebook stays in
// that notebook) and puts back exactly what was there before the cell.
function leaveContextCode(ctx) {
    const c = _wlString(ctx);
    return 'Quiet[' +
        `If[$Context === ${c}, Wolfbook\`Private\`$wbNbCtxPath[${c}] = $ContextPath]; ` +
        'If[MatchQ[Wolfbook`Private`$wbNbCtxOuter, {_String, {___String}}], ' +
            '{$Context, $ContextPath} = Wolfbook`Private`$wbNbCtxOuter, ' +
            '$Context = "Global`"]; ' +
        'Wolfbook`Private`$wbNbCtxOuter = Null; ' +
        'Null]';
}

function describeContextSetting(setting, notebookPath) {
    const s = normalizeContextSetting(setting);
    if (!s || s === MODE_GLOBAL) return 'Global` (shared)';
    if (s === MODE_NOTEBOOK) return `${uniqueContextFor(notebookPath)} (unique to this notebook)`;
    return s;
}

module.exports = {
    MODE_GLOBAL, MODE_NOTEBOOK,
    normalizeContextSetting, uniqueContextFor, resolveNotebookContext,
    enterContextCode, leaveContextCode, describeContextSetting,
};
