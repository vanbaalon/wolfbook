'use strict';
/**
 * LEGACY shim — to be removed in a future version.
 *
 * Re-exports FAIRY_SYSTEM_PROMPT from the canonical location: oberon/fairy/prompts.js
 * Import from there directly instead.
 *
 * Still referenced by: core/promptAssembly.js, ui/runInspector.js
 */

const { FAIRY_SYSTEM_PROMPT } = require('../fairy/prompts');

module.exports = { FAIRY_SYSTEM_PROMPT };
