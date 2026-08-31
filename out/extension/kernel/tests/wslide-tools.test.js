'use strict';

// Headless tests that drive the real wolfslide tool handlers against a fake
// slide-editor provider.
//
//   node out/extension/kernel/tests/wslide-tools.test.js
//
// Field report #2 listed "patchBlock ambiguity → error" as UNVERIFIED: the
// author had been passing slideIndex habitually since the incident, so the case
// was never re-triggered by hand. That is exactly what a test is for.

const assert = require('assert');
const Module = require('module');
const { makeVscodeStub } = require('./_stub-vscode');

// Tests run SEQUENTIALLY: they share one mutable `provider`, so letting async
// bodies interleave would have each one clobbering the next's fixture.
let pass = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
function section(name) { queue.push({ section: name }); }
async function runQueue() {
    for (const item of queue) {
        if (item.section) { console.log(item.section); continue; }
        try { await item.fn(); pass++; console.log(`  ✓ ${item.name}`); }
        catch (e) { console.error(`  ✗ ${item.name}\n    ${e.message}`); process.exitCode = 1; }
    }
    console.log(`\n${pass} assertions passed`);
}

// ── Fake provider ─────────────────────────────────────────────────────────

function makeDeck() {
    return {
        slides: [
            { id: 's16', label: 'Sixteen', children: [
                { id: 'left_col', type: 'container', layout: 'column', children: [
                    { id: 's16_text', type: 'text', content: 'sixteen' },
                ] },
            ] },
            { id: 's20', label: 'Twenty', children: [
                { id: 'left_col', type: 'container', layout: 'column', children: [
                    { id: 's20_text', type: 'text', content: 'twenty' },
                ] },
            ] },
            { id: 's21', label: 'Unique', children: [
                { id: 'only_here', type: 'text', content: 'unique' },
                { id: 'pic', type: 'image', src: 'img/x.png', w: 50, h: 481 },
            ] },
        ],
    };
}

function makeProvider(deck, opts = {}) {
    return {
        _deck: deck,
        currentSlideIndex: opts.visible ?? 0,
        applied: 0,
        getDeck() { return JSON.parse(JSON.stringify(this._deck)); },
        getDeckDir() { return opts.deckDir || null; },
        getScope() { return null; },
        noteScopeShown() { return 99; },
        getActiveEntry() { return { currentSlideIndex: this.currentSlideIndex }; },
        _panels: new Map(),
        async applyDeck(d) { this._deck = d; this.applied++; },
        // No live webview: measurement rejects, exercising the static-lint
        // fallback path that every mutation footer depends on.
        async measureSlide() { throw new Error('No active .wslide editor found'); },
    };
}

let provider = null;
const tools = (() => {
    const orig = Module._load;
    Module._load = function (req, ...rest) {
        if (req === 'vscode') return makeVscodeStub();
        return orig.call(this, req, ...rest);
    };
    try {
        const mod = require('../../tools/wolfslide-tools');
        // Redirect the module's provider lookup at the fake.
        const sep = require('../../slideEditorProvider');
        sep.SlideEditorProvider = { getInstance: () => provider };
        return mod;
    } finally { Module._load = orig; }
})();

const text = res => res.content.map(c => c.value).join('');
const call = (Tool, input) => new Tool().invoke({ input }, {});

// ── patchBlock ambiguity ──────────────────────────────────────────────────

section('patchBlock — ambiguous blockId must ERROR, not guess');

t('a blockId on two slides errors and lists both candidates', async () => {
    provider = makeProvider(makeDeck(), { visible: 0 });
    const out = text(await call(tools.WolfslidePatchBlockTool,
        { blockId: 'left_col', patch: { style: { fontSize: '0.88em' } } }));
    assert.ok(/Ambiguous/.test(out), `expected an ambiguity error, got:\n${out}`);
    assert.ok(/slide 1/.test(out) && /slide 2/.test(out), `both candidates must be listed:\n${out}`);
    assert.ok(/slideIndex/.test(out), 'must say how to disambiguate');
    assert.strictEqual(provider.applied, 0, 'NOTHING may be written on an ambiguous reference');
});

