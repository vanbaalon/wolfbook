'use strict';
const { hashSkillBody } = require('./skilxivClient');

function parseRef(ref) {
    const m = String(ref || '').trim().match(/^@?([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:@([A-Za-z0-9][A-Za-z0-9.+_-]*))?$/);
    if (!m) throw new Error('Expected @namespace/name@version');
    return { namespace: m[1], name: m[2], version: m[3] };
}
async function fetchRef(client, ref, { signal } = {}) {
    const p = parseRef(ref), skill = await client.getSkill(p.namespace, p.name, p.version, { signal });
    const version = p.version && p.version !== 'latest' ? p.version : skill.version;
    if (!version) throw new Error('SkilXiv did not resolve this reference to an immutable version.');
    const body = String(skill.body || skill.body_text || skill.skill_md || '');
    const contentHash = hashSkillBody(body), expected = skill.content_hash || null;
    if (expected && expected !== contentHash) throw new Error(`SkilXiv integrity mismatch for @${p.namespace}/${p.name}@${version}.`);
    let advisories = [];
    if (typeof client.request === 'function') {
        try {
            const result = await client.request(`/skills/${encodeURIComponent(p.namespace)}/${encodeURIComponent(p.name)}/versions/${encodeURIComponent(version)}/advisories`, { signal });
            advisories = Array.isArray(result) ? result : (result && result.advisories) || [];
        } catch (e) {
            // Backward compatibility: an older registry may not expose advisories.
            // Network/auth/integrity failures still propagate; only 404 means unsupported.
            if (!e || e.status !== 404) throw e;
        }
    }
    const blocking = advisories.find(a => ['unsafe', 'revoked'].includes(String(a.status || '').toLowerCase()));
    if (blocking) throw new Error(`SkilXiv blocked ${p.namespace}/${p.name}@${version}: ${blocking.status}${blocking.summary ? ` — ${blocking.summary}` : ''}`);
    return { skill, ref: `@${p.namespace}/${p.name}@${version}`, contentHash, advisories };
}
module.exports = { parseRef, fetchRef };
