'use strict';
/**
 * Oberon — Quest filesystem layout.
 *
 * Quests live OUTSIDE `.oberon/` (they are agent-readable):
 *   <workspace>/quests/<id>_<shortName>/
 *     quest.json
 *     inputs/    (user-supplied)
 *     artefacts/ (agent-produced)
 *     scrolls/   (Fairy outputs)        [MVP-2+]
 */

const path = require('path');
const fsp  = require('fs/promises');
const crypto = require('crypto');
const project = require('./project');

/**
 * THE canonical quest folder name. Every artefact writer must use this —
 * before it existed, call sites re-derived the name with different fallbacks
 * (`|| quest.id`, `|| 'quest'`, none at all), splitting one quest's artefacts
 * across `Q18_Q18/`, `Q18_undefined/`, and `Q18_quest/`.
 * @param {{ id: string, shortName?: string }} quest
 * @returns {string} e.g. "Q25_su4_xxx_l3_6rep"
 */
function questFolderName(quest) {
    const id = (quest && quest.id) || 'Q00';
    return `${id}_${(quest && quest.shortName) || id}`;
}

function questDirFor(quest) {
    const root = project.getWorkspaceRoot();
    if (!root) return null;
    return path.join(root, 'quests', questFolderName(quest));
}

/**
 * Pick the next free Quest id by scanning the quests/ folder.
 * Returns 'Q01' when none exist; otherwise increments the highest numeric id.
 * @returns {Promise<string>}
 */
async function nextQuestId() {
    const root = project.getWorkspaceRoot();
    if (!root) return 'Q01';
    const qroot = path.join(root, 'quests');
    let entries;
    try { entries = await fsp.readdir(qroot, { withFileTypes: true }); }
    catch (_) { return 'Q01'; }
    let max = 0;
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const m = /^Q(\d{2,4})/.exec(e.name);
        if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n > max) max = n;
        }
    }
    return `Q${String(max + 1).padStart(2, '0')}`;
}

/**
 * Write `quest.json` under quests/<id>_<shortName>/ and ensure the
 * inputs/ and artefacts/ subfolders exist. Returns a FileRef.
 *
 * @param {object} quest validated Quest object
 * @returns {Promise<{path: string, sha256: string}>}
 */
async function writeQuest(quest) {
    const dir = questDirFor(quest);
    if (!dir) throw new Error('No workspace open; cannot write Quest.');
    await fsp.mkdir(path.join(dir, 'inputs'),    { recursive: true });
    await fsp.mkdir(path.join(dir, 'artefacts'), { recursive: true });
    const file = path.join(dir, 'quest.json');
    const json = JSON.stringify(quest, null, 2) + '\n';
    await fsp.writeFile(file, json, 'utf8');
    const sha = 'sha256:' + crypto.createHash('sha256').update(json, 'utf8').digest('hex');

    // Create main.wb — the primary working notebook for this Quest.
    const mainWb = path.join(dir, 'main.wb');
    const initialNotebook = buildInitialNotebook(quest);
    await fsp.writeFile(mainWb, JSON.stringify(initialNotebook, null, 2) + '\n', 'utf8');

    return { path: file, sha256: sha, notebookPath: mainWb };
}

/**
 * Build the initial .wb notebook JSON structure for a new Quest.
 * Returns an empty notebook so Wolfbook opens it cleanly.
 */
function buildInitialNotebook(quest) {
    return {
        cells: [],
        metadata: {},
    };
}

module.exports = { questFolderName, questDirFor, nextQuestId, writeQuest };
