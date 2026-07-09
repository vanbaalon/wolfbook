'use strict';
/**
 * Oberon — telemetry bus.
 *
 * Single source of truth for run events. Writes JSONL to
 *   <workspace>/.oberon/telemetry/runs/<runId>.jsonl
 * and emits the same event on an in-process EventEmitter so the UI surfaces
 * (Control Room sidebar + Run Inspector) can react live.
 *
 * Design notes:
 *  - One TelemetryBus instance per process, owned by oberon/index.js.
 *  - Events are appended sequentially via an awaited promise chain to keep
 *    line order deterministic even when callers don't await appendEvent().
 *  - File handle is opened lazily on first append for a given run.
 *  - flush() awaits the current write tail and fsyncs at Circle boundaries.
 *  - When no workspace is open (memory-only mode), events are kept in RAM and
 *    still emitted to listeners; nothing is persisted.
 */

const fs       = require('fs');
const fsp      = require('fs/promises');
const path     = require('path');
const crypto   = require('crypto');
const { EventEmitter } = require('events');

const project = require('../memory/project');

const RECENT_BUFFER_SIZE = 10000;       // tail kept in memory for new subscribers / Inspector snapshot

// Watchdog for a single JSONL append. The workspace often lives inside a
// Dropbox-synced folder where a sync lock can stall one fs write indefinitely;
// because appends are chained sequentially, ONE hung write used to starve the
// entire run log (run at 2026-07-03T19:57 persisted 1 of 1123 events) while
// state.json — written through a separate path — kept advancing. On timeout we
// reopen the handle once and carry on; the failed line is counted, not retried.
const WRITE_TIMEOUT_MS = 5000;

// High-frequency streaming events that are pure noise in the JSONL archive.
// They are still emitted in-process (UI live preview), just not persisted.
const SKIP_PERSIST_TYPES = new Set(['llm.reasoning_progress', 'llm.response_progress']);

/** Generate a short ULID-ish event id: time-sorted + random suffix. */
function makeEventId() {
    const t = Date.now().toString(36);
    const r = crypto.randomBytes(5).toString('hex');
    return `ev_${t}_${r}`;
}

/** Generate a span id (parent links recorded by callers). */
function makeSpanId() {
    return `sp_${crypto.randomBytes(6).toString('hex')}`;
}

class TelemetryBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(64);
        /** @type {string|null} */
        this._runId = null;
        /** @type {fsp.FileHandle|null} */
        this._handle = null;
        /** @type {string|null} */
        this._filePath = null;
        /** @type {Promise<void>} sequential write tail */
        this._tail = Promise.resolve();
        /** @type {object[]} most recent events (for late subscribers) */
        this._recent = [];
        /** @type {boolean} */
        this._memoryOnly = false;
        /** @type {number} events that could not be persisted this run */
        this._droppedWrites = 0;
    }

    /**
     * Begin a new run. Closes any previous handle. Idempotent for the same id.
     * @param {string} runId
     */
    async beginRun(runId) {
        if (this._runId === runId && this._handle) return;
        await this.endRun();
        this._runId  = runId;
        this._recent = [];
        this._droppedWrites = 0;
        const runsDir = project.telemetryRunsDir();
        if (!runsDir) {
            this._memoryOnly = true;
            this._filePath = null;
            return;
        }
        this._memoryOnly = false;
        await project.ensureOberonLayout();
        this._filePath = path.join(runsDir, `${runId}.jsonl`);
        this._handle = await fsp.open(this._filePath, 'a');
        this.emit('runBegin', { runId });
    }

    /** End the current run. Flushes + closes the file handle. */
    async endRun() {
        const runId = this._runId;
        if (!runId) return;
        try { await this.flush(); } catch (_) {}
        try { if (this._handle) await this._handle.close(); } catch (_) {}
        this._handle = null;
        this._runId  = null;
        this.emit('runEnd', { runId });
    }

    /**
     * Append a telemetry event. Returns a promise resolved when the write hits
     * the OS write buffer. The promise NEVER rejects on disk errors — those
     * are surfaced as 'writeError' events to keep the agent loop alive.
     *
     * @param {string} type
     * @param {object} [payload]
     * @param {object} [opts]
     * @param {string|null} [opts.spanId]
     * @param {string|null} [opts.parentSpanId]
     * @param {string|null} [opts.correlationId]
     * @param {string|null} [opts.questId]
     * @param {string|null} [opts.charmId]
     * @returns {Promise<object>} the persisted event object
     */
    appendEvent(type, payload = {}, opts = {}) {
        const ev = {
            eventId:       makeEventId(),
            runId:         this._runId,
            ts:            new Date().toISOString(),
            spanId:        opts.spanId        || null,
            parentSpanId:  opts.parentSpanId  || null,
            correlationId: opts.correlationId || null,
            questId:       opts.questId       || null,
            charmId:       opts.charmId       || null,
            type:          String(type),
            payload:       payload || {},
        };
        // Maintain recent-buffer + emit immediately so UI feels live.
        this._recent.push(ev);
        if (this._recent.length > RECENT_BUFFER_SIZE) {
            this._recent.splice(0, this._recent.length - RECENT_BUFFER_SIZE);
        }
        try { this.emit('event', ev); } catch (_) {}

        // Persist sequentially, with a per-write watchdog so one hung fs write
        // (Dropbox sync lock) can never starve every subsequent event.
        this._tail = this._tail.then(async () => {
            if (this._memoryOnly || !this._handle) {
                if (!this._memoryOnly && !SKIP_PERSIST_TYPES.has(ev.type)) this._countDrop(ev, 'no_handle');
                return;
            }
            if (SKIP_PERSIST_TYPES.has(ev.type)) return;
            const line = JSON.stringify(ev) + '\n';
            try {
                await this._writeWithTimeout(line);
            } catch (e) {
                this._countDrop(ev, String(e && e.message || e));
                // Recovery: reopen the handle once so the NEXT event has a chance.
                await this._reopenHandle();
            }
        });
        return this._tail.then(() => ev);
    }

    /** @private — one append, bounded by WRITE_TIMEOUT_MS. */
    _writeWithTimeout(line) {
        const handle = this._handle;
        if (!handle) return Promise.reject(new Error('no_handle'));
        return new Promise((resolve, reject) => {
            let done = false;
            const timer = setTimeout(() => {
                if (!done) { done = true; reject(new Error(`write_timeout_${WRITE_TIMEOUT_MS}ms`)); }
            }, WRITE_TIMEOUT_MS);
            handle.write(line).then(
                () => { if (!done) { done = true; clearTimeout(timer); resolve(); } },
                (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
            );
        });
    }

    /** @private — count + surface a dropped event (never throws). */
    _countDrop(ev, reason) {
        this._droppedWrites += 1;
        try { this.emit('writeError', { error: reason, event: ev, dropped: this._droppedWrites }); } catch (_) {}
    }

    /** @private — best-effort handle reopen after a failed/hung write. */
    async _reopenHandle() {
        if (!this._filePath) return;
        const old = this._handle;
        this._handle = null;
        try { if (old) old.close().catch(() => {}); } catch (_) {}
        try { this._handle = await fsp.open(this._filePath, 'a'); } catch (_) { this._handle = null; }
    }

    /** Events that failed to persist during this run (0 = healthy). */
    get droppedWrites() { return this._droppedWrites; }

    /** Await pending writes and fsync. Call at Circle transitions. */
    async flush() {
        await this._tail;
        if (this._handle) {
            try { await this._handle.sync(); } catch (_) { /* best-effort */ }
        }
    }

    /** Snapshot of recent in-memory events (most recent last). */
    recent(limit = RECENT_BUFFER_SIZE) {
        const n = Math.min(limit, this._recent.length);
        return this._recent.slice(this._recent.length - n);
    }

    /** Currently-active runId, or null. */
    get runId() { return this._runId; }

    /** Path of the JSONL file for the active run, or null. */
    get filePath() { return this._filePath; }

    /** True when no workspace is open (events emitted but not persisted). */
    get memoryOnly() { return this._memoryOnly; }
}

/**
 * Replay events from a JSONL file (e.g. on extension restart).
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
async function readRunLog(filePath) {
    const buf = await fsp.readFile(filePath, 'utf8').catch(() => '');
    const out = [];
    for (const line of buf.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); } catch (_) { /* tolerate partial lines */ }
    }
    return out;
}

module.exports = { TelemetryBus, makeEventId, makeSpanId, readRunLog };
