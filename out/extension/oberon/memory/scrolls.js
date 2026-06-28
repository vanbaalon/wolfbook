'use strict';
/**
 * Oberon — Scroll filesystem layout.
 *
 * Scrolls live alongside Charms under each Quest folder:
 *   <workspace>/quests/<id>_<shortName>/
 *     charms/<charmId>.json         (the Charm)
 *     scrolls/<scrollId>.json       (the Scroll(s) produced for that Charm)
 *
 * MVP-2: one Scroll per Charm; ids start at S01 per Quest. If the same Charm
 * is re-attempted (later MVPs) we increment the id within the same folder.
 */

const path   = require('path');
const fsp    = require('fs/promises');
const crypto = require('crypto');
const project = require('./project');

function scrollsDirFor(quest) {
    const root = project.getWorkspaceRoot();
    if (!root) return null;
    return path.join(root, 'quests', `${quest.id}_${quest.shortName}`, 'scrolls');
}

/**
 * Pick the next free Scroll id for a given Quest by scanning its scrolls/.
 * Returns 'S01' when none exist; otherwise increments the highest numeric id.
 *
 * @param {object} quest validated Quest object
 * @returns {Promise<string>}
 */
async function nextScrollId(quest) {
    const dir = scrollsDirFor(quest);
    if (!dir) return 'S01';
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (_) { return 'S01'; }
    let max = 0;
    for (const e of entries) {
        if (!e.isFile()) continue;
        const m = /^S(\d{2,4})\.json$/.exec(e.name);
        if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n > max) max = n;
        }
    }
    return `S${String(max + 1).padStart(2, '0')}`;
}

/**
 * Write a Scroll JSON file under quests/<id>_<short>/scrolls/<scrollId>.json.
 * Returns a FileRef.
 *
 * @param {object} quest  validated Quest
 * @param {object} scroll validated Scroll
 * @returns {Promise<{ path: string, sha256: string }>}
 */
async function writeScroll(quest, scroll) {
    const dir = scrollsDirFor(quest);
    if (!dir) throw new Error('No workspace open; cannot write Scroll.');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${scroll.id}.json`);
    const json = JSON.stringify(scroll, null, 2) + '\n';
    await fsp.writeFile(file, json, 'utf8');
    const sha = 'sha256:' + crypto.createHash('sha256').update(json, 'utf8').digest('hex');
    return { path: file, sha256: sha };
}

module.exports = { scrollsDirFor, nextScrollId, writeScroll };
