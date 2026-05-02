"use strict";
/*
 * Lightweight event bus shared between the main extension and the
 * `wolfbook.remote.*` command surface.  Designed to be a no-op when the
 * Remote Host addon is absent (no listeners → emit() costs effectively
 * nothing).
 *
 * Channels in v0.1:
 *   - `toolUsage`     — every Wolfbook MCP tool invocation
 *   - `checkpoint`    — `wolfbook_remote_checkpoint` calls
 *
 * The bus is intentionally tiny: a Map of channel → Set<handler>. We keep
 * it process-local; subscriptions never leak across windows.
 */

const _channels = new Map();   // channel → Set<handler>

function on(channel, handler) {
    if (!_channels.has(channel)) _channels.set(channel, new Set());
    _channels.get(channel).add(handler);
    return () => off(channel, handler);
}

function off(channel, handler) {
    const set = _channels.get(channel);
    if (set) set.delete(handler);
}

function emit(channel, payload) {
    const set = _channels.get(channel);
    if (!set || set.size === 0) return;
    for (const h of set) {
        try { h(payload); } catch (_) { /* never let listeners break callers */ }
    }
}

function listenerCount(channel) {
    return _channels.get(channel)?.size || 0;
}

module.exports = { on, off, emit, listenerCount };
