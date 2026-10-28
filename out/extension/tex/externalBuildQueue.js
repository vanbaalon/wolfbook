'use strict';
const fs = require('fs');
const path = require('path');

// Checkout/merge keeps index.lock while updating the worktree. A quiet gap
// between individual writes is not the end of that Git operation. Support
// linked worktrees too, whose .git is a pointer to their private git directory.
function gitWorktreeBusy(root) {
    let directory = path.dirname(root);
    for (let i = 0; i < 64; i++) {
        const marker = path.join(directory, '.git');
        try {
            const stat = fs.statSync(marker);
            const gitDir = stat.isDirectory() ? marker :
                path.resolve(directory, /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(marker, 'utf8'))?.[1]?.trim() || '.git');
            return ['index.lock', 'HEAD.lock'].some(name => fs.existsSync(path.join(gitDir, name)));
        } catch (_) {}
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return false;
}

// One debounced job per paper, shared by watcher, buffer reload and review
// notifications. Waiting for a running job never kills it. Notifications that
// arrived during it get at most one follow-up, after another quiet gap, and
// only if the finished build did not already include their source bytes.
class ExternalBuildQueue {
    constructor({ run, busy = () => false, needed = () => true, onError = () => {},
        now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
        Object.assign(this, { run, busy, needed, onError, now, setTimer, clearTimer });
        this.entries = new Map();
        this.disposed = false;
    }
    has(root) { return this.entries.has(root); }
    notify(root, delay = 1000) {
        if (this.disposed) return;
        let entry = this.entries.get(root);
        if (!entry) { entry = { dirty: false, running: false, timer: null }; this.entries.set(root, entry); }
        entry.dirty = true;
        entry.due = this.now() + delay;
        if (entry.timer != null) this.clearTimer(entry.timer);
        if (!entry.running) this.arm(root, entry, delay);
    }
    arm(root, entry, delay) {
        entry.timer = this.setTimer(() => { entry.timer = null; this.flush(root, entry); }, Math.max(0, delay));
    }
    async flush(root, entry) {
        if (this.disposed || this.entries.get(root) !== entry) return;
        if (this.now() < entry.due) { this.arm(root, entry, entry.due - this.now()); return; }
        if (this.busy(root)) { this.arm(root, entry, 100); return; }
        entry.dirty = false;
        entry.running = true;
        try {
            if (this.needed(root)) await this.run(root);
        } catch (error) { this.onError(error); }
        finally {
            entry.running = false;
            if (this.disposed || this.entries.get(root) !== entry) return;
            if (entry.dirty) this.arm(root, entry, Math.max(0, entry.due - this.now()));
            else this.entries.delete(root);
        }
    }
    cancel(root) {
        const entry = this.entries.get(root);
        if (entry?.timer != null) this.clearTimer(entry.timer);
        this.entries.delete(root);
    }
    dispose() { this.disposed = true; for (const root of this.entries.keys()) this.cancel(root); }
}

module.exports = { ExternalBuildQueue, gitWorktreeBusy };
