'use strict';
// ---------------------------------------------------------------------------
// MCP tool annotations (protocol 2025-03-26+): hints a client uses to decide
// whether to ask before a call. They are hints, never a security boundary.
//
// Every tool has an explicit class here — stability-tool-catalogue fails when
// a package.json tool (or a synthetic one) is missing, so a new tool cannot
// silently inherit the spec defaults (destructive + open-world).
//
// Classes:
//   R   read-only, local                 — reads notebooks, decks, papers, state
//   RW  read-only, reaches the internet  — literature / paper search
//   A   changes things, only additively  — inserts, creates, saves, routing
//   AW  additive, reaches the internet   — agent runs, SkilXiv, specialists
//   D   destructive: overwrites/deletes  — edits, deletes, restarts, reloads
//   X   runs arbitrary Wolfram code      — a kernel can do anything, network included
// ---------------------------------------------------------------------------

const CLASSES = {
    R:  { readOnlyHint: true,  destructiveHint: false, openWorldHint: false },
    RW: { readOnlyHint: true,  destructiveHint: false, openWorldHint: true },
    A:  { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    AW: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    D:  { readOnlyHint: false, destructiveHint: true,  openWorldHint: false },
    X:  { readOnlyHint: false, destructiveHint: true,  openWorldHint: true },
};

const TOOL_CLASS = {
    // ── notebooks: reading ───────────────────────────────────────────────
    wolfbook_getNotebookContext: 'R', wolfbook_readNotebookFile: 'R', wolfbook_searchCells: 'R', wolfbook_getCellOutput: 'R',
    wolfbook_lookupSymbol: 'R', wolfbook_showImage: 'R', wolfbook_validateSyntax: 'R',
    wolfbook_status: 'R', wolfbook_kernelStatus: 'R', wolfbook_list_clients: 'R',
    wolfbook_operationStatus: 'R', wolfbook_waitEvaluation: 'R', wolfbook_getResult: 'R',
    wolfbook_evaluationJournal: 'R', wolfbook_journalDigest: 'R', wolfbook_kernelCrashLog: 'R',
    wolfbook_findPackage: 'R', wolfbook_fairy_status: 'R', wolfbook_gold_status: 'R',
    // inspectSymbols EVALUATES (Names/Definition…) — no user state changes, but not "read-only".
    wolfbook_inspectSymbols: 'A', wolfbook_getKernelState: 'A',
    // ── notebooks: changing ──────────────────────────────────────────────
    wolfbook_newNotebook: 'A', wolfbook_insertCells: 'A', wolfbook_moveCell: 'A',
    wolfbook_restoreDeletedCells: 'A', wolfbook_saveNotebook: 'A', wolfbook_exportSessionReport: 'A',
    wolfbook_remote_checkpoint: 'A', wolfbook_selectKernel: 'A', wolfbook_setTarget: 'A',
    wolfbook_cancelOperation: 'A',
    wolfbook_editCell: 'D', wolfbook_deleteCell: 'D', wolfbook_kernelControl: 'D',
    wolfbook_kernelManager: 'D',
    // ── running code ─────────────────────────────────────────────────────
    wolfbook_evaluateExpression: 'X', wolfbook_runCell: 'X', wolfbook_runCells: 'X',
    wolfbook_debugCell: 'X', wolfbook_selfTest: 'X',
    // wolfbook_tools {action:"call"} can run any tool, so it carries the worst case.
    wolfbook_tools: 'X',
    // ── research, agents, people ─────────────────────────────────────────
    wolfbook_literatureSearch: 'RW', wolfbook_paperSearch: 'RW',
    wolfbook_skilxiv: 'AW', wolfbook_fairy_dispatch: 'AW', wolfbook_gold_run: 'AW',
    wolfteam_proposePlan: 'A', wolfteam_askDecision: 'A', wolfteam_checkpoint: 'A',
    wolfteam_askSpecialist: 'AW',
    // ── slides ───────────────────────────────────────────────────────────
    wolfslide_getContext: 'R', wolfslide_listSlides: 'R', wolfslide_getSlide: 'R',
    wolfslide_getSlideHtml: 'R', wolfslide_getImageDimensions: 'R', wolfslide_searchSlides: 'R',
    wolfslide_insertSlide: 'A', wolfslide_duplicateSlide: 'A', wolfslide_bulkInsert: 'A',
    wolfslide_copySlides: 'A', wolfslide_saveFile: 'A', wolfslide_exportHtml: 'A',
    wolfslide_setTheme: 'A', wolfslide_imageAsset: 'A',
    wolfslide_replaceSlide: 'D', wolfslide_editSlide: 'D', wolfslide_deleteSlide: 'D',
    wolfslide_deleteSlides: 'D', wolfslide_moveSlide: 'D', wolfslide_undo: 'D',
    wolfslide_reload: 'D', wolfslide_block: 'D', wolfslide_patchBlock: 'D',
    wolfslide_advanced: 'D', wolfslide_arrange: 'D',
    wolfslide_insertEvalBlock: 'X', wolfslide_runEvalBlock: 'X',
    // ── papers ───────────────────────────────────────────────────────────
    paper_getOutline: 'R', paper_getObject: 'R', paper_getSection: 'R',
    paper_findReferences: 'R', paper_search: 'R', paper_previewEdit: 'R',
    paper_applyEdit: 'D', paper_mathematicaBlocks: 'D', paper_listenComments: 'D',
    wolfbook_latex: 'X',   // runs latexmk/pdflatex; can clean build files
};

// Calling these twice with the same arguments has no further effect.
const IDEMPOTENT = new Set([
    'wolfbook_setTarget', 'wolfbook_saveNotebook', 'wolfbook_editCell', 'wolfbook_selectKernel',
    'wolfslide_saveFile', 'wolfslide_setTheme', 'wolfslide_replaceSlide', 'wolfslide_reload',
]);

/** Annotations for one tool, or null when it is unclassified. */
function toolAnnotations(name) {
    const cls = TOOL_CLASS[name];
    if (!cls) return null;
    const a = { ...CLASSES[cls] };
    if (!a.readOnlyHint) a.idempotentHint = IDEMPOTENT.has(name);
    return a;
}

module.exports = { toolAnnotations, TOOL_CLASS, CLASSES };
