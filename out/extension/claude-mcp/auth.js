'use strict';
// ---------------------------------------------------------------------------
// Who may talk to Wolfbook's local MCP servers (primary + worker windows).
//
// Browsers are kept out by the Origin/Host checks. This closes the other gap:
// ANY local process could reach 127.0.0.1:27182 and run Wolfram code as the
// user — other accounts on a shared machine, and sandboxed apps that may use
// the network but not the file system. So TCP callers present a bearer token
// read from ~/.wolfbook/mcp-token (0600). Everything Wolfbook launches reads
// it by itself (stdio bridge, worker windows, the Overleaf coalition server),
// so nobody configures anything. The Unix socket needs no token: its 0700
// directory already restricts it to this user.
//
// stdio-bridge.js repeats the tiny read-the-file logic inline — it must stay
// self-contained because it is copied out of the extension.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tokenPath() {
    return process.env.WOLFBOOK_MCP_TOKEN_FILE || path.join(os.homedir(), '.wolfbook', 'mcp-token');
}

let _cache = { path: null, mtimeMs: -1, token: null };

/** The token, re-read when the file changes. With create:true, make one if missing. */
function getToken({ create = false } = {}) {
    const file = tokenPath();
    try {
        const st = fs.statSync(file);
        if (_cache.path === file && _cache.mtimeMs === st.mtimeMs) return _cache.token;
        if (st.mode & 0o077) { try { fs.chmodSync(file, 0o600); } catch (_) {} }
        const token = fs.readFileSync(file, 'utf8').trim() || null;
        _cache = { path: file, mtimeMs: st.mtimeMs, token };
        return token;
    } catch (e) {
        if (e.code !== 'ENOENT' || !create) return null;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
        // 'wx': two windows activating together must end up with ONE token.
        fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return getToken();
}

/** Headers for Wolfbook's own calls between its servers. */
function authHeaders() {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

function viaUnixSocket(req) {
    return !!req.socket && req.socket.remoteAddress === undefined;
}

/** Does this request carry the token (or arrive over the private socket)? */
function isAuthorized(req) {
    if (viaUnixSocket(req)) return true;
    const token = getToken();
    if (!token) return false;
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) return false;
    const a = Buffer.from(m[1]), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Host header names this machine. A DNS-rebinding page sends its own host name. */
function isLocalHost(req) {
    if (viaUnixSocket(req)) return true;
    const host = String(req.headers.host || '').toLowerCase();
    return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

function rejectUnauthorized(res) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="wolfbook"' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001,
        message: 'Wolfbook MCP: missing or wrong token. Connect through the Wolfbook stdio bridge ' +
            '(run a "Wolfbook: Configure … MCP" command), or send "Authorization: Bearer <contents of ~/.wolfbook/mcp-token>".' } }));
}

module.exports = { tokenPath, getToken, authHeaders, isAuthorized, isLocalHost, viaUnixSocket, rejectUnauthorized };
