'use strict';
/**
 * exampleExtractor — extract charm flow examples from Oberon telemetry JSONL files.
 *
 * Telemetry event format (actual on-disk structure):
 *   { eventId, runId, ts, spanId, questId, charmId, type, payload }
 *
 * Each "example" is a self-contained record of one charm execution:
 *   { charmId, runFile, quest, charm, notebookPath, turnTrace, scroll, selfReview, verdict, cost, timestamp }
 *
 * Usage:
 *   const { extractExamples, loadBestExamples } = require('./exampleExtractor');
 *   const examples = await extractExamples('/path/to/.oberon/telemetry/runs');
 */

const fs   = require('fs');
const path = require('path');

// Read all JSONL files in a directory and parse them as NDJSON.
function readRunFiles(dir) {
    let entries;
    try { entries = fs.readdirSync(dir); }
    catch (_) { return []; }

    const runs = [];
    for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); }
        catch (_) { continue; }
        const events = [];
        for (const line of raw.split('\n')) {
            const l = line.trim();
            if (!l) continue;
            try { events.push(JSON.parse(l)); } catch (_) { /* skip malformed */ }
        }
        if (events.length > 0) runs.push({ file: name, events });
    }
    return runs;
}

// Group events by charmId. charmId is a top-level field on each event.
function groupByCharm(events) {
    const map = new Map();
    for (const ev of events) {
        const charmId = ev.charmId || (ev.payload && ev.payload.charmId);
        if (!charmId) continue;
        if (!map.has(charmId)) map.set(charmId, []);
        map.get(charmId).push(ev);
    }
    return map;
}

// Read a JSON file from disk, return parsed object or null.
function readJsonFile(filePath) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (_) { return null; }
}

