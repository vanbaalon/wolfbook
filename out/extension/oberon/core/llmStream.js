/**
 * Streaming preview helper for Oberon LLM calls.
 *
 * Returns an `onChunk` callback compatible with adapter.chatComplete that
 * emits throttled `llm.reasoning_progress` and `llm.response_progress`
 * events on the telemetry bus so the Run Inspector can show a live
 * preview of what the model is thinking / generating.
 *
 * @param {object} args
 * @param {import('../telemetry/bus')} args.bus
 * @param {string}  args.role         — 'planner' | 'executive' | 'critic' | 'skeptic' | 'postmortem' | …
 * @param {string|null} [args.questId]
 * @param {string|null} [args.charmId]
 * @param {string|null} [args.spanId]
 * @param {number}  [args.flushMs=200]
 * @returns {(chunk:{type:string,text:string})=>void}
 */
function makeOnChunk({ bus, role, questId, charmId, spanId, flushMs }) {
    const FLUSH_MS = Math.max(50, flushMs || 200);
    let reasoningAccum = '';
    let responseAccum  = '';
    let lastEmitMs     = 0;
    const opts = { spanId: spanId || null, questId: questId || null, charmId: charmId || null };
    return function onChunk(chunk) {
        if (!chunk || !chunk.text) return;
        const now = Date.now();
        if (chunk.type === 'reasoning') {
            reasoningAccum += chunk.text;
            if (now - lastEmitMs < FLUSH_MS) return;
            lastEmitMs = now;
            bus.appendEvent('llm.reasoning_progress', {
                role, questId: questId || null, charmId: charmId || null,
                preview: reasoningAccum.slice(-400),
            }, opts).catch(() => {});
        } else if (chunk.type === 'content' || chunk.type === 'text') {
            responseAccum += chunk.text;
            if (now - lastEmitMs < FLUSH_MS) return;
            lastEmitMs = now;
            bus.appendEvent('llm.response_progress', {
                role, questId: questId || null, charmId: charmId || null,
                preview: responseAccum.slice(-400),
            }, opts).catch(() => {});
        }
    };
}

module.exports = { makeOnChunk };
