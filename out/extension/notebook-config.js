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
exports.NotebookConfig = void 0;
const vscode = require("vscode");
class NotebookConfig {
    constructor() {
        // private config: vscode.WorkspaceConfiguration;
        this.disposables = [];
        // this.config = vscode.workspace.getConfiguration(("wolfram", null));
    }
    dispose() {
        this.disposables.forEach(item => {
            item.dispose();
        });
    }
    onDidChange(callback) {
        this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("wolfram")) {
                callback(this);
            }
        }));
    }
    get(configName) {
        return vscode.workspace.getConfiguration("wolfram").get(configName);
    }
    async update(configName, value, configurationTarget) {
        return await vscode.workspace.getConfiguration("wolfram").update(configName, value, configurationTarget);
    }
    getKernelRelatedConfigs() {
        const configNames = [
            "notebook.rendering.invertBrightnessInDarkThemes",
            "notebook.rendering.imageScalingFactor",
            "notebook.rendering.outputFormat"
        ];
        const renderingConfig = vscode.workspace.getConfiguration("wolfram");
        let config = {};
        configNames.forEach(name => {
            config[name.split('.').pop()] = renderingConfig.get(name);
        });
        console.log('[NotebookConfig] Kernel configs:', config);
        return config;
    }
}
exports.NotebookConfig = NotebookConfig;
//# sourceMappingURL=notebook-config.js.map