'use strict';
/**
 * Oberon — provider registry.
 *
 * Lazy-instantiates the adapter for a given provider name. Caches singletons
 * by name so settings.onDidChange does not need to dispose them — each
 * adapter reads settings fresh on every chatComplete() call.
 */

const cache = new Map();

function getAdapter(name) {
    const key = String(name || '').toLowerCase();
    if (!key) throw new Error('provider name is empty');
    if (cache.has(key)) return cache.get(key);
    let inst;
    switch (key) {
        case 'deepseek':  { const { DeepSeekAdapter }  = require('./deepseek');  inst = new DeepSeekAdapter();  break; }
        case 'openai':    { const { OpenAIAdapter }    = require('./openai');    inst = new OpenAIAdapter();    break; }
        case 'anthropic': { const { AnthropicAdapter } = require('./anthropic'); inst = new AnthropicAdapter(); break; }
        case 'lmapi':     { const { LmApiAdapter }     = require('./lmapi');     inst = new LmApiAdapter();     break; }
        default:
            throw new Error(`Unknown provider '${name}'. Supported: deepseek, openai, anthropic, lmapi.`);
    }
    cache.set(key, inst);
    return inst;
}

function listProviders() {
    return ['deepseek', 'openai', 'anthropic', 'lmapi'];
}

module.exports = { getAdapter, listProviders };
