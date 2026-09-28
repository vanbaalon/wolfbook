'use strict';
// ---------------------------------------------------------------------------
// Private Unix socket for the primary MCP server.
//
// WHY: sandboxed MCP hosts cannot reach 127.0.0.1:27182. Claude Science runs
// every local connector under a seatbelt profile whose only allowance for
// talking to another local process is `[sandbox.network] allow_unix_sockets`
// in ~/.claude-science/config.toml. So the primary listens on a socket as well
// as TCP, and the stdio bridge connects with --socket=<path>.
//
// The path is predictable — /tmp/wolfbook-mcp-<uid>/mcp.sock, resolved
// (/private/tmp on macOS) — so the manual setup can be documented. /tmp is
// shared, so the directory is only used if WE own it, it is a real directory
// (not a symlink) and nobody else can write into it. A squatted directory
// disables the socket (TCP keeps working); it never gets used.
// ---------------------------------------------------------------------------

const fs = require('fs');
const net = require('net');
const path = require('path');

const SOCKET_NAME = 'mcp.sock';

function _uid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** The socket path, or null where Unix sockets do not apply (Windows). */
function localSocketPath() {
    const uid = _uid();
    if (process.platform === 'win32' || uid == null) return null;
    let tmp = '/tmp';
    try { tmp = fs.realpathSync('/tmp'); } catch (_) {}
    return path.join(tmp, `wolfbook-mcp-${uid}`, SOCKET_NAME);
}

/** Why `dir` must not be used, or null when it is safe. Never follows a symlink. */
function unsafeDirReason(dir) {
    let st;
    try { st = fs.lstatSync(dir); } catch (e) { return e.code === 'ENOENT' ? 'missing' : e.message; }
    if (st.isSymbolicLink()) return 'is a symlink';
    if (!st.isDirectory()) return 'is not a directory';
    const uid = _uid();
    if (uid != null && st.uid !== uid) return `owned by uid ${st.uid}, not ${uid}`;
    if (st.mode & 0o022) return 'writable by other users';
    return null;
}

/** Create the socket directory 0700, or verify an existing one. Throws when unsafe. */
function ensurePrivateSocketDir(dir) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const reason = unsafeDirReason(dir);
    if (reason) throw new Error(`socket directory ${dir} ${reason}`);
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
}

/** Does something answer on this socket? (A stale file from a crashed primary does not.) */
function socketAlive(socketPath, timeoutMs = 500) {
    return new Promise(resolve => {
        const s = net.connect(socketPath);
        const done = ok => { s.destroy(); resolve(ok); };
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
        s.setTimeout(timeoutMs, () => done(false));
    });
}

module.exports = { localSocketPath, unsafeDirReason, ensurePrivateSocketDir, socketAlive, SOCKET_NAME };
