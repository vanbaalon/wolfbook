'use strict';
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const project = require('./project');

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
}
function receiptId(payload) {
    return `sha256:${crypto.createHash('sha256').update(canonical(payload)).digest('hex')}`;
}
async function writeVerificationReceipt({ skillRef, contentHash, environment, assertionSummary, outcome, evidence = {} } = {}) {
    const root = project.getWorkspaceRoot();
    if (!root || !skillRef || !contentHash) return { ok: false, error: 'missing_workspace_or_identity' };
    const payload = {
        schema_version: '1.0', kind: 'wolfbook-local-verification',
        skill_ref: skillRef, content_hash: contentHash,
        issuer: { type: 'local-wolfbook', extension: 'wolfbook.wolfbook' },
        environment: environment || null,
        outcome: outcome || 'observed',
        assertion_summary: assertionSummary || { passed: null, failed: null, note: 'Fairy run delivered; no portable assertion manifest was supplied.' },
        evidence,
    };
    const id = receiptId(payload);
    const receipt = { ...payload, receipt_id: id, created_at: new Date().toISOString(), signature: null,
        trust: 'local-unsigned', limitations: ['Not registry-signed', 'Delivery is not independent reproduction', 'May depend on private workspace state'] };
    // Receipts contain run identifiers and remain in Oberon's out-of-context,
    // gitignored state. The project lockfile stores only their content address.
    const dir = path.join(root, '.oberon', 'skilxiv', 'receipts');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id.slice(7)}.json`), tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    await fsp.rename(tmp, file);
    return { ok: true, id, file, receipt };
}

module.exports = { canonical, receiptId, writeVerificationReceipt };
