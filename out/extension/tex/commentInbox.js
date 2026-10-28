'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sidecarFor, validRecord, freshRecord, commentHash } = require('./commentStore');
const { onCommentChange } = require('./commentEvents');
const { commentAgent, commentWakeup } = require('./commentWakeup');

const LEASE_MS = 10 * 60 * 1000;
const IDLE_MS = 15 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;

class CommentInbox {
    constructor(deps = {}) {
        this.fs = deps.fs || fs;
        this.now = deps.now || Date.now;
        this.listeners = new Map();
        this.byFile = new Map();
        this.change = onCommentChange(({file}) => this.wakeFile(file));
        this.sweep = setInterval(() => {
            for (const l of this.listeners.values()) if (this.now() - l.touched > IDLE_MS && !l.waiter) this.stop(l.id);
        }, 60000);
        this.sweep.unref?.();
    }

    async read(file) {
        const sidecar = sidecarFor(file);
        try {
            const stat = await this.fs.promises.stat(sidecar);
            if (stat.size > MAX_BYTES) throw Error('Comment sidecar exceeds the 8 MiB listener limit; comments were left untouched.');
            const bytes = await this.fs.promises.readFile(sidecar, 'utf8');
            if (Buffer.byteLength(bytes) > MAX_BYTES) throw Error('Comment sidecar exceeds the listener limit.');
            return validRecord(JSON.parse(bytes), file);
        } catch (error) {
            if (error.code === 'ENOENT') return freshRecord(file);
            throw error;
        }
    }

    async start(file, includeExisting = false, agent = 'other', owner = null) {
        agent=commentAgent(agent);
        if (this.byFile.has(file)) {
            const existing=this.byFile.get(file);
            // A retry in the owning MCP session recovers its capability. Never
            // disclose another session's listener or discard its outstanding delivery.
            if (owner && owner === existing.owner) return {...this.status(existing.id),state:'already-listening'};
            return { state:'already-listening', file,
                reason:'A listener already owns this file. Use its listener_id or stop it first.' };
        }
        if (this.listeners.size >= 32) throw Error('Too many comment listeners; stop an unused listener first.');
        const l = { id:`paper_listener_${crypto.randomUUID()}`, file, agent, owner, seen:new Map(), acknowledgments:new Map(),
            touched:this.now(), revision:0, claim:null, waiter:null, watcher:null, cancelledRequests:new Set() };
        this.listeners.set(l.id, l); this.byFile.set(file, l);
        try {
            const base = path.basename(sidecarFor(file));
            // Watch the directory: the store atomically replaces/removes the
            // sidecar, so a watcher on the old inode would miss later comments.
            l.watcher = this.fs.watch(path.dirname(file), {persistent:false}, (_event, name) => {
                if (name == null || String(name) === base) this.wake(l);
            });
            l.watcher.on('error', error => { l.watchError=error.message; this.wake(l); });
            const record = await this.read(file);
            if (!includeExisting) for (const c of record.comments) l.seen.set(c.id, commentHash(c));
            return { state:'listening', listener_id:l.id, file, sidecar:sidecarFor(file),
                include_existing:includeExisting,
                wakeup:commentWakeup(l),
                next:'Follow wakeup.next to install native client scheduling or keep an active bounded wait. Apply a guarded verified paper edit, then action=ack with delivery_id and operation_id. Failed edits must not acknowledge.' };
        } catch (error) { this.stop(l.id); throw error; }
    }

    get(id, file) {
        const l = this.listeners.get(String(id || ''));
        if (!l) throw Error('Unknown or expired listener_id; start a new listener with include_existing:true to recover pending comments.');
        if (file && file !== l.file) throw Error('Listener belongs to a different file.');
        l.touched=this.now();
        return l;
    }

    wake(l) {
        l.revision++;
        l.waiter?.();
    }
    wakeFile(file) { const l = this.byFile.get(file); if (l) this.wake(l); }

