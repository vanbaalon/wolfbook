'use strict';
const { SkilXivClient, normaliseBaseUrl } = require('./skilxivClient');

const LEGACY_KEY = 'wolfbook.skilxiv.apiToken';
let extensionContext = null;

function configure(context) { extensionContext = context || null; }
function keyFor(baseUrl) {
    const origin = new URL(normaliseBaseUrl(baseUrl)).origin;
    return `wolfbook.skilxiv.apiToken:${Buffer.from(origin).toString('base64url')}`;
}
async function getToken(baseUrl) {
    if (!extensionContext || !extensionContext.secrets) return '';
    const key = keyFor(baseUrl);
    let token = await extensionContext.secrets.get(key) || '';
    if (!token) {
        token = await extensionContext.secrets.get(LEGACY_KEY) || '';
        if (token) {
            await extensionContext.secrets.store(key, token);
            await extensionContext.secrets.delete(LEGACY_KEY).catch(() => {});
        }
    }
    return token;
}
async function setToken(baseUrl, token) {
    if (!extensionContext || !extensionContext.secrets) throw new Error('SkilXiv credential store is unavailable.');
    await extensionContext.secrets.store(keyFor(baseUrl), String(token || ''));
}
async function clearToken(baseUrl) {
    if (extensionContext && extensionContext.secrets) await extensionContext.secrets.delete(keyFor(baseUrl));
}
async function createClient({ baseUrl, ...opts } = {}) {
    const resolved = baseUrl || 'https://skilxiv.org';
    return new SkilXivClient({ baseUrl: resolved, apiToken: await getToken(resolved), ...opts });
}

module.exports = { configure, keyFor, getToken, setToken, clearToken, createClient, LEGACY_KEY };