t('the ambiguous case does not silently edit the visible slide', async () => {
    // The original bug: the resolver preferred whichever slide was on screen,
    // so the same call edited a different block depending on the cursor.
    for (const visible of [0, 1]) {
        provider = makeProvider(makeDeck(), { visible });
        await call(tools.WolfslidePatchBlockTool,
            { blockId: 'left_col', patch: { style: { fontSize: '0.5em' } } });
        const touched = provider._deck.slides.some(s =>
            s.children.some(b => b.style && b.style.fontSize));
        assert.ok(!touched, `visible=${visible}: a block was modified despite the ambiguity`);
    }
});

t('the SAME call with slideIndex resolves and writes exactly one slide', async () => {
    provider = makeProvider(makeDeck(), { visible: 0 });
    const out = text(await call(tools.WolfslidePatchBlockTool,
        { blockId: 'left_col', slideIndex: 2, patch: { style: { fontSize: '0.88em' } } }));
    assert.ok(!/Ambiguous/.test(out), out);
    assert.strictEqual(provider._deck.slides[1].children[0].style.fontSize, '0.88em');
    assert.strictEqual(provider._deck.slides[0].children[0].style, undefined,
        'slide 1 must be untouched');
});

t('an unambiguous blockId still resolves without slideIndex', async () => {
    provider = makeProvider(makeDeck(), { visible: 0 });
    const out = text(await call(tools.WolfslidePatchBlockTool,
        { blockId: 'only_here', patch: { content: 'changed' } }));
    assert.ok(/updated on slide 3/.test(out), out);
    assert.strictEqual(provider._deck.slides[2].children[0].content, 'changed');
});

t('a blockId that exists nowhere reports that, not an ambiguity', async () => {
    provider = makeProvider(makeDeck(), { visible: 0 });
    const out = text(await call(tools.WolfslidePatchBlockTool,
        { blockId: 'nope', patch: { content: 'x' } }));
    assert.ok(/not found in any slide/.test(out), out);
});

// ── read-back ─────────────────────────────────────────────────────────────

section('mutation responses');

t('a successful patch reports the deck length read back', async () => {
    provider = makeProvider(makeDeck(), { visible: 0 });
    const out = text(await call(tools.WolfslidePatchBlockTool,
        { blockId: 'only_here', patch: { content: 'x' } }));
    assert.ok(/Deck: 3 slides\./.test(out), out);
});

t('a patch whose block vanishes from the deck is NOT reported as success', async () => {
    // Simulates the phantom write: a racing editor autosave lands after the
    // tool's own, reverting the deck to a state without the block.
    provider = makeProvider(makeDeck(), { visible: 0 });
    provider.applyDeck = async function () {
        const reverted = makeDeck();
        reverted.slides[2].children = reverted.slides[2].children.filter(b => b.id !== 'only_here');
        this._deck = reverted; this.applied++;
    };
    const out = text(await call(tools.WolfslidePatchBlockTool,
        { blockId: 'only_here', patch: { content: 'x' } }));
    assert.ok(/WRITE NOT CONFIRMED/.test(out), `a lost patch must not read as success:\n${out}`);
    assert.ok(/only_here/.test(out) && /is NOT in the deck/.test(out), out);
});

t('an insert whose slide vanishes is reported loudly', async () => {
    provider = makeProvider(makeDeck(), { visible: 0 });
    provider.applyDeck = async function () { this.applied++; /* drop the write */ };
    const out = text(await call(tools.WolfslideInsertSlideTool,
        { slide: { id: 'ghost', label: 'New', children: [] } }));
    assert.ok(/WRITE NOT CONFIRMED/.test(out), `a lost insert must not read as success:\n${out}`);
    assert.ok(/ghost/.test(out), out);
    assert.ok(/do NOT assume this succeeded/i.test(out), out);
});

