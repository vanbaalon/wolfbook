'use strict';

/**
 * The real-time Overleaf client (`wolfbook.tex.overleafSync: "live"`: off
 * by default, not supported by Overleaf, on only once its risks are
 * accepted). The desktop's electron/overleaf-live.ts is the same code.
 *
 * It joins one Overleaf project the way Overleaf's web editor does, signed
 * in with the reader's session cookie (tex/overleafSocket.js): the
 * project's tree arrives in `joinProjectResponse`, each text document is
 * joined (`joinDoc`: its lines, as UTF-8 bytes in a latin1 string, and its
 * version), local edits go out as `applyOtUpdate` (one op in flight per
 * document) and every client's applied op comes back as `otUpdateApplied`:
 * our own as a bare acknowledgement `{doc, v}`, anyone else's with its op,
 * which is transformed past what we have not had acknowledged
 * (tex/overleafOt.js).
 *
 * Limits, stated in the panel: text documents only (pictures and other
 * files are not synced); projects Overleaf serves in its newer "history
 * OT" format are refused; a dropped connection is not resumed — connect
 * again, and differences are offered for resolution as at the start.
 */
const { Socket09 } = require('./overleafSocket');
const { OtDocument, textOnly } = require('./overleafOt');
/** A project URL: `https://www.overleaf.com/project/<24 hex>` → its parts. */
function parseProjectUrl(value) {
    let url;
    try {
        url = new URL(String(value).trim());
    }
    catch {
        throw Error("Paste the Overleaf project's address, https://…/project/<id>");
    }
    const m = /\/project\/([0-9a-f]{24})(?:[/?#]|$)/i.exec(url.pathname + (url.search || ""));
    if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)))
        throw Error("Use the project's https:// address");
    if (!m)
        throw Error("That is not an Overleaf project address (…/project/<id>)");
    return { base: `${url.protocol}//${url.host}`, projectId: m[1].toLowerCase() };
}
/** The Cookie header from what the reader pasted: a whole header, a pair, or a bare value. */
function cookieHeader(value) {
    const v = String(value || "").trim().replace(/^cookie:\s*/i, "");
    if (!v || v.length > 8192 || /[\r\n]/.test(v))
        throw Error("Paste the Overleaf session cookie");
    return v.includes("=") ? v : `overleaf_session2=${v}`;
}
const latin1Utf8 = (s) => Buffer.from(s, "latin1").toString("utf8");
class OverleafLiveClient {
    events;
    deps;
    socket = null;
    docs = new Map(); // by doc id
    project = null;
    sending = new Set();
    /** The project's folders (id -> path, "" for its top, "a/b/" below) and non-text files (id -> {id, path, hash}). */
    folders = new Map();
    files = new Map();
    constructor(events, deps) {
        this.events = events;
        this.deps = deps;
    }
    /** Connect and join the project: resolves with its name and text documents. */
    async connect(base, projectId, cookie) {
        const socket = new Socket09(base, projectId, cookie, this.deps);
        this.socket = socket;
        const joined = new Promise((resolve, reject) => {
            socket.on("joinProjectResponse", (r) => resolve(r));
            socket.on("connectionRejected", (e) => reject(Error(e?.message === "invalid session" ? "Overleaf did not accept the session cookie (signed out, or expired)" : `Overleaf refused: ${e?.message ?? "connection rejected"}`)));
            setTimeout(() => reject(Error("Overleaf did not answer in time")), 20000).unref?.();
        });
        socket.on("otUpdateApplied", (u) => this.applied(u));
        socket.on("otUpdateError", (err, message) => this.fail(`Overleaf rejected an edit: ${message ?? err}`));
        // The project's folders and files (pictures and other non-text files)
        // are kept here as they change, as its documents are.
        socket.on("reciveNewFolder", (parentId, folder) => {
            if (folder?._id) this.folders.set(folder._id, `${this.folders.get(parentId) ?? ""}${folder.name}/`);
        });
        socket.on("reciveNewDoc", (folderId, doc) => {
            const p = `${this.folders.get(folderId) ?? ""}${doc?.name ?? ""}`;
            if (doc?._id && this.events.docAdded) this.events.docAdded(doc._id, p);
            else this.events.tree("A document was added on Overleaf: connect again to sync it");
        });
        socket.on("reciveNewFile", (folderId, fileRef) => {
            if (!fileRef?._id) return;
            const p = `${this.folders.get(folderId) ?? ""}${fileRef.name}`;
            // A replaced file keeps its path under a new id.
            for (const [id, f] of this.files) if (f.path === p) this.files.delete(id);
            this.files.set(fileRef._id, { id: fileRef._id, path: p, hash: fileRef.hash ?? null });
            this.events.fileChanged?.(p, fileRef._id);
        });
        socket.on("removeEntity", (id) => {
            const d = this.docs.get(id);
            if (d) {
                this.docs.delete(id);
                this.events.tree(`${d.path} was removed on Overleaf; it is no longer synced`);
            }
            const f = this.files.get(id);
            if (f) {
                this.files.delete(id);
                this.events.tree(`${f.path} was removed on Overleaf (your copy is kept)`);
            }
        });
        socket.on("reciveEntityRename", (id) => {
            const d = this.docs.get(id);
            if (d) {
                this.docs.delete(id);
                this.events.tree(`${d.path} was renamed on Overleaf: connect again to sync it under its new name`);
            }
        });
        socket.on("reciveEntityMove", (id) => {
            if (this.docs.delete(id))
                this.events.tree("A document was moved on Overleaf: connect again to sync it");
        });
        socket.on("project:access:revoked", () => this.fail("Your access to this Overleaf project was revoked"));
        socket.onClose = (reason) => this.events.closed(reason);
        await socket.connect();
        const r = await joined;
        const docs = [];
        const walk = (folder, prefix) => {
            if (folder?._id) this.folders.set(folder._id, prefix);
            for (const d of folder?.docs ?? [])
                docs.push({ id: d._id, path: prefix + d.name });
            for (const f of folder?.fileRefs ?? [])
                this.files.set(f._id, { id: f._id, path: prefix + f.name, hash: f.hash ?? null });
            for (const f of folder?.folders ?? [])
                walk(f, `${prefix}${f.name}/`);
        };
        walk(r?.project?.rootFolder?.[0], "");
        this.project = { name: r?.project?.name ?? "Overleaf project", docs, mainId: r?.project?.rootDoc_id || null };
        if (r?.permissionsLevel && !["owner", "readAndWrite", "review"].includes(r.permissionsLevel))
            throw Error("You can only read this Overleaf project: nothing can be synced");
        return this.project;
    }
    /** Join a document: its text and version on Overleaf. */
    async join(id, path) {
        const reply = await this.socket.emit("joinDoc", [id, { encodeRanges: true }], true);
        const [err, lines, version, , , type] = reply;
        if (err) {
            const message = err.message ?? String(err);
            if (/history-ot/.test(message))
                throw Error("This Overleaf project uses Overleaf's newer editing format, which WLaTeX cannot sync in real time yet");
            throw Error(`Could not open ${path} on Overleaf: ${message}`);
        }
        if (type && type !== "sharejs-text-ot")
            throw Error("This Overleaf project uses Overleaf's newer editing format, which WLaTeX cannot sync in real time yet");
        const text = lines.map(latin1Utf8).join("\n");
        const doc = { id, path, ot: new OtDocument(text, version) };
        this.docs.set(id, doc);
        return doc;
    }
    /** The id of the folder at `dir` ("" or "a/b/"), if the project has it. */
    folderId(dir) {
        for (const [id, p] of this.folders) if (p === dir) return id;
        return null;
    }
    fileByPath(path) {
        for (const f of this.files.values()) if (f.path === path) return f;
        return null;
    }
    byPath(path) {
        for (const d of this.docs.values())
            if (d.path === path)
                return d;
        return null;
    }
    /** A local edit of a synced document. */
    local(path, op) {
        const d = this.byPath(path);
        if (!d || !op.length)
            return;
        // Overleaf stores a character outside the Basic Multilingual Plane
        // (𝔸, an emoji) as two U+FFFD: the copy kept here does the same, so its
        // positions and text stay Overleaf's.
        const fix = (t) => t.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
        const stored = op.map((c) => "i" in c
            ? /[\uD800-\uDFFF]/.test(c.i) ? { p: c.p, i: fix(c.i) } : c
            : /[\uD800-\uDFFF]/.test(c.d) ? { p: c.p, d: fix(c.d) } : c);
        if (stored.some((c, k) => c !== op[k]) && !this.warnedSurrogates) {
            this.warnedSurrogates = true;
            this.events.tree("characters such as 𝔸 or emoji are stored by Overleaf as �; write them as LaTeX commands (\\mathbb{A})");
        }
        d.ot.local(stored);
        this.flush(d);
    }
    warnedSurrogates = false;
    flush(d) {
        if (this.sending.has(d.id) || !this.socket || this.socket.closed)
            return;
        const next = d.ot.take();
        if (!next)
            return;
        this.sending.add(d.id);
        // Overleaf's own consistency check, as its editor sends it: the hash
        // of the text this update leaves (git's blob hash over the UTF-16
        // length and the UTF-8 bytes). When Overleaf's text differs it
        // refuses the update and we disconnect, rather than go on editing a
        // text that is not Overleaf's.
        const hash = require("crypto").createHash("sha1")
            .update(`blob ${d.ot.text.length}\0`).update(Buffer.from(d.ot.text, "utf8")).digest("hex");
        void this.socket
            .emit("applyOtUpdate", [d.id, { doc: d.id, op: next.op, v: next.v, hash }], true)
            .then(([err]) => {
            if (err)
                this.fail(`Overleaf rejected an edit of ${d.path}: ${err.message ?? err}`);
        });
    }
    applied(u) {
        const d = u && this.docs.get(u.doc);
        if (!d)
            return;
        try {
            if (!u.op) {
                // Our own op, acknowledged (a duplicate is acknowledged the same way).
                if (!d.ot.inflight)
                    return;
                d.ot.acknowledged(u.v);
                this.sending.delete(d.id);
                this.flush(d);
                return;
            }
            const op = d.ot.remote(textOnly(u.op), u.v);
            if (op.length)
                this.events.remote(d.path, op, d.ot.text);
        }
        catch (e) {
            this.fail(`${d.path} went out of step with Overleaf (${e.message}); connect again to resynchronise`);
        }
    }
    fail(message) {
        this.events.tree(message);
        this.close();
    }
    /** Every edit sent has been acknowledged. */
    idle() {
        for (const d of this.docs.values())
            if (d.ot.inflight || d.ot.pending.length)
                return false;
        return true;
    }
    close() {
        this.socket?.close();
        this.socket = null;
    }
}

module.exports = { OverleafLiveClient, parseProjectUrl, cookieHeader };
