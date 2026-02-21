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
exports.NotebookOutputPanel = exports.ExportNotebookStatusBarItem = exports.KernelStatusBarItem = void 0;
const vscode = require("vscode");
class KernelStatusBarItem {
    constructor(supportedLanguages) {
        this.baseText = " Wolfram Kernel";
        this.kernelIsActive = false;
        this.editorIsActive = true;
        this.disposables = [];
        this.item = vscode.window.createStatusBarItem("wolfram-language-notebook-kernel-status", vscode.StatusBarAlignment.Right, 100);
        this.disposables.push(this.item);
        this.item.name = "Wolfram Kernel";
        this.item.command = "wolframLanguageNotebook.manageKernels";
        this.setDisconnected();
        this.updateVisibility();
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(e => {
            this.editorIsActive = Boolean(e?.document && supportedLanguages.includes(e.document.languageId));
            this.updateVisibility();
        }));
    }
    dispose() {
        this.disposables.forEach(item => {
            item.dispose();
        });
    }
    updateVisibility() {
        if (this.kernelIsActive || this.editorIsActive) {
            this.item.show();
        }
        else {
            this.item.hide();
        }
    }
    setState(active, icon, tooltip) {
        this.kernelIsActive = active;
        this.item.text = icon + this.baseText;
        this.item.tooltip = tooltip;
        this.updateVisibility();
    }
    setDisconnected() {
        this.setState(false, "$(close)", "Currently not connected to a kernel");
    }
    setConnecting() {
        this.setState(true, "$(loading~spin)", "Connecting to the kernel");
    }
    setConnected(tooltip = "", isRemote = false) {
        this.setState(true, (isRemote ? "$(remote)" : "$(check)"), tooltip || "Kernel connected");
    }
}
exports.KernelStatusBarItem = KernelStatusBarItem;
class ExportNotebookStatusBarItem {
    constructor() {
        this.item = vscode.window.createStatusBarItem("wolfram-language-export-notebook-status", vscode.StatusBarAlignment.Right, 101);
        this.item.name = "Export Notebook";
        this.item.text = "$(loading~spin) Generating Notebook";
        this.item.command = "wolframLanguageNotebook.manageKernels";
        this.item.hide();
    }
    show() {
        this.item.show();
    }
    hide() {
        this.item.hide();
    }
}
exports.ExportNotebookStatusBarItem = ExportNotebookStatusBarItem;
class NotebookOutputPanel {
    constructor(name) {
        this.outputChannel = vscode.window.createOutputChannel(name);
    }
    print(str) {
        this.outputChannel.appendLine("[" + new Date().toUTCString() + "] " + str);
    }
    show() {
        this.outputChannel.show();
    }
    hide() {
        this.outputChannel.hide();
    }
    clear() {
        this.outputChannel.clear();
    }
    dispose() {
        this.outputChannel.dispose();
    }
}
exports.NotebookOutputPanel = NotebookOutputPanel;
;
//# sourceMappingURL=ui-items.js.map