'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return {};
    return originalLoad.apply(this, arguments);
};
const {
    WolframMCPServer,
    MCP_SERVER_INSTRUCTIONS,
    MCP_ECONOMY_INSTRUCTIONS,
    writeClaudeConfig,
    repairStaleClaudeConfigs,
    needsConfigUpdate,
    installAgentSkills,
    needsAgentSkillsInstall,
    getMcpInfoPayload,
    writeRooCodeConfig,
    needsRooCodeConfigUpdate,
    writeClaudeScienceConfig,
    needsClaudeScienceConfigUpdate,
    claudeScienceInstalled,
    claudeSciencePlan,
    installClaudeScienceBridge,
    claudeScienceEntryState,
    claudeScienceSandboxState,
    grantClaudeScienceSandbox,
} = require('../../claude-mcp/server');
Module._load = originalLoad;

(async () => {
    // Deferred-tool clients see this before full tool descriptions.
    const server = new WolframMCPServer(new Map(), []);
    const initialized = await server._dispatch('initialize', {
        clientInfo: { name: 'agent-discovery-test' },
        protocolVersion: '2024-11-05',
    }, 'test-session');
    assert.strictEqual(initialized.instructions, MCP_SERVER_INSTRUCTIONS);
    assert.match(initialized.instructions, /Mathematica and Wolfram Language/);
    assert.match(initialized.instructions, /wolframscript or WolframKernel/);
    assert(initialized.instructions.length < 2048, 'server instructions must fit Claude Code limit');
    // Claude Desktop gets no local skill directory, so this string is the only
    // guidance it ever sees — the card's section on presentation cannot reach it.
    assert.match(initialized.instructions, /Grid/,
        'Claude Desktop is told how to present results, or it never learns');

    server._sessionProfiles.set('economy-session', 'economy');
    const economyInitialized = await server._dispatch('initialize', {
        clientInfo: { name: 'small-model' },
        protocolVersion: '2024-11-05',
    }, 'economy-session');
    assert.strictEqual(economyInitialized.serverInfo.name, 'wolfbook-economy');
    assert.strictEqual(economyInitialized.instructions, MCP_ECONOMY_INSTRUCTIONS);
    assert(MCP_ECONOMY_INSTRUCTIONS.length < MCP_SERVER_INSTRUCTIONS.length,
        'economy handshake guidance should itself be economical');

    // --- THE SKILL CARD SAYS HOW TO SHOW A RESULT, AND DOES NOT CONTRADICT ITSELF
    //
    // The rule was already in the card, one parenthetical inside a list of
    // unrelated language trivia — and the card's own worked example ended on a
    // bare Association, which is louder than any rule. Agents followed the
    // example. These assertions keep the rule visible and the examples honest.
    const CARD = fs.readFileSync(
        path.join(__dirname, '..', '..', 'claude-mcp', 'wolfbook-skill', 'SKILL.md'), 'utf8');
    assert.match(CARD, /^## Showing results to the user/m,
        'the presentation rule has its own section, not a buried bullet');
    assert.match(CARD, /must be a `Grid`, not an `Association`/,
        'and states it as a rule');
    assert.match(CARD, /Associations remain the right data structure/,
        'while keeping Associations correct for data the agent parses itself — ' +
        'otherwise this contradicts the getResult guidance');

    // No wolfram example may DISPLAY an Association: an example that ends on a
    // bare <|…|> teaches the opposite of the rule above it.
    for (const m of CARD.matchAll(/```wolfram\n([\s\S]*?)```/g)) {
        // The displayed value is the trailing STATEMENT, not the trailing line:
        // an Association wrapped across two lines ends on its continuation, and
        // a last-line check reads that as innocent. It is how this very check
        // first passed against the example it was written to catch.
        const shown = m[1].trimEnd().replace(/;\s*$/, '').split(';').pop().trim();
        assert.ok(!/^<\|/.test(shown),
            `a wolfram example displays an Association: ${shown.replace(/\n/g, ' ').slice(0, 70)}`);
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-agent-discovery-'));
    try {
        const claudePath = path.join(home, '.claude.json');
        fs.writeFileSync(claudePath, JSON.stringify({
            projects: {
                '/managed': {
                    mcpServers: {
                        wolfbook: {
                            type: 'stdio', command: '/old/node',
                            args: ['/old/wolfbook.wolfbook-1.0.0/stdio-bridge.js'], env: {},
                        },
                    },
                },
                '/custom': {
                    mcpServers: {
                        wolfbook: {
                            type: 'stdio', command: '/custom/node',
                            args: ['/custom/mathematica/stdio-bridge.js'], env: {},
                        },
                    },
                },
            },
        }, null, 2));

        const bridgePath = '/current/wolfbook.wolfbook-2.0.0/stdio-bridge.js';
        const nodeBin = '/current/node';
        writeClaudeConfig(bridgePath, nodeBin, home, 27182, ['/ignored/project']);

        const claude = JSON.parse(fs.readFileSync(claudePath, 'utf8'));
        assert.deepStrictEqual(claude.mcpServers.wolfbook, {
            type: 'stdio', command: nodeBin, args: [bridgePath], env: {},
        });
        assert(!claude.projects['/managed'].mcpServers, 'managed local entry should migrate to user scope');
        assert.strictEqual(
            claude.projects['/custom'].mcpServers.wolfbook.command,
            '/custom/node',
            'custom local override must be preserved'
        );
        assert.strictEqual(needsConfigUpdate(bridgePath, nodeBin, [], home), false);

        // Codex gets --profile=full: it defers MCP tools behind a search built from the
        // FIRST tools/list and ignores tools/list_changed, so the auto profile would hide
        // rare tools from it for good. An entry without the flag is stale.
        const codexPath = path.join(home, '.codex', 'config.toml');
        const codexToml = fs.readFileSync(codexPath, 'utf8');
        assert.match(codexToml, /\[mcp_servers\.wolfbook\][\s\S]*args = \[".*stdio-bridge\.js", "--profile=full"\]/,
            'Codex bridge args carry --profile=full');
        assert.strictEqual((codexToml.match(/\[mcp_servers\.wolfbook\]/g) || []).length, 1, 'exactly one wolfbook block');
        fs.writeFileSync(codexPath, codexToml.replace(', "--profile=full"', ''));
        assert.strictEqual(needsConfigUpdate(bridgePath, nodeBin, [], home), true, 'a Codex entry without the flag is stale');
        writeClaudeConfig(bridgePath, nodeBin, home, 27182, []);
        assert.strictEqual(needsConfigUpdate(bridgePath, nodeBin, [], home), false, 'rewritten with the flag');

        // A legacy local entry that reappears is removed once user scope exists.
        claude.projects['/legacy'] = {
            mcpServers: {
                wolfbook: {
                    type: 'stdio', command: '/old/node',
                    args: ['/old/wolfbook.wolfbook-1.0.0/stdio-bridge.js'], env: {},
                },
            },
        };
        fs.writeFileSync(claudePath, JSON.stringify(claude, null, 2));
        const migration = repairStaleClaudeConfigs(bridgePath, nodeBin, home);
        assert(migration.repaired.some(item => item.includes('/legacy')));
        const migratedClaude = JSON.parse(fs.readFileSync(claudePath, 'utf8'));
        assert(!migratedClaude.projects['/legacy'].mcpServers);
        assert(migratedClaude.projects['/custom'].mcpServers.wolfbook);

        const firstInstall = installAgentSkills(home);
        for (const key of ['claudeCode', 'codex', 'rooCode', 'cline', 'antigravity']) {
            assert(fs.existsSync(firstInstall.skillPaths[key]), `${key} skill should exist`);
        }
        assert.strictEqual(firstInstall.skillPaths.codex, firstInstall.skillPaths.rooCode);
        assert(fs.existsSync(path.join(path.dirname(firstInstall.skillPaths.codex), 'agents', 'openai.yaml')));
        assert.strictEqual(needsAgentSkillsInstall(home), false);

        fs.writeFileSync(firstInstall.skillPaths.claudeCode, 'stale', 'utf8');
        assert.strictEqual(needsAgentSkillsInstall(home), true);
        const repaired = installAgentSkills(home);
        assert.strictEqual(repaired.updated.claudeCode, true);
        assert.match(fs.readFileSync(repaired.skillPaths.claudeCode, 'utf8'), /name: wolfbook/);

        // Sidebar status distinguishes MCP configuration from skill discovery.
        const info = getMcpInfoPayload(bridgePath, nodeBin, 27182, false, false, home);
        assert.strictEqual(info.configured.claudeCode, true);
        assert.strictEqual(info.configured.codex, true);
        assert.strictEqual(info.skillsInstalled.claudeCode, true);
        assert.strictEqual(info.skillsInstalled.codex, true);
        assert.strictEqual(info.skillsInstalled.rooCode, true);
        assert.strictEqual(info.skillsInstalled.claudeDesktop, null);

        // Roo Code renamed its live settings file to mcp_settings.json. Preserve
        // an explicitly selected economy wrapper across eager activation writes.
        const rooDir = path.join(home, 'Library', 'Application Support', 'Code', 'User',
            'globalStorage', 'rooveterinaryinc.roo-cline', 'settings');
        fs.mkdirSync(rooDir, { recursive: true });
        const wrapper = path.join(home, 'wolfbook-mcp-bridge');
        fs.writeFileSync(wrapper, '#!/bin/sh\n');
        fs.chmodSync(wrapper, 0o755);
        const rooConfig = path.join(rooDir, 'mcp_settings.json');
        fs.writeFileSync(rooConfig, JSON.stringify({ mcpServers: {
            wolfbook: { type: 'stdio', command: wrapper, args: ['--profile=economy'],
                timeout: 600, alwaysAllow: [], disabled: false },
        } }, null, 2));
        assert.strictEqual(needsRooCodeConfigUpdate(bridgePath, nodeBin, home), true,
            'legacy economy key should be normalized once');
        writeRooCodeConfig(bridgePath, nodeBin, home);
        const roo = JSON.parse(fs.readFileSync(rooConfig, 'utf8'));
        assert(!roo.mcpServers.wolfbook, 'full/legacy key must not coexist with economy');
        assert.deepStrictEqual(roo.mcpServers['wolfbook-economy'].args, ['--profile=economy']);
        assert.strictEqual(roo.mcpServers['wolfbook-economy'].command, wrapper);
        assert.strictEqual(roo.mcpServers['wolfbook-economy'].timeout, 600);
        assert.strictEqual(needsRooCodeConfigUpdate(bridgePath, nodeBin, home), false,
            'valid economy config must survive future eager activation checks');

        // Claude Science: "Local command" connectors live in
        // ~/.claude-science/mcp/local-mcp.json as { servers: [...] } and run in a
        // sandbox that cannot read $HOME or reach TCP. Never create the app's data
        // dir; never lose the user's other connectors; grant only what is needed.
        const sock = '/private/tmp/wolfbook-mcp-501/mcp.sock';
        const homeNode = path.join(home, '.local', 'node', 'bin', 'node');
        fs.mkdirSync(path.dirname(homeNode), { recursive: true });
        fs.writeFileSync(homeNode, '');
        const plan0 = claudeSciencePlan(homeNode, home, { socketPath: sock, systemNodes: [] });
        assert.strictEqual(claudeScienceInstalled(home), false);
        assert.strictEqual(needsClaudeScienceConfigUpdate(plan0, home), false, 'not installed → nothing to do');
        assert.strictEqual(writeClaudeScienceConfig(plan0, home).skipped, true);
        assert(!fs.existsSync(path.join(home, '.claude-science')), 'must not create the app data dir');

        // The plan: stable bridge copy, the socket, and exactly the grants they need.
        const realHome = fs.realpathSync(home);
        assert.strictEqual(plan0.bridge, path.join(realHome, '.wolfbook', 'mcp', 'stdio-bridge.js'));
        assert.deepStrictEqual(plan0.readPaths, [path.join(realHome, '.wolfbook', 'mcp'), path.join(realHome, '.local', 'node')],
            'a node inside $HOME needs its install root granted');
        assert.deepStrictEqual(plan0.unixSockets, ['/private/tmp/wolfbook-mcp-501']);
        const sysPlan = claudeSciencePlan(homeNode, home, { socketPath: sock, systemNodes: [process.execPath] });
        if (!fs.realpathSync(process.execPath).startsWith(realHome + path.sep)) {
            assert.strictEqual(sysPlan.node, fs.realpathSync(process.execPath), 'prefer a system node outside $HOME');
            assert.deepStrictEqual(sysPlan.readPaths, [path.join(realHome, '.wolfbook', 'mcp')]);
        }

        const csDir = path.join(home, '.claude-science', 'mcp');
        fs.mkdirSync(csDir, { recursive: true });
        const csConfig = path.join(csDir, 'local-mcp.json');
        const plan = claudeSciencePlan(homeNode, home, { socketPath: sock, systemNodes: [] });
        assert.strictEqual(claudeScienceInstalled(home), true);
        assert.strictEqual(needsClaudeScienceConfigUpdate(plan, home), false,
            'activation never CREATES an entry — that needs the consented command');

        // Bridge copy is byte-identical and only rewritten when it changed.
        const realBridge = path.join(__dirname, '..', '..', 'claude-mcp', 'stdio-bridge.js');
        assert.strictEqual(installClaudeScienceBridge(realBridge, plan), true);
        assert(fs.readFileSync(plan.bridge).equals(fs.readFileSync(realBridge)));
        assert.strictEqual(installClaudeScienceBridge(realBridge, plan), false);

        fs.writeFileSync(csConfig, JSON.stringify({ servers: [
            { name: 'other', command: 'npx', args: ['-y', 'x'], env: { K: 'v' } },
            { name: 'wolfbook', command: '/old/node', args: ['/old/stdio-bridge.js', '--socket=/old.sock', '--profile=economy'],
                env: { A: '1' }, description: 'mine' },
        ] }));
        assert.deepStrictEqual(claudeScienceEntryState(plan), { present: true, managed: true, current: false });
        assert.strictEqual(needsClaudeScienceConfigUpdate(plan, home), true, 'a stale Wolfbook entry is repaired');
        assert.strictEqual(writeClaudeScienceConfig(plan, home).updated, true);
        const cs = JSON.parse(fs.readFileSync(csConfig, 'utf8'));
        assert.deepStrictEqual(cs.servers[0], { name: 'other', command: 'npx', args: ['-y', 'x'], env: { K: 'v' } });
        assert.deepStrictEqual(cs.servers[1], { name: 'wolfbook', command: plan.node,
            args: [plan.bridge, `--socket=${sock}`, '--profile=economy'], env: { A: '1' }, description: 'mine' });
        assert.strictEqual(fs.statSync(csConfig).mode & 0o777, 0o600, 'keeps the app\'s private file mode');
        assert.strictEqual(needsClaudeScienceConfigUpdate(plan, home), false);

        // Sandbox grants: missing → consented grant → present; the user's own entries survive.
        const toml = path.join(home, '.claude-science', 'config.toml');
        fs.writeFileSync(toml, '[update]\nchannel = "x"\n\n[sandbox]\nuser_read_paths = ["/data"]\n');
        assert.deepStrictEqual(claudeScienceSandboxState(plan),
            { ok: false, missingReads: plan.readPaths, missingSockets: plan.unixSockets });
        assert.strictEqual(getMcpInfoPayload(bridgePath, homeNode, 0, false, false, home).configured.claudeScience, false,
            'an entry the sandbox blocks is not "configured"');
        assert.deepStrictEqual(grantClaudeScienceSandbox(plan), { ok: true, changed: true, tomlPath: toml });
        const tomlText = fs.readFileSync(toml, 'utf8');
        assert.match(tomlText, /^\[update\]\nchannel = "x"\n/);
        assert(tomlText.includes(`user_read_paths = ["/data", "${plan.readPaths[0]}", "${plan.readPaths[1]}"]`));
        assert(tomlText.includes('[sandbox.network]\nallow_unix_sockets = ["/private/tmp/wolfbook-mcp-501"]'));
        assert.strictEqual(claudeScienceSandboxState(plan).ok, true);
        assert.strictEqual(grantClaudeScienceSandbox(plan).changed, false, 'idempotent');

        // A layout we cannot edit safely is refused, untouched.
        fs.writeFileSync(toml, 'sandbox.network.enabled = true\n');
        const refused = grantClaudeScienceSandbox(plan);
        assert.strictEqual(refused.ok, false);
        assert.strictEqual(fs.readFileSync(toml, 'utf8'), 'sandbox.network.enabled = true\n');

        // A malformed connector file makes the app drop every local connector;
        // don't "repair" it by overwriting the user's entries.
        fs.writeFileSync(csConfig, '{ not json');
        assert.strictEqual(needsClaudeScienceConfigUpdate(plan, home), false);
        assert.strictEqual(writeClaudeScienceConfig(plan, home).updated, false);
        assert.strictEqual(fs.readFileSync(csConfig, 'utf8'), '{ not json');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }

    console.log('agent discovery tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
