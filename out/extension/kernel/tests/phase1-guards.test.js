'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(extensionRoot, rel), 'utf8');

const tools = read('tools/index.js');
const slideTools = read('tools/wolfslide-tools.js');
const remote = read('remote/index.js');
const debuggerSource = read('debugger/debugController.js');
const extension = read('extension.js');
const shim = read('oberon/core/wolframShim.js');

// Agent-facing tools must use the tracked wrapper, both for honest status and
// so timed-out observations cannot release a lease while WSTP is still active.
assert.strictEqual(/session\.evaluate\s*\(/.test(tools), false);
assert.strictEqual(/session\.evaluate\s*\(/.test(slideTools), false);
assert((tools.match(/acquireKernelForAgent\s*\(/g) || []).length >= 10);
assert((slideTools.match(/acquireKernelForAgent\s*\(/g) || []).length >= 3);

// No tool or command may recreate the old implicit-priority-abort behaviour.
assert.strictEqual(/abortAndWait\s*\(/.test(tools), false);
assert(/\.arbiter\?*\.abort\(/.test(remote));
assert(debuggerSource.includes('ctrl.arbiter.abort('));
assert(/activeController\.arbiter\.abort\(activeController/.test(extension));
assert(/\.arbiter\?*\.acquire\(/.test(shim));
assert(shim.includes("kind: 'fairy-run'"));

console.log('phase 1 static guards: OK');
