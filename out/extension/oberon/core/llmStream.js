/**
 * Streaming preview helper for Oberon LLM calls.
 *
 * Returns an `onChunk` callback compatible with adapter.chatComplete that
 * emits throttled `llm.reasoning_progress` and `llm.response_progress`
 * events on the telemetry bus so the Run Inspector can show a live
 * preview of what the model is thinking / generating.
 *
 * Payload fields:
 *   preview — last 400 chars of the accumulated stream (legacy consumers:
 *             working.wb status cell, activity view)
 *   delta   — ONLY the text accumulated since the previous emitted event.
 *             Concatenating deltas reconstructs the full stream, so the Run
 *             Inspector can show a long scrolling reasoning view without the
 *             telemetry log storing the overlap of every preview window.
 *   seq     — per-call sequence number (0-based); resets when the stream
 *             switches between reasoning and response. seq===0 → start fresh.
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
    let reasoningSent  = 0;   // chars of reasoningAccum already emitted as deltas
    let responseSent   = 0;
    let reasoningSeq   = 0;
    let responseSeq    = 0;
    let lastEmitMs     = 0;
    const opts = { spanId: spanId || null, questId: questId || null, charmId: charmId || null };
    return function onChunk(chunk) {
        if (!chunk || !chunk.text) return;
        const now = Date.now();
        if (chunk.type === 'reasoning') {
            reasoningAccum += chunk.text;
            if (now - lastEmitMs < FLUSH_MS) return;
            lastEmitMs = now;
            const delta = reasoningAccum.slice(reasoningSent);
            reasoningSent = reasoningAccum.length;
            bus.appendEvent('llm.reasoning_progress', {
                role, questId: questId || null, charmId: charmId || null,
                preview: reasoningAccum.slice(-400),
                delta, seq: reasoningSeq++,
            }, opts).catch(() => {});
        } else if (chunk.type === 'content' || chunk.type === 'text') {
            responseAccum += chunk.text;
            if (now - lastEmitMs < FLUSH_MS) return;
            lastEmitMs = now;
            const delta = responseAccum.slice(responseSent);
            responseSent = responseAccum.length;
            bus.appendEvent('llm.response_progress', {
                role, questId: questId || null, charmId: charmId || null,
                preview: responseAccum.slice(-400),
                delta, seq: responseSeq++,
            }, opts).catch(() => {});
        }
    };
}

module.exports = { makeOnChunk };
