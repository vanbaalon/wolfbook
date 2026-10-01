'use strict';
// A model of Overleaf's real-time service for tests and checks (no network):
// the Socket.IO 0.9 framing, joinProjectResponse (documents, files and
// folders), joinDoc (UTF-8 lines in latin1), applyOtUpdate transformed as
// "left", otUpdateApplied; over HTTP the project list, its entities, the
// editor page's CSRF token, file download, upload (a text file becomes a
// document, as on Overleaf) and folder creation, with the tree events they
// cause. Its transport is handed to OverleafLink / OverleafLiveClient as `deps`.
const crypto = require('crypto');
const { apply, transform } = require('./overleafOt');

const blobHash = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const textHash = text => crypto.createHash('sha1').update(`blob ${text.length}\0`).update(Buffer.from(text, 'utf8')).digest('hex');
const TEXT = /\.(tex|bib|sty|cls|bst|txt)$/i;

class FakeOverleaf {
    /** @param {Record<string,string>} docs  path -> text  @param {Record<string,Buffer>} [binaries]  path -> bytes */
    constructor(docs, binaries = {}) {
        this.docs = new Map();
        this.files = new Map();
        this.folders = new Map([['root', '']]);
        this.sockets = [];
        this.uploads = [];
        this.n = 0;
        for (const [name, text] of Object.entries(docs)) this.docs.set(this.newId('d'), { name, text, history: [] });
        for (const [name, bytes] of Object.entries(binaries)) this.files.set(this.newId('f'), { name, bytes });
        for (const x of [...this.docs.values(), ...this.files.values()]) this.folderOf(x.name, false);
    }
    newId(kind) { return `${kind}${String(++this.n).padStart(23, '0')}`; }
    /** The id of the folder holding `name` (made when missing). */
    folderOf(name, announce = true) {
        const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
        return this.folderAt(dir, announce);
    }
    folderAt(dir, announce = true) {
        for (const [id, p] of this.folders) if (p === dir) return id;
        const parts = dir.replace(/\/$/, '').split('/');
        const parent = this.folderAt(parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '', announce);
        const id = `x${String(++this.n).padStart(23, '0')}`;
        this.folders.set(id, dir);
        if (announce) for (const s of this.sockets) s.event('reciveNewFolder', parent, { _id: id, name: parts.at(-1), docs: [], fileRefs: [], folders: [] });
        return id;
    }
    tree() {
        const nodes = new Map();
        const node = id => {
            if (!nodes.has(id)) {
                const p = this.folders.get(id);
                nodes.set(id, { _id: id, name: p ? p.replace(/\/$/, '').split('/').at(-1) : 'rootFolder', docs: [], fileRefs: [], folders: [] });
            }
            return nodes.get(id);
        };
        const byDepth = [...this.folders].sort((a, b) => a[1].length - b[1].length);
        for (const [id, p] of byDepth) {
            if (!p) { node(id); continue; }
            const parts = p.replace(/\/$/, '').split('/');
            const parentDir = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';
            const parent = byDepth.find(([, q]) => q === parentDir)[0];
            node(parent).folders.push(node(id));
        }
        for (const [id, d] of this.docs) node(this.folderOf(d.name, false)).docs.push({ _id: id, name: d.name.split('/').at(-1) });
        for (const [id, f] of this.files) node(this.folderOf(f.name, false)).fileRefs.push({ _id: id, name: f.name.split('/').at(-1), hash: blobHash(f.bytes) });
        return { name: 'Fishnets', rootFolder: [node('root')] };
    }
    /** A file added or replaced on Overleaf (by a collaborator, or an upload). */
    putFile(name, bytes) {
        const folder = this.folderOf(name);
        if (TEXT.test(name)) {
            if (this.idOf(name)) return;
            const id = this.newId('d');
            this.docs.set(id, { name, text: bytes.toString('utf8'), history: [] });
            for (const s of this.sockets) s.event('reciveNewDoc', folder, { _id: id, name: name.split('/').at(-1) });
            return;
        }
        for (const [id, f] of this.files) if (f.name === name) this.files.delete(id);
        const id = this.newId('f');
        this.files.set(id, { name, bytes });
        for (const s of this.sockets) s.event('reciveNewFile', folder, { _id: id, name: name.split('/').at(-1), hash: blobHash(bytes) }, 'upload', null, 'u');
    }
    fileBytes(name) { for (const f of this.files.values()) if (f.name === name) return f.bytes; return null; }
    deps() {
        const server = this;
        const json = (good, value) => ({ ok: good, status: good ? 200 : 403, json: async () => value, text: async () => JSON.stringify(value) });
        return {
            fetch: async (url, init = {}) => {
                const good = /overleaf_session2=good/.test(init.headers?.Cookie || '');
                const u = new URL(url);
                if (/\/user\/projects$/.test(u.pathname)) return json(good, { projects: [{ _id: '0123456789abcdef01234567', name: 'Fishnets', accessLevel: 'owner' }] });
                if (/\/project\/[0-9a-f]{24}\/entities$/.test(u.pathname)) return json(good, { entities: [
                    ...[...server.docs.values()].map(d => ({ path: `/${d.name}`, type: 'doc' })),
                    ...[...server.files.values()].map(f => ({ path: `/${f.name}`, type: 'file' }))] });
                if (/\/project\/[0-9a-f]{24}$/.test(u.pathname)) return { ok: good, status: good ? 200 : 403,
                    text: async () => '<html><head><meta name="ol-csrfToken" content="tok"></head></html>' };
                const m = /\/Project\/[0-9a-f]{24}\/file\/(\w+)$/.exec(u.pathname);
                if (m) { const f = server.files.get(m[1]); return { ok: good && !!f, status: f ? 200 : 404,
                    arrayBuffer: async () => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.length) }; }
                const csrf = init.headers?.['X-Csrf-Token'] === 'tok';
                if (/\/Project\/[0-9a-f]{24}\/upload$/.test(u.pathname) && init.method === 'POST') {
                    const folder = server.folders.get(u.searchParams.get('folder_id'));
                    if (!good || !csrf || folder === undefined) return json(false, { success: false });
                    const name = init.body.get('name');
                    const bytes = Buffer.from(await init.body.get('qqfile').arrayBuffer());
                    server.uploads.push(folder + name);
                    server.putFile(folder + name, bytes);
                    return json(true, { success: true });
                }
                if (/\/project\/[0-9a-f]{24}\/folder$/.test(u.pathname) && init.method === 'POST') {
                    if (!good || !csrf) return json(false, {});
                    const { name, parent_folder_id } = JSON.parse(init.body);
                    const id = server.folderAt(`${server.folders.get(parent_folder_id)}${name}/`);
                    return json(true, { _id: id, name });
                }
                // The socket.io handshake.
                return { ok: good, status: good ? 200 : 403, text: async () => (good ? 'sid1:60:60:websocket,xhr-polling' : 'no'),
                    headers: { getSetCookie: () => [] } };
            },
            WebSocket: class {
                constructor() {
                    this.onmessage = null;
                    this.socket = new FakeSocket(server, this);
                    server.sockets.push(this.socket);
                    queueMicrotask(() => {
                        this.onmessage?.({ data: '1::' });
                        this.socket.event('joinProjectResponse', { publicId: 'p', project: server.tree(), permissionsLevel: 'owner', protocolVersion: 2 });
                    });
                }
                send(data) { this.socket.receive(data); }
                close() {}
            },
        };
    }
    idOf(name) { for (const [id, d] of this.docs) if (d.name === name) return id; return null; }
    text(name) { return this.docs.get(this.idOf(name)).text; }
    collaborator(name, op) { const id = this.idOf(name); this.applyAt(id, op, this.docs.get(id).history.length, null); }
    applyAt(id, op, v, from, hash) {
        const d = this.docs.get(id);
        const transformed = d.history.length > v;
        for (const past of d.history.slice(v)) op = transform(op, past, 'left');
        const next = apply(d.text, op);
        // As Overleaf: an update applied untransformed must leave the text its hash names.
        if (hash && !transformed && textHash(next) !== hash) {
            this.refused = (this.refused || 0) + 1;
            for (const s of this.sockets) if (s === from) s.event('otUpdateError', 'Invalid hash', { doc: id });
            return;
        }
        d.text = next;
        d.history.push(op);
        const at = d.history.length - 1;
        for (const s of this.sockets) s.event('otUpdateApplied', s === from ? { doc: id, v: at } : { doc: id, op, v: at, meta: {} });
    }
}
class FakeSocket {
    constructor(server, ws) { this.server = server; this.ws = ws; }
    event(name, ...args) { queueMicrotask(() => this.ws.onmessage?.({ data: `5:::${JSON.stringify({ name, args })}` })); }
    receive(data) {
        // An event with no acknowledgement asked: `5:::{…}`.
        const plain = /^5:::(.*)$/.exec(data);
        if (plain) { const { name, args } = JSON.parse(plain[1]); if (name === 'clientTracking.updatePosition') this.server.positions = [...(this.server.positions || []), args[0]]; return; }
        const m = /^5:(\d+)\+::(.*)$/.exec(data);
        if (!m) return;
        const { name, args } = JSON.parse(m[2]);
        const ack = reply => queueMicrotask(() => this.ws.onmessage?.({ data: `6:::${m[1]}+${JSON.stringify(reply)}` }));
        if (name === 'joinDoc') {
            const d = this.server.docs.get(args[0]);
            ack([null, d.text.split('\n').map(l => Buffer.from(l, 'utf8').toString('latin1')), d.history.length, [], {}, 'sharejs-text-ot']);
        } else if (name === 'clientTracking.updatePosition') {
            this.server.positions = [...(this.server.positions || []), args[0]];
        } else if (name === 'applyOtUpdate') {
            ack([]);
            queueMicrotask(() => this.server.applyAt(args[0], args[1].op, args[1].v, this, args[1].hash));
        }
    }
}

module.exports = { FakeOverleaf, blobHash, textHash };
