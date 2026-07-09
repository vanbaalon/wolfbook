#!/usr/bin/env node
'use strict';
/**
 * wslide-lint.js — standalone validator for .wslide deck files
 * Usage:  node wslide-lint.js path/to/deck.wslide [path2.wslide ...]
 * Exit code 0 = clean, 1 = issues found, 2 = parse error
 */
const fs   = require('fs');
const path = require('path');

const VALID_TYPES = new Set(['container','heading','text','image','list','math','box','raw','code','arrow','eval']);

function collectAllBlocks(node) {
    const result = [];
    function walk(b) {
        if (!b || typeof b !== 'object') return;
        if (b.type) result.push(b);
        (b.children || b.items || b.elements || []).forEach(walk);
    }
    (node.children || node.elements || []).forEach(walk);
    return result;
}

function lintDeck(filePath) {
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch (e) { return { file: filePath, parseError: `Cannot read: ${e.message}` }; }

    let deck;
    try { deck = JSON.parse(raw); }
    catch (e) { return { file: filePath, parseError: `JSON parse error: ${e.message}` }; }

    const issues = [];
    const slides = deck.slides || [];

    // ── Duplicate block IDs ──────────────────────────────────────────────────
    const idMap = new Map(); // id → [slide numbers]
    slides.forEach((s, i) => {
        collectAllBlocks(s).forEach(b => {
            if (!b.id) return;
            if (!idMap.has(b.id)) idMap.set(b.id, []);
            idMap.get(b.id).push(i + 1);
        });
    });
    idMap.forEach((slideNums, id) => {
        if (slideNums.length > 1) {
            issues.push({ severity: 'ERROR', slide: slideNums.join(','), issue: 'duplicate_block_id',
                detail: `id="${id}" appears on slides [${slideNums.join(', ')}] — patchBlock always hits first` });
        }
    });

    // ── Per-slide checks ─────────────────────────────────────────────────────
    const labelMap = {};
    slides.forEach((s, i) => {
        const sn = i + 1;
        const allBlocks = collectAllBlocks(s);
        const topBlocks = s.children || s.elements || [];

        // Empty slide
        if (topBlocks.length === 0) {
            issues.push({ severity: 'WARN', slide: sn, issue: 'empty_slide', detail: 'no children' });
        }

        // Missing background
        if (!s.background) {
            issues.push({ severity: 'WARN', slide: sn, issue: 'no_background',
                detail: `slide "${s.label||s.id}" has no background — will render transparent` });
        }

        // Unknown or missing block types
        allBlocks.forEach(b => {
            if (!b.type) {
                issues.push({ severity: 'ERROR', slide: sn, blockId: b.id || '?', issue: 'missing_type',
                    detail: `block id="${b.id||'?'}" has no type` });
            } else if (!VALID_TYPES.has(b.type)) {
                issues.push({ severity: 'ERROR', slide: sn, blockId: b.id || '?', issue: 'unknown_type',
                    detail: `block id="${b.id||'?'}" has unknown type "${b.type}"` });
            }
        });

        // Images without alt text
        allBlocks.filter(b => b.type === 'image' && !b.alt).forEach(b => {
            issues.push({ severity: 'WARN', slide: sn, blockId: b.id || '?', issue: 'no_alt_text',
                detail: `image block id="${b.id||'?'}" has no alt text` });
        });

        // Fragment gaps
        const frags = allBlocks
            .filter(b => b.fragmentOrder != null && b.fragmentOrder >= 1)
            .map(b => b.fragmentOrder)
            .sort((a, b) => a - b);
        if (frags.length > 0) {
            const max = frags[frags.length - 1];
            const missing = [];
            for (let f = 1; f <= max; f++) if (!frags.includes(f)) missing.push(f);
            if (missing.length) {
                issues.push({ severity: 'WARN', slide: sn, issue: 'fragment_gap',
                    detail: `fragment steps ${missing.join(', ')} are missing (present: ${[...new Set(frags)].join(',')})` });
            }
        }

        // Duplicate labels
        const lbl = (s.label || '').trim();
        if (lbl) {
            if (!labelMap[lbl]) labelMap[lbl] = [];
            labelMap[lbl].push(sn);
        }
    });

    // Duplicate labels (cross-slide)
    Object.entries(labelMap).forEach(([lbl, nums]) => {
        if (nums.length > 1) {
            issues.push({ severity: 'WARN', slide: nums.join(','), issue: 'duplicate_label',
                detail: `label "${lbl}" used on slides [${nums.join(', ')}]` });
        }
    });

    return { file: filePath, slideCount: slides.length, issues };
}

// ── CLI entry point ──────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
if (args.length === 0) {
    console.error('Usage: node wslide-lint.js <file.wslide> [file2.wslide ...]');
    process.exit(2);
}

let anyIssues = false;
for (const arg of args) {
    const result = lintDeck(arg);
    if (result.parseError) {
        console.error(`\n${path.basename(result.file)}: PARSE ERROR — ${result.parseError}`);
        anyIssues = true;
        continue;
    }
    const errors   = result.issues.filter(i => i.severity === 'ERROR');
    const warnings = result.issues.filter(i => i.severity === 'WARN');
    const status   = errors.length ? '✗ ERRORS' : (warnings.length ? '⚠ WARNINGS' : '✓ OK');
    console.log(`\n${path.basename(result.file)}  [${result.slideCount} slides]  ${status}`);
    if (result.issues.length === 0) {
        console.log('  No issues found.');
    } else {
        result.issues.forEach(iss => {
            const loc = iss.slide ? `slide ${iss.slide}` : 'deck';
            const bid = iss.blockId ? ` block:${iss.blockId}` : '';
            console.log(`  [${iss.severity}] ${loc}${bid} — ${iss.detail}`);
        });
    }
    if (result.issues.some(i => i.severity === 'ERROR')) anyIssues = true;
}

process.exit(anyIssues ? 1 : 0);
