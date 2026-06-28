'use strict';
/**
 * Oberon literature — tiny disk-or-memory JSON cache with per-entry TTL (#20).
 *
 * Makes the citation-graph traversals (#4 backward refs, #18 forward citations)
 * affordable to run by default: each references/citations fetch is memoised so retries
 * and redo-runs reuse the graph instead of re-hitting INSPIRE / Semantic Scholar.
 *
 *   - `dir` omitted  → pure in-memory cache (used by tests; nothing touches disk).
 *   - `dir` given    → JSON files under that dir, mirrored in memory.
 *   - failures are NEVER cached; a stale value is served if a refetch throws.
 *   - per-call `ttlHours: Infinity` marks an entry permanent (reference lists never
 *     change), while citation counts default to a 24 h TTL.
 */

const fs = require('fs');
const path = require('path');

function makeCache({ dir = null, ttlHours = 24 } = {}) {
    const mem = new Map();
    let hits = 0, misses = 0, writes = 0;

    const fileFor = (key) => path.join(dir, encodeURIComponent(String(key)).slice(0, 180) + '.json');

    function read(key) {
        if (mem.has(key)) return mem.get(key);
        if (!dir) return undefined;
        try { const o = JSON.parse(fs.readFileSync(fileFor(key), 'utf8')); mem.set(key, o); return o; }
        catch (_) { return undefined; }
    }
    function write(key, entry) {
        mem.set(key, entry);
        if (!dir) return;
        try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fileFor(key), JSON.stringify(entry)); writes++; }
        catch (_) { /* cache is best-effort; never fail the caller */ }
    }
    function fresh(entry, ttlOverride) {
        if (!entry) return false;
        const hrs = (ttlOverride == null ? ttlHours : ttlOverride);
        if (!isFinite(hrs)) return true;            // permanent
        if (hrs <= 0) return false;
        return (Date.now() - entry.ts) <= hrs * 3600 * 1000;
    }

    return {
        /** Return cached value if fresh, else run fetchFn(), store, and return it.
         *  fetchFn errors are not cached; a stale value (if any) is served instead. */
        async getOrFetch(key, fetchFn, { ttlHours: ttlOverride } = {}) {
            const entry = read(key);
            if (fresh(entry, ttlOverride)) { hits++; return entry.value; }
            let value;
            try { value = await fetchFn(); }
            catch (_) { return entry ? entry.value : null; }
            misses++;
            if (value === undefined || value === null) return value;   // don't cache empties as permanent
            write(key, { value, ts: Date.now() });
            return value;
        },
        get(key) { const e = read(key); return e ? e.value : undefined; },
        set(key, value) { write(key, { value, ts: Date.now() }); },
        has(key) { return fresh(read(key), null); },
        stats() { return { hits, misses, writes, size: mem.size }; },
    };
}

module.exports = { makeCache };
