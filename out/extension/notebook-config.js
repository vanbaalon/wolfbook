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
const configCompat = require("./config-compat");
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
            if (e.affectsConfiguration("wolfbook") || e.affectsConfiguration("wolfram")) {
                callback(this);
            }
        }));
    }
    get(configName) {
        return configCompat.getSetting(configName);
    }
    async update(configName, value, configurationTarget) {
        return await configCompat.updateSetting(configName, value, configurationTarget);
    }
    getKernelRelatedConfigs() {
        const configNames = [
            "notebook.rendering.invertBrightnessInDarkThemes",
            "notebook.rendering.imageScalingFactor",
            "notebook.rendering.outputFormat",
            // gates the interactive-3D mesh emitted alongside Graphics3D images
            "notebook.rendering.interactive3D",
            // gates the curve data emitted alongside 2D plot images (hover callout)
            "notebook.rendering.plotTooltips"
        ];
        let config = {};
        configNames.forEach(name => {
            const v = configCompat.getSetting(name);
            // A setting VS Code has not registered yet reads back as undefined.
            // Sending it would push the literal symbol `undefined` into the kernel
            // and poison the option (TrueQ[undefined] is False), so omit the key
            // entirely and let the kernel-side default apply.
            if (v !== undefined && v !== null) config[name.split('.').pop()] = v;
        });
        console.log('[NotebookConfig] Kernel configs:', config);
        return config;
    }
}
exports.NotebookConfig = NotebookConfig;
//# sourceMappingURL=notebook-config.js.map