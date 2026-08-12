#!/usr/bin/env node
'use strict';
/**
 * Standalone unit test for wolfslide_editSlide pre-flight guard and _mergeBlocks.
 * Run: node test-wolfslide-editslide.js
 */

// ─── Extracted logic (mirrors wolfslide-tools.js exactly) ──────────────────

function _mergeBlocks(existing, incoming) {
    if (!Array.isArray(incoming)) return incoming;
    const existingById = (existing || []).reduce((m, b) => { if (b?.id) m[b.id] = b; return m; }, {});
    return incoming.map(b => {
        if (!b || !b.id) return b;
        return existingById[b.id] || b; // stub → full existing block; unknown id → passthrough
    });
}

function runPreFlight(patch) {
    const arrKeys = ['children', 'items', 'elements'];
    const hasChildrenInPatch = arrKeys.some(k => Array.isArray(patch[k]));
    if (!hasChildrenInPatch) return { ok: true };

    const offenders = [];
    for (const key of arrKeys) {
        if (!Array.isArray(patch[key])) continue;
        for (const b of patch[key]) {
            if (b && typeof b === 'object' && b.id && Object.keys(b).length > 1) {
                offenders.push({ id: b.id, extraKeys: Object.keys(b).filter(k => k !== 'id') });
            }
        }
    }
    if (offenders.length > 0) {
        return {
            ok: false,
            error: `ERROR: wolfslide_editSlide children array is for STRUCTURAL layout only.\n` +
                   `${offenders.length} block(s) carry extra fields: ` +
                   offenders.map(o => `id="${o.id}" (${o.extraKeys.join(', ')})`).join('; '),
            offenders,
        };
    }
    return { ok: true };
}

// ─── Test harness ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
    if (condition) {
        console.log(`  ✓ ${name}`);
        passed++;
    } else {
        console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
        failed++;
    }
}

// ─── Pre-flight tests ───────────────────────────────────────────────────────

console.log('\nPRE-FLIGHT GUARD');

{
    // no children in patch → always ok
    const r = runPreFlight({ label: 'New label' });
    assert('no children array → ok', r.ok);
}

{
    // pure id-only stubs → ok
    const r = runPreFlight({ children: [{ id: 'a' }, { id: 'b' }] });
    assert('id-only stubs → ok', r.ok);
}

{
    // one entry has extra field → rejected
    const r = runPreFlight({ children: [{ id: 'a' }, { id: 'b', style: { color: 'red' } }] });
    assert('id+style → rejected', !r.ok);
    assert('offender id is b', r.offenders?.length === 1 && r.offenders[0].id === 'b');
    assert('extra key reported as "style"', r.offenders[0].extraKeys.includes('style'));
}

{
    // entry with id+type → rejected (type is an extra field too)
    const r = runPreFlight({ children: [{ id: 'x', type: 'container', children: [] }] });
    assert('id+type → rejected', !r.ok);
    assert('extra keys include type and children',
        r.offenders[0].extraKeys.includes('type') && r.offenders[0].extraKeys.includes('children'));
}

{
    // multiple offenders across items and children
    const r = runPreFlight({
        children: [{ id: 'a', offset: { x: 0 } }],
        items:    [{ id: 'b', content: 'hello' }],
    });
    assert('two offenders across children+items', r.offenders?.length === 2);
}

{
    // entry with no id → not an offender (it's a new block without id, allowed)
    const r = runPreFlight({ children: [{ type: 'text', content: 'hi' }] });
    assert('entry without id → ok (new block)', r.ok);
}

{
    // empty array → ok
    const r = runPreFlight({ children: [] });
    assert('empty children array → ok', r.ok);
}

// ─── _mergeBlocks tests ─────────────────────────────────────────────────────

console.log('\n_mergeBlocks');

const existing = [
    { id: 'row1', type: 'container', layout: 'row', children: [{ id: 'c1', type: 'text' }] },
    { id: 'img1', type: 'image', src: 'photo.png', alt: 'A photo' },
];

{
    // id-only stub → resolved to full existing block
    const result = _mergeBlocks(existing, [{ id: 'row1' }]);
    assert('id-only stub resolves to full existing block', result[0] === existing[0]);
    assert('full block type preserved', result[0].type === 'container');
    assert('nested children preserved', result[0].children?.length === 1);
}

{
    // reorder: flip the two blocks
    const result = _mergeBlocks(existing, [{ id: 'img1' }, { id: 'row1' }]);
    assert('reorder: first element is img1', result[0].id === 'img1');
    assert('reorder: second element is row1', result[1].id === 'row1');
}

{
    // unknown id → passthrough as-is (the block itself returned)
    const stub = { id: 'nonexistent' };
    const result = _mergeBlocks(existing, [stub]);
    assert('unknown id → passthrough stub', result[0] === stub);
}

{
    // non-array incoming → returned as-is
    const result = _mergeBlocks(existing, null);
    assert('null incoming → null', result === null);
    const result2 = _mergeBlocks(existing, 'string');
    assert('string incoming → string', result2 === 'string');
}

{
    // null/undefined entry in array → returned as-is
    const result = _mergeBlocks(existing, [null, undefined, { id: 'row1' }]);
    assert('null entry preserved', result[0] === null);
    assert('undefined entry preserved', result[1] === undefined);
    assert('valid stub after nulls resolves', result[2] === existing[0]);
}

{
    // existing is empty/null → unknown id passthrough
    const stub = { id: 'x' };
    const r1 = _mergeBlocks([], [stub]);
    const r2 = _mergeBlocks(null, [stub]);
    assert('empty existing → passthrough', r1[0] === stub);
    assert('null existing → passthrough', r2[0] === stub);
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
