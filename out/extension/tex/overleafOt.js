'use strict';

const isInsert = (c) => typeof c.i === "string";
/** Only the text components of an op from the server (comments dropped). */
function textOnly(op) {
    const out = [];
    for (const c of op || []) {
        if (!c || !Number.isInteger(c.p) || c.p < 0)
            throw Error("Malformed Overleaf op");
        if (typeof c.i === "string")
            out.push({ p: c.p, i: c.i });
        else if (typeof c.d === "string")
            out.push({ p: c.p, d: c.d });
    }
    return out;
}
function apply(text, op) {
    for (const c of op) {
        if (c.p > text.length)
            throw Error(`Op position ${c.p} is past the document's end (${text.length})`);
        if (isInsert(c))
            text = text.slice(0, c.p) + c.i + text.slice(c.p);
        else {
            if (text.slice(c.p, c.p + c.d.length) !== c.d)
                throw Error("Delete component does not match the document");
            text = text.slice(0, c.p) + text.slice(c.p + c.d.length);
        }
    }
    return text;
}
/** Append, merging with the last component when they are contiguous. */
function push(dest, c) {
    if (isInsert(c) ? c.i === "" : c.d === "")
        return;
    const last = dest[dest.length - 1];
    if (last && isInsert(last) && isInsert(c) && last.p <= c.p && c.p <= last.p + last.i.length) {
        dest[dest.length - 1] = { p: last.p, i: last.i.slice(0, c.p - last.p) + c.i + last.i.slice(c.p - last.p) };
    }
    else if (last && !isInsert(last) && !isInsert(c) && c.p <= last.p && last.p <= c.p + c.d.length) {
        dest[dest.length - 1] = { p: c.p, d: c.d.slice(0, last.p - c.p) + last.d + c.d.slice(last.p - c.p) };
    }
    else
        dest.push(c);
}
/** Where a position goes past an insert or delete (`after`: at a tie, after the insert). */
function position(pos, c, after) {
    if (isInsert(c))
        return c.p < pos || (c.p === pos && after) ? pos + c.i.length : pos;
    if (pos <= c.p)
        return pos;
    if (pos <= c.p + c.d.length)
        return c.p;
    return pos - c.d.length;
}
/** `c`, transformed past `o` (both on the same document), into `dest`. */
function component(dest, c, o, side) {
    if (isInsert(c)) {
        push(dest, { p: position(c.p, o, side === "right"), i: c.i });
        return;
    }
    if (isInsert(o)) {
        // An insert inside the deleted text splits the delete around it.
        let rest = c.d;
        if (c.p < o.p) {
            push(dest, { p: c.p, d: rest.slice(0, o.p - c.p) });
            rest = rest.slice(o.p - c.p);
        }
        if (rest !== "")
            push(dest, { p: c.p + o.i.length, d: rest });
        return;
    }
    // Two deletes: what both deleted is deleted once.
    if (c.p >= o.p + o.d.length)
        push(dest, { p: c.p - o.d.length, d: c.d });
    else if (c.p + c.d.length <= o.p)
        push(dest, c);
    else {
        let d = "";
        if (c.p < o.p)
            d = c.d.slice(0, o.p - c.p);
        if (c.p + c.d.length > o.p + o.d.length)
            d += c.d.slice(o.p + o.d.length - c.p);
        if (d !== "")
            push(dest, { p: position(c.p, o, false), d });
    }
}
/**
 * Both ops of a concurrent pair, each transformed past the other: applying
 * `left` then `right'` gives what `right` then `left'` gives.
 */
function transformX(left, right) {
    const newRight = [];
    for (let r of right) {
        let rc = r;
        const newLeft = [];
        let k = 0;
        while (k < left.length) {
            const l = left[k];
            const nextR = [];
            component(newLeft, l, rc, "left");
            component(nextR, rc, l, "right");
            k++;
            if (nextR.length === 1)
                rc = nextR[0];
            else if (nextR.length === 0) {
                for (const x of left.slice(k))
                    push(newLeft, x);
                rc = null;
                break;
            }
            else {
                // The right component was split: go on with each part.
                const [l2, r2] = transformX(left.slice(k), nextR);
                for (const x of l2)
                    push(newLeft, x);
                for (const x of r2)
                    push(newRight, x);
                rc = null;
                break;
            }
        }
        if (rc)
            push(newRight, rc);
        left = newLeft;
    }
    return [left, newRight];
}
/** `op` transformed past `other`, as the `side` of the pair. */
function transform(op, other, side) {
    return side === "left" ? transformX(op, other)[0] : transformX(other, op)[1];
}
/**
 * A document as one Overleaf client holds it: one op in flight (sent, not
 * yet acknowledged) and the edits made since, merged, waiting for it.
 */
class OtDocument {
    text;
    version;
    inflight = null;
    pending = [];
    constructor(text, version) {
        this.text = text;
        this.version = version;
    }
    /** A local edit: applied here, queued for the server. */
    local(op) {
        this.text = apply(this.text, op);
        for (const c of op)
            push(this.pending, c);
    }
    /** The op to send now, if any: it becomes the one in flight. */
    take() {
        if (this.inflight || !this.pending.length)
            return null;
        this.inflight = this.pending;
        this.pending = [];
        return { op: this.inflight, v: this.version };
    }
    /** The server applied our op at version `v`. */
    acknowledged(v) {
        if (!this.inflight)
            throw Error("An acknowledgement with no op in flight");
        this.version = v + 1;
        this.inflight = null;
    }
    /**
     * Another client's op, at version `v`. Returns it as it applies to our
     * text (past what we have in flight and pending), after applying it.
     */
    remote(op, v) {
        if (v !== this.version)
            throw Error(`Overleaf op at version ${v}, expected ${this.version}`);
        let incoming = op;
        if (this.inflight)
            [this.inflight, incoming] = transformX(this.inflight, incoming);
        if (this.pending.length)
            [this.pending, incoming] = transformX(this.pending, incoming);
        this.text = apply(this.text, incoming);
        this.version++;
        return incoming;
    }
}

module.exports = { OtDocument, textOnly, apply, transformX, transform };
