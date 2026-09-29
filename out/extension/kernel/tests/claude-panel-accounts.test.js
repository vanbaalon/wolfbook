'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { createBridge, atomicWrite } = require('../../claude-panel-accounts');
const { selectRoute, applyEnvironment } = require('../../claude-panel-launcher');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wolfbook panel ' test-"));
    const context = { globalStorageUri: { fsPath: tmp }, subscriptions: [] };
    let setting = '';
    let updates = 0;
    const originalConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
    const vscode = {
        ConfigurationTarget: { Global: 1 },
        extensions: { getExtension: () => ({}) },
        workspace: { isTrusted: true, getConfiguration: () => ({
            get: () => setting,
            update: async (key, value, target) => {
                assert.strictEqual(key, 'claudeProcessWrapper');
                assert.strictEqual(target, 1);
                setting = value; updates++;
            },
        }) },
    };
    try {
        assert.strictEqual(selectRoute([{ pid: 10, root: '/a', env: {} }], 11), undefined,
            'another window cannot inherit a profile by cwd');
        const base = { ANTHROPIC_API_KEY: 'test-only', KEEP: 'yes' };
        assert.deepStrictEqual(applyEnvironment(base, { ANTHROPIC_API_KEY: null, CLAUDE_CONFIG_DIR: '/personal' }),
            { KEEP: 'yes', CLAUDE_CONFIG_DIR: '/personal' });
        assert.strictEqual(base.ANTHROPIC_API_KEY, 'test-only', 'never mutate host environment');
        const bridge = createBridge(context, vscode, () => process.execPath);
        if (process.platform === 'win32') {
            assert.strictEqual(await bridge.sync(tmp, {}, true), false);
            return;
        }
        assert.strictEqual(await bridge.sync(tmp, {}, false), false, 'do not install for untouched default accounts');
        const profile = path.join(tmp, 'personal');
        await bridge.sync(tmp, { CLAUDE_CONFIG_DIR: profile, ANTHROPIC_API_KEY: null }, true);
        assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, profile, 'native history reader follows selected profile');
        assert.strictEqual(updates, 1);
        const fixture = path.join(tmp, 'echo.js');
        fs.writeFileSync(fixture, 'console.log(JSON.stringify({dir:process.env.CLAUDE_CONFIG_DIR,key:process.env.ANTHROPIC_API_KEY,args:process.argv.slice(2)}));');
        const probe = () => {
            const result = spawnSync(setting, [process.execPath, fixture, 'spaces and $dollars', '"quoted"'], {
                cwd: tmp, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'test-only', CLAUDE_CONFIG_DIR: '/default' },
            });
            assert.strictEqual(result.status, 0, result.stderr);
            return JSON.parse(result.stdout);
        };
        assert.deepStrictEqual(probe(), { dir: profile, args: ['spaces and $dollars', '"quoted"'] });
        await bridge.sync(tmp, { CLAUDE_CONFIG_DIR: '/second-profile' }, true);
        assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, '/second-profile', 'history directory switches without reloading');
        assert.strictEqual(updates, 1, 'profile switch updates only this host route');
        assert.strictEqual(probe().dir, '/second-profile');
        await bridge.sync(tmp, {}, false);
        assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, originalConfigDirectory, 'Default restores host history directory');
        assert.strictEqual(probe().dir, '/default', 'Default restores usual configuration');
        assert.strictEqual(probe().key, 'test-only');
        const config = path.join(tmp, 'claude-panel', 'config.json');
        const previousWrapper = path.join(tmp, 'previous-wrapper');
        fs.writeFileSync(previousWrapper, '#!/bin/sh\nexport PREVIOUS_WRAPPER_CALLED=yes\nexec "$@"\n', { mode: 0o700 });
        fs.writeFileSync(fixture, 'console.log(JSON.stringify({previous:process.env.PREVIOUS_WRAPPER_CALLED}));');
        atomicWrite(config, JSON.stringify({ previousWrapper }));
        assert.strictEqual(probe().previous, 'yes', 'preserve existing corporate launcher');
        fs.writeFileSync(path.join(tmp, 'claude-panel', `host-${process.pid}.json`), '{bad');
        const bad = spawnSync(setting, [process.execPath, fixture], { cwd: tmp, encoding: 'utf8' });
        assert.notStrictEqual(bad.status, 0, 'corrupt route must fail instead of silently using default credentials');
        await bridge.sync(tmp, { CLAUDE_CONFIG_DIR: profile }, true);
        bridge.clear();
        assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, originalConfigDirectory, 'disposing restores original host environment');
        process.env.CLAUDE_CONFIG_DIR = '/inherited-custom-home';
        const inherited = createBridge(context, vscode, () => process.execPath);
        await inherited.sync(tmp, { CLAUDE_CONFIG_DIR: profile }, true);
        await inherited.sync(tmp, {}, false);
        assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, '/inherited-custom-home', 'Default preserves inherited custom home');
        console.log('Claude panel bridge: per-host routing, real launcher argv/environment, switches, Default, existing wrapper, corrupt routes passed.');
    } finally {
        context.subscriptions.forEach(item => item.dispose());
        if (originalConfigDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = originalConfigDirectory;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
