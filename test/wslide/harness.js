#!/usr/bin/env node
'use strict';
/* ============================================================================
 * Wolfslide regression harness (WSLIDE_IMPLEMENTATION_PLAN.md — Phase 0)
 *
 * Three dependency-free safety nets that enforce "existing decks still render
 * and round-trip correctly" before any data-facing change ships:
 *
 *   1. SCHEMA LINT       — structural validation of every corpus deck.
 *   2. ROUND-TRIP DIFF   — parse→serialize→parse→serialize must be byte-stable
 *                          (catches accidental key drop/reorder in the data layer).
 *   3. RENDER SNAPSHOT   — per-slide exported HTML must be byte-identical to a
 *                          committed golden baseline (a deterministic, debuggable
 *                          proxy for pixel diff; uses the real slideExporter, the
 *                          same renderer used for HTML/PDF export).
 *
 * An optional Chrome pixel tier (pixel.js) is detected and skipped if absent, so
 * this harness runs everywhere with zero npm installs.
 *
 * Usage:
 *   node test/wslide/harness.js lint        # schema lint only
 *   node test/wslide/harness.js roundtrip   # round-trip stability only
 *   node test/wslide/harness.js golden      # (re)capture render baselines
 *   node test/wslide/harness.js check       # lint + roundtrip + render-diff (CI gate)
 *
 * Corpus = every *.wslide under  test/wslide/fixtures/  and  test/wslide/corpus/.
 * Drop real decks into  test/wslide/corpus/  to widen coverage.
 * ========================================================================== */

const fs   = require('fs');
const path = require('path');

const ROOT        = __dirname;
const FIXTURE_DIR = path.join(ROOT, 'fixtures');
const CORPUS_DIR  = path.join(ROOT, 'corpus');
const GOLDEN_DIR  = path.join(ROOT, 'golden');
const EXPORTER    = path.resolve(ROOT, '../../out/extension/slideExporter');

