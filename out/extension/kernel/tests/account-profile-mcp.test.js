'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureClaudeProfileMcp } = require('../../account-profile-mcp');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-profile-mcp-'));
try {
    const file = path.join(directory, '.claude.json');
    const initial = { oauthAccount: { emailAddress: 'test@example.invalid' }, projects: { '/project': { trust: true } },
        mcpServers: { other: { command: 'keep-me' }, wolfbook: { command: '/old/node', args: ['/old/bridge.js'] } } };
    fs.writeFileSync(file, JSON.stringify(initial));
    ensureClaudeProfileMcp(directory, process.execPath);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(config.oauthAccount, initial.oauthAccount);
    assert.deepStrictEqual(config.projects, initial.projects);
    assert.deepStrictEqual(config.mcpServers.other, initial.mcpServers.other);
    assert.strictEqual(config.mcpServers.wolfbook.command, process.execPath);
    assert(fs.existsSync(config.mcpServers.wolfbook.args[0]));
    assert(fs.existsSync(path.join(directory, 'skills/wolfbook/SKILL.md')));
    const before = fs.statSync(file).mtimeMs;
    ensureClaudeProfileMcp(directory, process.execPath);
    assert.strictEqual(fs.statSync(file).mtimeMs, before, 'unchanged config is not rewritten');
    fs.writeFileSync(file, '{broken');
    assert.throws(() => ensureClaudeProfileMcp(directory, process.execPath), /Cannot update/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken', 'never discard invalid user configuration');
    fs.unlinkSync(file);
    ensureClaudeProfileMcp(directory, process.execPath);
    assert(JSON.parse(fs.readFileSync(file)).mcpServers.wolfbook, 'new profiles receive Wolfbook');
    console.log('Profile MCP: new/old profiles, preserved account and custom servers, skill installation, idempotence, malformed config passed.');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
