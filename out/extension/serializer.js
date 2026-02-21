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
class VSNBContentSerializer {
    constructor() {
        // TODO: better label
        this.label = 'Wolfram Language Content Serializer';
    }
    async deserializeNotebook(data, token) {
        const decoder = new util.TextDecoder();
        const encoder = new util.TextEncoder();
        let notebook;
        try {
            notebook = JSON.parse(decoder.decode(data));
            
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
                    }
                }
            }
            
            // Restore metadata
            notebook.metadata = metadata;
        }
        catch (e) {
            notebook = { cells: [], metadata: {} };
        }
        return notebook;
    }
    async serializeNotebook(data, token) {
        const decoder = new util.TextDecoder();
        const encoder = new util.TextEncoder();
        let notebook = data;
        try {
            // Preserve metadata including custom settings
            const metadata = notebook.metadata || {};
            
            for (const cell of notebook.cells) {
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
            notebook = { cells: [], metadata: {} };
        }
        return encoder.encode(JSON.stringify(notebook, null, 1));
    }
}
exports.VSNBContentSerializer = VSNBContentSerializer;
//# sourceMappingURL=serializer.js.map