// Build a full example record from a charm's events.
function buildExample(charmId, events, runFile) {
    // Sort ascending by timestamp.
    const sorted = [...events].sort((a, b) => {
        const ta = a.ts || a.timestamp || '';
        const tb = b.ts || b.timestamp || '';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

    let quest        = null;
    let charm        = null;
    let scroll       = null;
    let verdict      = null;
    let notebookPath = null;
    const turnTrace  = [];
    let totalLlmTurns  = 0;
    let totalToolTurns = 0;
    let startTs = null;
    let endTs   = null;

    for (const ev of sorted) {
        // Actual on-disk field names: ev.type (kind), ev.payload (data), ev.ts (timestamp)
        const kind = ev.type || ev.kind || ev.event || '';
        const data = ev.payload || ev.data || {};
        const ts   = ev.ts || ev.timestamp || null;
        if (!startTs) startTs = ts;
        endTs = ts;

        if (kind === 'charm.dispatched') {
            // Load the full charm from the referenced JSON file on disk.
            if (!charm && data.file && data.file.path) {
                charm = readJsonFile(data.file.path);
                // The quest.json lives two levels up from the charm JSON.
                // charms/C02.json → quest dir → quest.json
                if (!quest) {
                    const questJsonPath = path.join(
                        path.dirname(path.dirname(data.file.path)),
                        'quest.json'
                    );
                    quest = readJsonFile(questJsonPath);
                }
            }
            if (!charm) charm = { id: charmId };
        }

        if (kind === 'notebook.created' && (data.kind === 'charm' || !data.kind)) {
            notebookPath = data.path || null;
        }

        if (kind === 'scroll.submitted') {
            // Read full Scroll from the referenced JSON file on disk if available.
            if (data.file && data.file.path) {
                scroll = readJsonFile(data.file.path) || data;
            } else {
                scroll = data;
            }
            if (data.toolTurns != null) totalToolTurns = data.toolTurns;
            if (data.llmTurns  != null) totalLlmTurns  = data.llmTurns;
        }

        if (kind === 'oberon.verdict' || kind === 'oberon_verdict') {
            verdict = {
                verdict:           data.verdict,
                verificationLevel: data.verificationLevel,
                confidence:        data.confidence,
                objections:        data.objections || [],
            };
        }

        // Turn summary — requires the fairy.turn_summary event added in this session.
        if (kind === 'fairy.turn_summary') {
            turnTrace.push({
                turnIndex:     data.turnIndex,
                toolCallCount: data.toolCallCount,
                toolTurns:     data.toolTurns,
                llmTurns:      data.llmTurns,
                inSelfCritique: !!data.inSelfCritique,
                contentLength:  data.contentLength,
                ts,
            });
        }
    }

    // Derive turn counts from trace if not available from scroll.submitted.
    if (turnTrace.length > 0 && totalLlmTurns === 0) {
        totalLlmTurns = turnTrace.length;
    }

    const durationMs = (startTs && endTs && startTs !== endTs)
        ? new Date(endTs).getTime() - new Date(startTs).getTime()
        : null;

    // self_review lives on the Scroll itself (validated + persisted by fairy.js).
    const selfReview = scroll && scroll.self_review ? scroll.self_review : null;

    return {
        charmId,
        runFile,
        quest,
        charm,
        notebookPath,
        scroll,
        selfReview,
        verdict,
        turnTrace,
        cost: { llmTurns: totalLlmTurns, toolTurns: totalToolTurns, durationMs },
        timestamp: startTs,
    };
}

/**
 * Extract all charm examples from a telemetry directory.
 * @param {string} telemetryDir - Path to `.oberon/telemetry/runs/`
 * @returns {Promise<object[]>}
 */
async function extractExamples(telemetryDir) {
    const runs = readRunFiles(telemetryDir);
    const examples = [];
    for (const { file, events } of runs) {
        const byCharm = groupByCharm(events);
        for (const [charmId, charmEvents] of byCharm) {
            const ex = buildExample(charmId, charmEvents, file);
            if (ex.scroll || ex.verdict || ex.charm) examples.push(ex);
        }
    }
    // Sort newest first.
    examples.sort((a, b) => {
        const ta = a.timestamp || '';
        const tb = b.timestamp || '';
        return ta < tb ? 1 : ta > tb ? -1 : 0;
    });
    return examples;
}

/**
 * Load the N best examples (by confidence), sorted highest-first.
 * @param {string} telemetryDir
 * @param {{ limit?: number, minConfidence?: number }} opts
 */
async function loadBestExamples(telemetryDir, { limit = 10, minConfidence = 0 } = {}) {
    const all = await extractExamples(telemetryDir);
    return all
        .filter(ex => {
            const conf = ex.scroll && typeof ex.scroll.confidence === 'number'
                ? ex.scroll.confidence : 0;
            return conf >= minConfidence;
        })
        .sort((a, b) => {
            const ca = (a.scroll && a.scroll.confidence) || 0;
            const cb = (b.scroll && b.scroll.confidence) || 0;
            return cb - ca;
        })
        .slice(0, limit);
}

/**
 * Compact one-line summary for display/logging.
 */
function summariseExample(ex) {
    const questTitle = (ex.quest && (ex.quest.title || ex.quest.id)) || '?';
    const charmTitle = (ex.charm && (ex.charm.title || ex.charm.goal || ex.charmId)) || ex.charmId;
    const conf  = ex.scroll && typeof ex.scroll.confidence === 'number'
        ? ex.scroll.confidence.toFixed(2) : '?';
    const v     = ex.verdict ? ex.verdict.verdict : 'no-verdict';
    const turns = ex.cost.llmTurns || '?';
    const dur   = ex.cost.durationMs != null ? `${Math.round(ex.cost.durationMs / 1000)}s` : '?';
    return `[${ex.runFile}] ${questTitle} / ${charmTitle} — conf=${conf} ${v} turns=${turns} ${dur}`;
}

module.exports = { extractExamples, loadBestExamples, summariseExample };