// ── lints ride the mutation response ──────────────────────────────────────

section('lints on mutation responses');

t('a \\color switch introduced by a patch is reported on that response', async () => {
    provider = makeProvider(makeDeck(), { visible: 0 });
    const out = text(await call(tools.WolfslidePatchBlockTool, {
        blockId: 'only_here',
        patch: { content: 'BFKL: $\\color{#008800}{-\\frac{\\pi^2}{3}}-\\frac{10}{9}\\frac{n_f}{N_c}$' },
    }));
    assert.ok(/color_switch/.test(out), `the switch must be caught at write time:\n${out}`);
    assert.ok(/n_f/.test(out), 'the bleed must be named');
    assert.ok(/textcolor/.test(out), 'the fix must be offered');
});

t('lints still report when no editor is rendering', async () => {
    // measureSlide rejects in this fake, so this exercises the static fallback:
    // a \color switch corrupts the slide whether or not anything is rendering.
    provider = makeProvider(makeDeck(), { visible: 0 });
    const out = text(await call(tools.WolfslidePatchBlockTool,
        { blockId: 'only_here', patch: { content: '$\\color{red}{a}b$' } }));
    assert.ok(/color_switch/.test(out), out);
});

t('clean content produces no lint noise', async () => {
    provider = makeProvider(makeDeck(), { visible: 0 });
    const out = text(await call(tools.WolfslidePatchBlockTool,
        { blockId: 'only_here', patch: { content: 'plain $x^2$ text' } }));
    assert.ok(!/color_switch|🔴/.test(out), out);
});

// ── searchSlides ──────────────────────────────────────────────────────────

section('searchSlides — the grep that keeps work on-tool');

t('regex mode finds arXiv ids and returns block locations', async () => {
    const deck = makeDeck();
    deck.slides[0].children[0].children[0].content = 'cusp [Gromov, arXiv:1510.01085]';
    provider = makeProvider(deck, { visible: 0 });
    const out = text(await call(tools.WolfslideSearchSlidesTool,
        { query: 'arXiv|\\d{4}\\.\\d{4,5}', regex: true }));
    assert.ok(/s16_text/.test(out), `must return the block id:\n${out}`);
    assert.ok(/slideIndex=1/.test(out), out);
});

t('an invalid regex is reported, not thrown', async () => {
    provider = makeProvider(makeDeck(), { visible: 0 });
    const out = text(await call(tools.WolfslideSearchSlidesTool, { query: '([', regex: true }));
    assert.ok(/Invalid regex/.test(out), out);
});

t('searchRaw sees markup that tag-stripping hides', async () => {
    const deck = makeDeck();
    deck.slides[0].children[0].children[0].content = '<div style="color:#0070cc">x</div>';
    provider = makeProvider(deck, { visible: 0 });
    const bare = text(await call(tools.WolfslideSearchSlidesTool, { query: '#0070cc' }));
    assert.ok(/No matches/.test(bare), 'stripped text must not contain the hex');
    const raw = text(await call(tools.WolfslideSearchSlidesTool, { query: '#0070cc', searchRaw: true }));
    assert.ok(/s16_text/.test(raw), raw);
});

// ── getSlide ──────────────────────────────────────────────────────────────

section('getSlide');

t('the raw JSON is omitted by default and available on request', async () => {
    provider = makeProvider(makeDeck(), { visible: 0 });
    const brief = text(await call(tools.WolfslideGetSlideTool, { slideIndex: 1 }));
    assert.ok(/raw JSON omitted/.test(brief), brief.slice(0, 300));
    const full = text(await call(tools.WolfslideGetSlideTool, { slideIndex: 1, brief: false }));
    assert.ok(/## Raw JSON/.test(full));
    assert.ok(full.length > brief.length);
});


runQueue();