// ── ANSI helpers ────────────────────────────────────────────────────────────
const c = {
  red:   s => `\x1b[31m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow:s => `\x1b[33m${s}\x1b[0m`,
  dim:   s => `\x1b[2m${s}\x1b[0m`,
  bold:  s => `\x1b[1m${s}\x1b[0m`,
};

// ── Deck parse — mirrors slideEditorProvider._parseDeck (incl. elements→children) ──
function parseDeck(text) {
  try {
    const d = JSON.parse(text || '{}');
    if (!d.slides)        d.slides = [];
    if (!d.meta)          d.meta = { title: 'Untitled' };
    if (!d.theme)         d.theme = {};
    if (!d.formatVersion) d.formatVersion = 2;
    function norm(node) {
      if (!node) return;
      if (Array.isArray(node.elements) && !node.children) { node.children = node.elements; delete node.elements; }
      (node.children || []).forEach(norm);
      (node.items    || []).forEach(norm);
    }
    d.slides.forEach(s => {
      if (Array.isArray(s.elements) && !s.children) { s.children = s.elements; delete s.elements; }
      (s.children || []).forEach(norm);
    });
    if (d.formatVersion < 3) d.formatVersion = 3;
    return d;
  } catch (_) {
    return { formatVersion: 3, meta: { title: 'Untitled' }, theme: {}, slides: [] };
  }
}

// ── Serialize — mirrors the provider replacer exactly (strips _-keys, indent 2) ──
function serializeDeck(deck) {
  return JSON.stringify(deck, (k, v) => (k.startsWith('_') ? undefined : v), 2);
}

function maxFrag(slide) {
  let m = 0;
  (function walk(n) {
    (n.children || []).forEach(b => { if ((b.fragmentOrder || 0) > m) m = b.fragmentOrder; walk(b); });
    (n.items    || []).forEach(b => { if ((b.fragmentOrder || 0) > m) m = b.fragmentOrder; walk(b); });
  })(slide);
  return m;
}

// ── Corpus discovery ──────────────────────────────────────────────────────────
function findDecks() {
  const out = [];
  for (const dir of [FIXTURE_DIR, CORPUS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    (function walk(d) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { if (ent.name !== 'img') walk(p); }
        else if (ent.name.endsWith('.wslide')) out.push(p);
      }
    })(dir);
  }
  return out.sort();
}

function deckKey(deckPath) {
  // Stable, collision-free golden filename: <relpath with / → __>
  const rel = path.relative(ROOT, deckPath).replace(/[\\/]/g, '__').replace(/\.wslide$/, '');
  return rel;
}

// ── Schema lint ───────────────────────────────────────────────────────────────
function lintDeck(deck, name) {
  const errs = [];
  if (!Array.isArray(deck.slides)) { errs.push('deck.slides is not an array'); return errs; }
  const ids = new Map(); // id → count
  const presetNames = new Set(Object.keys(deck.stylePresets || {}));

  // `children` entries are full blocks (require id+type). `items` entries are list
  // entries (content + optional nested children) — NOT blocks, so id/type are not
  // required; we only validate their shape and recurse into any nested children.
  function walk(node, where) {
    for (const key of ['children', 'items']) {
      if (node[key] == null) continue;
      if (!Array.isArray(node[key])) { errs.push(`${where}.${key} is not an array`); continue; }
      const isBlockArray = key === 'children';
      node[key].forEach((b, i) => {
        const loc = `${where}.${key}[${i}]`;
        if (b == null || typeof b !== 'object') { errs.push(`${loc} is not an object`); return; }
        if (b.id != null) ids.set(b.id, (ids.get(b.id) || 0) + 1);
        if (isBlockArray) {
          if (!b.id)   errs.push(`${loc} missing "id"`);
          if (!b.type) errs.push(`${loc} (id ${b.id || '?'}) missing "type"`);
        }
        if (b.stylePreset && !presetNames.has(b.stylePreset))
          errs.push(`${loc} references unknown stylePreset "${b.stylePreset}"`);
        if (b.style != null && (typeof b.style !== 'object' || Array.isArray(b.style)))
          errs.push(`${loc} "style" must be an object`);
        walk(b, loc);
      });
    }
  }

  deck.slides.forEach((s, i) => {
    const loc = `slide[${i}]`;
    if ('blocks' in s) errs.push(`${loc} uses legacy "blocks" key — model key is "children"`);
    if (s.children != null && !Array.isArray(s.children)) errs.push(`${loc}.children is not an array`);
    walk(s, loc);
  });

  for (const [id, n] of ids) if (n > 1) errs.push(`duplicate block id "${id}" (${n}×)`);
  return errs;
}

// ── Render snapshot (per-slide exported HTML, final fragment state) ────────────
function loadExporter() {
  try { return require(EXPORTER); }
  catch (e) { return { _error: e.message }; }
}

function renderDeckHtml(exporter, deck, deckDir) {
  const parts = [];
  deck.slides.forEach((slide, i) => {
    let html;
    try { html = exporter.exportSlideStepHtml(slide, maxFrag(slide), deck, deckDir); }
    catch (e) { html = `__RENDER_ERROR__ ${e.message}`; }
    parts.push(`<!-- ===== slide ${i} ===== -->\n${html}`);
  });
  return parts.join('\n');
}

// ── Minimal line diff (dependency-free) ───────────────────────────────────────
function firstDiff(a, b, ctx = 2, maxLines = 12) {
  const la = a.split('\n'), lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  let i = 0;
  while (i < n && la[i] === lb[i]) i++;
  if (i >= n) return null;
  const out = [];
  for (let j = Math.max(0, i - ctx); j < Math.min(n, i + maxLines); j++) {
    if (la[j] === lb[j]) out.push(c.dim(`  ${j + 1}  ${la[j] ?? ''}`));
    else {
      if (la[j] !== undefined) out.push(c.red(`- ${j + 1}  ${la[j]}`));
      if (lb[j] !== undefined) out.push(c.green(`+ ${j + 1}  ${lb[j]}`));
    }
  }
  return out.join('\n');
}

// ── Modes ─────────────────────────────────────────────────────────────────────
function runLint(decks) {
  let fail = 0;
  for (const p of decks) {
    const errs = lintDeck(parseDeck(fs.readFileSync(p, 'utf8')), deckKey(p));
    if (errs.length) { fail++; console.log(c.red(`✗ ${path.relative(ROOT, p)}`)); errs.forEach(e => console.log(`    ${e}`)); }
    else console.log(c.green(`✓ ${path.relative(ROOT, p)}`));
  }
  return fail;
}

function runRoundtrip(decks) {
  let fail = 0;
  for (const p of decks) {
    const text = fs.readFileSync(p, 'utf8');
    const a = serializeDeck(parseDeck(text));
    const b = serializeDeck(parseDeck(a));
    if (a !== b) { fail++; console.log(c.red(`✗ ${path.relative(ROOT, p)} — serialization not stable`)); console.log(firstDiff(a, b)); }
    else console.log(c.green(`✓ ${path.relative(ROOT, p)}`));
  }
  return fail;
}

function runGolden(decks) {
  const exporter = loadExporter();
  if (exporter._error) { console.log(c.red(`Cannot load slideExporter: ${exporter._error}`)); return 1; }
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  for (const p of decks) {
    const deck = parseDeck(fs.readFileSync(p, 'utf8'));
    const key  = deckKey(p);
    fs.writeFileSync(path.join(GOLDEN_DIR, key + '.html'), renderDeckHtml(exporter, deck, path.dirname(p)), 'utf8');
    fs.writeFileSync(path.join(GOLDEN_DIR, key + '.canonical.json'), serializeDeck(deck), 'utf8');
    console.log(c.green(`captured ${key}`));
  }
  console.log(c.bold(`\nGolden baselines written to ${path.relative(process.cwd(), GOLDEN_DIR)}/`));
  return 0;
}

function runCheck(decks) {
  let fail = 0;
  console.log(c.bold('\n[1/3] Schema lint')); fail += runLint(decks);
  console.log(c.bold('\n[2/3] Round-trip stability')); fail += runRoundtrip(decks);

  console.log(c.bold('\n[3/3] Render snapshot diff'));
  const exporter = loadExporter();
  if (exporter._error) { console.log(c.red(`  Cannot load slideExporter: ${exporter._error}`)); return fail + 1; }
  for (const p of decks) {
    const key  = deckKey(p);
    const goldHtml = path.join(GOLDEN_DIR, key + '.html');
    if (!fs.existsSync(goldHtml)) { console.log(c.yellow(`⚠ ${path.relative(ROOT, p)} — no baseline (run "golden")`)); continue; }
    const deck    = parseDeck(fs.readFileSync(p, 'utf8'));
    const current = renderDeckHtml(exporter, deck, path.dirname(p));
    const golden  = fs.readFileSync(goldHtml, 'utf8');
    if (current.includes('__RENDER_ERROR__')) { fail++; console.log(c.red(`✗ ${path.relative(ROOT, p)} — render error`)); }
    else if (current !== golden) { fail++; console.log(c.red(`✗ ${path.relative(ROOT, p)} — render output changed`)); console.log(firstDiff(golden, current)); }
    else console.log(c.green(`✓ ${path.relative(ROOT, p)}`));
  }
  return fail;
}

// ── Entry ─────────────────────────────────────────────────────────────────────
function main() {
  const mode  = process.argv[2] || 'check';
  const decks = findDecks();
  if (!decks.length) { console.log(c.yellow('No .wslide decks found in fixtures/ or corpus/.')); process.exit(1); }
  console.log(c.dim(`Corpus: ${decks.length} deck(s)`));

  let fail = 0;
  switch (mode) {
    case 'lint':      fail = runLint(decks); break;
    case 'roundtrip': fail = runRoundtrip(decks); break;
    case 'golden':    fail = runGolden(decks); break;
    case 'check':     fail = runCheck(decks); break;
    default: console.log(`Unknown mode "${mode}". Use: lint | roundtrip | golden | check`); process.exit(2);
  }

  if (mode !== 'golden') {
    console.log('');
    if (fail) { console.log(c.red(c.bold(`FAILED — ${fail} issue(s).`))); process.exit(1); }
    console.log(c.green(c.bold('PASSED.')));
  }
}

main();
