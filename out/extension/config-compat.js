"use strict";
const vscode = require("vscode");

function _inspect(config, name) {
    try {
        return config.inspect(name);
    } catch (_) {
        return undefined;
    }
}

function _hasExplicitValue(config, name) {
    const inspected = _inspect(config, name);
    if (!inspected) {
        return false;
    }
    return inspected.workspaceFolderValue !== undefined
        || inspected.workspaceValue !== undefined
        || inspected.globalValue !== undefined;
}

function getSetting(name, defaultValue, scope = null) {
    const primary = vscode.workspace.getConfiguration("wolfbook", scope);
    if (_hasExplicitValue(primary, name)) {
        return primary.get(name, defaultValue);
    }
    return vscode.workspace.getConfiguration("wolfram", scope).get(name, defaultValue);
}

async function updateSetting(name, value, configurationTarget, scope = null) {
    return vscode.workspace.getConfiguration("wolfbook", scope).update(name, value, configurationTarget);
}

function affectsSetting(event, name, scope = null) {
    return event.affectsConfiguration(`wolfbook.${name}`, scope)
        || event.affectsConfiguration(`wolfram.${name}`, scope);
}

function getConfiguration(scope = null) {
    return {
        get(name, defaultValue) {
            return getSetting(name, defaultValue, scope);
        },
        update(name, value, configurationTarget) {
            return updateSetting(name, value, configurationTarget, scope);
        },
        inspect(name) {
            return {
                wolfbook: _inspect(vscode.workspace.getConfiguration("wolfbook", scope), name),
                wolfram: _inspect(vscode.workspace.getConfiguration("wolfram", scope), name)
            };
        }
    };
}

async function migrateLegacySettings(settingNames) {
    const wolfbookCfg = vscode.workspace.getConfiguration("wolfbook");
    const wolframCfg = vscode.workspace.getConfiguration("wolfram");
    for (const name of settingNames) {
        const primary = _inspect(wolfbookCfg, name);
        const legacy = _inspect(wolframCfg, name);
        if (!legacy) {
            continue;
        }
        const hasPrimary = primary && (
            primary.workspaceFolderValue !== undefined
            || primary.workspaceValue !== undefined
            || primary.globalValue !== undefined
        );
        if (hasPrimary) {
            continue;
        }
        if (legacy.workspaceFolderValue !== undefined) {
            await wolfbookCfg.update(name, legacy.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        if (legacy.workspaceValue !== undefined) {
            await wolfbookCfg.update(name, legacy.workspaceValue, vscode.ConfigurationTarget.Workspace);
        }
        if (legacy.globalValue !== undefined) {
            await wolfbookCfg.update(name, legacy.globalValue, vscode.ConfigurationTarget.Global);
        }
    }
}

module.exports = {
    affectsSetting,
    getConfiguration,
    getSetting,
    migrateLegacySettings,
    updateSetting,
};