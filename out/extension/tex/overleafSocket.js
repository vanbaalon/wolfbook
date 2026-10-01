'use strict';

class Socket09 {
    base;
    projectId;
    cookie;
    deps;
    ws = null;
    handlers = new Map();
    acks = new Map();
    nextAck = 1;
    closed = false;
    onClose = null;
    constructor(base, projectId, cookie, deps) {
        this.base = base;
        this.projectId = projectId;
        this.cookie = cookie;
        this.deps = deps;
    }
    on(name, handler) {
        this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    }
    async connect() {
        const query = `projectId=${encodeURIComponent(this.projectId)}`;
        const shake = await this.deps.fetch(`${this.base}/socket.io/1/?t=${Date.now()}&${query}`, {
            headers: { Cookie: this.cookie, Origin: this.base },
            redirect: "manual",
        });
        const body = await shake.text();
        if (!shake.ok)
            throw Error(`Overleaf refused the connection (HTTP ${shake.status})`);
        const [sid, , , transports] = body.split(":");
        if (!sid || !/websocket/.test(transports || ""))
            throw Error("Overleaf's real-time service answered unexpectedly");
        // A load-balancer cookie keeps the websocket on the handshake's server.
        const extra = (shake.headers.getSetCookie?.() ?? [])
            .map((c) => c.split(";")[0])
            .filter((c) => /^GCLB=/.test(c));
        const cookie = [this.cookie, ...extra].join("; ");
        const url = `${this.base.replace(/^http/, "ws")}/socket.io/1/websocket/${sid}?${query}`;
        await new Promise((resolve, reject) => {
            const ws = new this.deps.WebSocket(url, { headers: { Cookie: cookie, Origin: this.base } });
            this.ws = ws;
            let open = false;
            ws.onmessage = (e) => {
                const data = String(e.data);
                if (!open && data.startsWith("1:")) {
                    open = true;
                    resolve();
                    return;
                }
                this.packet(data);
            };
            ws.onerror = (e) => {
                if (!open)
                    reject(Error(`The Overleaf connection failed${e?.message ? `: ${e.message}` : ""}`));
            };
            ws.onclose = () => {
                if (!open)
                    reject(Error("Overleaf closed the connection"));
                this.finish("closed");
            };
        });
    }
    finish(reason) {
        if (this.closed)
            return;
        this.closed = true;
        for (const [, ack] of this.acks)
            ack([{ message: `disconnected: ${reason}` }]);
        this.acks.clear();
        this.onClose?.(reason);
    }
    packet(data) {
        const m = /^(\d):(\d*)\+?:[^:]*:?([\s\S]*)$/.exec(data);
        if (!m)
            return;
        const [, type, , payload] = m;
        if (type === "2")
            this.ws?.send("2::");
        else if (type === "0") {
            this.ws?.close();
            this.finish("the server disconnected");
        }
        else if (type === "5") {
            let event;
            try {
                event = JSON.parse(payload);
            }
            catch {
                return;
            }
            for (const h of this.handlers.get(event.name) ?? [])
                h(...(event.args ?? []));
        }
        else if (type === "6") {
            const a = /^(\d+)\+?([\s\S]*)$/.exec(payload);
            if (!a)
                return;
            const ack = this.acks.get(Number(a[1]));
            this.acks.delete(Number(a[1]));
            let args = [];
            try {
                args = a[2] ? JSON.parse(a[2]) : [];
            }
            catch {
                /* no arguments */
            }
            ack?.(args);
        }
        else if (type === "7")
            this.finish(`error: ${payload}`);
    }
    /** An event; with `ack`, resolves with the arguments the server answers. */
    emit(name, args, ack = false) {
        if (!this.ws || this.closed)
            return Promise.reject(Error("Not connected to Overleaf"));
        if (!ack) {
            this.ws.send(`5:::${JSON.stringify({ name, args })}`);
            return Promise.resolve([]);
        }
        const id = this.nextAck++;
        return new Promise((resolve) => {
            this.acks.set(id, resolve);
            this.ws.send(`5:${id}+::${JSON.stringify({ name, args })}`);
        });
    }
    close() {
        if (this.closed)
            return;
        try {
            this.ws?.send("0::");
            this.ws?.close();
        }
        catch {
            /* already gone */
        }
        this.finish("closed by WLaTeX");
    }
}

module.exports = { Socket09 };
