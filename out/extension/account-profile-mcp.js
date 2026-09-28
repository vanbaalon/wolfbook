'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./claude-panel-accounts');

function ensureClaudeProfileMcp(directory, nodeBin, extensionDirectory = __dirname) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, '.claude.json');
    let config = {};
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot update profile MCP configuration: ${error.message}`); }
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || (config.mcpServers && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) {
        throw new Error('Cannot update invalid profile MCP configuration.');
    }
    const entry = { type: 'stdio', command: nodeBin,
        args: [path.join(extensionDirectory, 'claude-mcp', 'stdio-bridge.js')], env: {} };
    if (JSON.stringify(config.mcpServers?.wolfbook) !== JSON.stringify(entry)) {
        config.mcpServers = { ...config.mcpServers, wolfbook: entry };
        atomicWrite(file, JSON.stringify(config, null, 2) + '\n');
    }
    // Claude's skill discovery moves with CLAUDE_CONFIG_DIR too.
    const source = path.join(extensionDirectory, 'claude-mcp', 'wolfbook-skill');
    const target = path.join(directory, 'skills', 'wolfbook');
    function copy(dir, dest) {
        fs.mkdirSync(dest, { recursive: true });
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const from = path.join(dir, item.name), to = path.join(dest, item.name);
            if (item.isDirectory()) copy(from, to);
            else if (item.isFile()) {
                const bytes = fs.readFileSync(from);
                if (!fs.existsSync(to) || !fs.readFileSync(to).equals(bytes)) atomicWrite(to, bytes);
            }
        }
    }
    copy(source, target);
    return file;
}

module.exports = { ensureClaudeProfileMcp };