    async next(id, { waitSeconds=45, maxComments=1, token, requestId } = {}) {
        const l = this.get(id);
        if (l.polling) return {state:'already-waiting', listener_id:l.id, file:l.file};
        l.polling=true;
        const seconds=Number(waitSeconds), count=Number(maxComments);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300 ||
            !Number.isInteger(count) || count < 1 || count > 10) {
            l.polling=false; throw Error('wait_seconds must be 0–300; max_comments must be an integer from 1–10.');
        }
        const deadline=this.now() + seconds*1000;
        try {
            for (;;) {
                if (!this.listeners.has(l.id)) return {state:'stopped', listener_id:l.id, file:l.file};
                if (token?.isCancellationRequested || requestId && l.cancelledRequests.has(requestId))
                    return {state:'cancelled', listener_id:l.id, file:l.file};
                l.touched=this.now();
                if (l.claim && l.claim.expiresAt <= this.now()) l.claim=null;
                if (l.claim) return { ...l.claim.response, redelivered:true };
                const revision=l.revision;
                const record=await this.read(l.file);
                // Another caller may have stopped this listener during the I/O.
                if (!this.listeners.has(l.id)) continue;
                const pending=record.comments.filter(c => l.seen.get(c.id) !== commentHash(c)).slice(0,count);
                if (pending.length) {
                    const cells=new Map(record.cells.map(c => [c.id,c]));
                    const response={state:'comments', listener_id:l.id, file:l.file,
                        issued_at:this.now(),
                        delivery_id:`paper_delivery_${crypto.randomUUID()}`,
                        comments:pending.map(c => ({...c, comment_hash:commentHash(c), cell:cells.get(c.cellId)}))};
                    l.claim={response, expiresAt:this.now()+LEASE_MS};
                    return response;
                }
                const remaining=deadline-this.now();
                if (remaining <= 0) return {state:'waiting', listener_id:l.id};
                // Only a timer/watcher is held. No source lock, render-map work,
                // kernel lease, or busy loop exists while the model waits.
                await new Promise(resolve => {
                    let done=false, cancel;
                    const finish=() => { if (done) return; done=true; clearTimeout(timer);
                        cancel?.dispose(); if (l.waiter===finish) l.waiter=null; resolve(); };
                    const timer=setTimeout(finish, Math.min(remaining,1000));
                    l.waiter=finish;
                    cancel=token?.onCancellationRequested?.(finish);
                    if (done) cancel?.dispose();
                    if (l.revision !== revision || !this.listeners.has(l.id) || token?.isCancellationRequested ||
                        requestId && l.cancelledRequests.has(requestId)) finish();
                });
            }
        } finally { l.polling=false; l.touched=this.now(); if (requestId) l.cancelledRequests.delete(requestId); }
    }

    cancelWait(id, requestId) {
        const l=this.get(id);
        if (!requestId) throw Error('An internal request id is required to cancel a wait.');
        l.cancelledRequests.add(requestId);
        while (l.cancelledRequests.size > 32) l.cancelledRequests.delete(l.cancelledRequests.values().next().value);
        this.wake(l);
        return {state:'cancelled',listener_id:l.id,file:l.file,comments_deleted:0};
    }

    claim(id, deliveryId) {
        const l=this.get(id);
        if (!l.claim || l.claim.expiresAt <= this.now() || l.claim.response.delivery_id !== deliveryId)
            throw Error('Unknown or expired delivery_id. The comments remain available; call next again.');
        return {listener:l, delivery:l.claim.response};
    }
    claimDelivery(deliveryId, file) {
        for (const l of this.listeners.values()) {
            if (l.claim?.response.delivery_id !== deliveryId) continue;
            if (file && l.file !== file) throw Error('Delivery belongs to a different file.');
            return this.claim(l.id, deliveryId);
        }
        throw Error('Unknown or expired delivery_id. Call next again; comments were preserved.');
    }
    complete(id, deliveryId) {
        const {listener:l,delivery}=this.claim(id,deliveryId);
        for (const c of delivery.comments) l.seen.set(c.id,c.comment_hash);
        l.claim=null; this.wake(l);
    }
    release(id, deliveryId) {
        const {listener:l}=this.claim(id,deliveryId);
        l.claim=null; this.wake(l);
        return {state:'released', listener_id:l.id, file:l.file, comments_deleted:0};
    }
    acknowledged(id, deliveryId, operationId) {
        const l=this.get(id), entry=l.acknowledgments.get(deliveryId);
        if (!entry || entry.expiresAt <= this.now()) { l.acknowledgments.delete(deliveryId); return null; }
        return entry.operationId === operationId ? {...entry.receipt,replayed:true} : null;
    }
    rememberAcknowledgment(id, deliveryId, operationId, receipt) {
        const l=this.get(id);
        l.acknowledgments.set(deliveryId,{operationId,receipt,expiresAt:this.now()+LEASE_MS});
        while (l.acknowledgments.size > 32) l.acknowledgments.delete(l.acknowledgments.keys().next().value);
    }
    status(id, full = false) {
        const l=this.get(id);
        if (l.claim?.expiresAt <= this.now()) l.claim=null;
        return {state:'listening',listener_id:l.id,file:l.file,waiting:!!l.waiter,
            ...(full ? {wakeup:commentWakeup(l)} : {}),
            ...(l.claim ? {delivery_id:l.claim.response.delivery_id,
                comment_ids:l.claim.response.comments.map(c=>c.id),delivery_expires_at:l.claim.expiresAt} : {}),
            watch_error:l.watchError || undefined};
    }
    stop(id) {
        const l=this.listeners.get(String(id || ''));
        if (!l) return {state:'stopped',listener_id:id,comments_deleted:0};
        this.listeners.delete(l.id); this.byFile.delete(l.file); l.watcher?.close(); this.wake(l);
        return {state:'stopped',listener_id:l.id,file:l.file,comments_deleted:0,
            wakeup_cleanup:commentWakeup(l).stop};
    }
    dispose() {
        for (const id of [...this.listeners.keys()]) this.stop(id);
        clearInterval(this.sweep); this.change.dispose();
    }
}

let singleton;
function commentInbox() { return singleton ||= new CommentInbox(); }
module.exports = { CommentInbox, commentInbox, commentHash };
