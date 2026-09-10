"use strict";
// Copyright 2021 Tianhuan Lu
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
Object.defineProperty(exports, "__esModule", { value: true });
exports.VSNBContentSerializer = void 0;
const util = require("util");
const _outputRenderer = require('./output/renderer');
const _nbImport = require('./nb-import/index');
const { parseNotebookJson } = require('./utils/notebook-json');
class VSNBContentSerializer {
    constructor() {
        // TODO: better label
        this.label = 'Wolfram Language Content Serializer';
    }
    async deserializeNotebook(data, token) {
        const decoder = new util.TextDecoder();
        const encoder = new util.TextEncoder();
        let notebook;
        const text = decoder.decode(data);

        // File > New File creates a zero-byte document before Wolfbook's
        // serializer ever sees it. That is a valid new notebook, not damaged
        // JSON. Keep this narrowly scoped to blank input: malformed non-empty
        // files must still take the guarded parse path below and remain
        // untouched on failure.
        if (!text.trim()) {
            return { cells: [], metadata: {} };
        }

        // A Mathematica .nb is not JSON — convert it to the wolfbook cell model
        // on the fly. deserializeNotebook receives no URI, so this has to be a
        // content sniff rather than an extension check.
        if (_nbImport.isNbSource(text)) {
            return _nbImport.deserializeNbNotebook(text);
        }

        try {
            notebook = parseNotebookJson(text);
            
            // Preserve notebook metadata including settings
            const metadata = notebook.metadata || {};
            
            for (let cell of notebook.cells) {
                if (cell.executionSummary) {
                    // execution summary is session-specific
                    delete cell.executionSummary;
                }
                if (cell.outputs) {
                    for (const output of cell.outputs) {
                        for (const item of output.items) {
                            item.data = encoder.encode(item.data);
                        }
                        // TODO-1a/1b: retroactively add text/plain for backward compat
                        // (notebooks saved before v2.1.0 only have WL HTML items)
                        if (!output.items.some(it => it.mime === 'text/plain')) {
                            const htmlItem = output.items.find(it => it.mime === 'x-application/wolfram-language-html');
                            if (htmlItem) {
                                const htmlStr = new util.TextDecoder().decode(htmlItem.data);
                                const outNMatch = htmlStr.match(/data-out-n="(\d+)"/);
                                const outN = outNMatch ? outNMatch[1] : '?';
                                const isGfx = htmlStr.includes('vscode-wolfram-gfx-marker');
                                const plain = _outputRenderer.extractPlainText(htmlStr, `Out[${outN}]=`, isGfx, cell.source || '');
                                if (plain) output.items.push({ mime: 'text/plain', data: encoder.encode(plain) });
                            }
                        }
                    }
                }
            }
            
            // Restore metadata
            notebook.metadata = metadata;
        }
        catch (e) {
            throw new Error(`Cannot read notebook: ${e.message}. The original file has not been changed.`);
        }
        return notebook;
    }
    async serializeNotebook(data, token) {
        // An imported .nb is a view of a Mathematica file. Writing .wb JSON over
        // it would destroy it, so instead the original bytes go back unchanged —
        // the save is a no-op that keeps the file byte-identical. Cmd-S is bound
        // to wolfbook.saveNbCopyAsWb, which is what actually persists edits.
        if (data && data.metadata && data.metadata.wolfbookNbImport) {
            const original = _nbImport.originalSourceOf(data);
            if (typeof original === 'string') {
                return new util.TextEncoder().encode(original);
            }
            throw new Error(
                'This notebook is a read-only view of a Mathematica .nb file and cannot be saved in place. ' +
                'Run "Wolfbook: Save .nb copy as .wb" to create an editable copy.'
            );
        }

        const decoder = new util.TextDecoder();
        const encoder = new util.TextEncoder();
        let notebook;
        try {
            // Copy mutable containers before normalizing output bytes. VS Code
            // may reuse the supplied NotebookData after this save.
            notebook = { ...data, cells: data.cells.map(cell => ({
                ...cell, outputs: cell.outputs?.map(output => ({
                    ...output, items: output.items.map(item => ({ ...item })),
                })),
            })) };
            // Preserve metadata including custom settings
            const metadata = notebook.metadata || {};
            
            for (const cell of notebook.cells) {
                // Never persist executionSummary — it is session-specific and causes
                // Dropbox-sync diff conflicts when VS Code writes timing/order data
                // that the synced version doesn't have.
                if (cell.executionSummary !== undefined) {
                    delete cell.executionSummary;
                }
                // TODO-1c: markdown cells must not persist outputs
                if (cell.kind === 1 /* vscode.NotebookCellKind.Markup */) { cell.outputs = []; continue; }
                if (cell.outputs) {
                    for (const output of cell.outputs) {
                        for (const item of output.items) {
                            item.data = decoder.decode(item.data);
                        }
                    }
                }
            }
            
            // Restore metadata to notebook object
            notebook.metadata = metadata;
        }
        catch (e) {
            throw new Error(`Cannot save notebook: ${e.message}. Saving was cancelled to preserve the existing file.`);
        }
        return encoder.encode(JSON.stringify(notebook, null, 1));
    }
}
exports.VSNBContentSerializer = VSNBContentSerializer;
//# sourceMappingURL=serializer.js.map
