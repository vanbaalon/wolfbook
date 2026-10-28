'use strict';

const path = require('node:path');

/** Only the newest completed diagnostics for the current source revision. */
function currentErrors(st) {
    if (!st) return [];
    const revision = st.sourceRevision || 0;
    const completed = [st.compileDiagnostics, st.liveDiagnostics]
        .filter(d => d && d.revision === revision)
        .sort((a, b) => (b.sequence || 0) - (a.sequence || 0) || b.at - a.at);
    const list = completed.length ? completed[0].list
        : !st.sourceAhead ? st.generation?.diagnostics : [];
    return (list || []).filter(d => d.severity === 'error');
}

function location(map, file, line) {
    if (!map || !line) return null;
    try {
        if (map.diagnosticLocation) return map.diagnosticLocation(file, line);
        const hit = map.sourceToRender(file, line);
        const rects = (hit?.boxes || []).map(r => ({ page:r.page, x:r.xBp, y:r.yTopBp, w:r.wBp, h:r.hBp }));
        return rects.length ? { rects, exact:!!hit.exact, matchedLine:hit.matchedLine } : null;
    } catch (_) { return null; }
}

/** No map reads or worker requests on the typing path: use indexed geometry. */
function errorAnnotations(st, { root, map, mapCurrent = true, liveMap, livePage = () => false } = {}) {
    const items = new Map();
    for (const d of currentErrors(st)) {
        const file = d.file ? path.resolve(path.dirname(root), d.file) : root;
        const line = Number.isInteger(d.line) && d.line > 0 ? d.line : null;
        const key = `${file}:${line || ''}`;
        let item = items.get(key);
        if (!item) {
            let hit = location(liveMap, file, line);
            if (hit && !livePage(hit.rects[0]?.page)) hit = null;
            const fromLive = !!hit;
            hit ||= location(map, file, line);
            const rects = (hit?.rects || []).filter(r => Number.isInteger(r.page) && r.page > 0 &&
                [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w >= 0 && r.h >= 0);
            const anchor = rects[0] || null;
            item = { id:key, file, name:path.basename(file), line,
                page:anchor?.page || (Number.isInteger(d.page) && d.page > 0 ? d.page : null),
                rects:anchor ? rects.filter(r => r.page === anchor.page) : [],
                exact:!!anchor && !!hit.exact && (fromLive || mapCurrent && !st.sourceAhead),
                matchedLine:hit?.matchedLine || null, messages:[] };
            items.set(key, item);
        }
        if (d.message && !item.messages.includes(d.message)) item.messages.push(d.message);
    }
    return [...items.values()];
}

module.exports = { currentErrors, errorAnnotations };
