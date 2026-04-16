"use strict";
// Copyright 2021 Tianhuan Lu
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionQueue = void 0;
const uuid = require("uuid");
class ExecutionQueue {
    constructor() {
        this.queue = [];
    }
    empty() {
        return this.queue.length === 0;
    }
    queueLength() {
        return this.queue.length;
    }
    clear() {
        const { scrollLog } = require('./utils/dev-logger');
        scrollLog(`[queue.clear] called | queueLen=${this.queue.length}`);
        console.log(`ExecutionQueue.clear() called with ${this.queue.length} items in queue`);
        // Partition: unstarted items are ended immediately (safe — checkout hasn't claimed them).
        // Started items are LEFT IN the queue — the checkout loop is still alive and will
        // call executionQueue.end(id) itself when it finishes (or when its session.evaluate()
        // throws after quitKernel).  Removing started items here causes find(id) to return null
        // later, so execution.end() is never called and the cell spinner gets stuck forever.
        const unstartedItems = this.queue.filter(item => !item.started);
        // Remove only unstarted items from the queue
        this.queue = this.queue.filter(item => item.started);
        unstartedItems.forEach((item, index) => {
            const ex = item.execution;
            const cellIdx = ex?.cell?.index ?? '?';
            scrollLog(`[queue.clear] item ${index}: cell=${cellIdx} started=false — ending immediately`);
            console.log(`Clearing unstarted execution ${index}: cell=${cellIdx} id=${item.id}`);
            // For preVisualStarted items, calling start() again is wrong (already started).
            // For never-started items, we must call start() before end() (VS Code requirement).
            if (!item.preVisualStarted) {
                try { ex.start(Date.now()); scrollLog(`[queue.clear]   start() OK cell=${cellIdx}`); }
                catch (e) { scrollLog(`[queue.clear]   start() threw: ${e.message} cell=${cellIdx}`); }
            } else {
                scrollLog(`[queue.clear]   skipping start() — preVisualStarted already cell=${cellIdx}`);
            }
            try {
                ex.end(false, Date.now());
                scrollLog(`[queue.clear]   end() OK cell=${cellIdx}`);
                console.log(`Successfully ended unstarted execution ${index} cell=${cellIdx}`);
            } catch (err) {
                scrollLog(`[queue.clear]   end() THREW: ${err.message} cell=${cellIdx}`);
                console.error(`Failed to end execution ${index}:`, err.message);
            }
        });
        if (this.queue.length > 0) {
            scrollLog(`[queue.clear] ${this.queue.length} started item(s) left in queue — checkout loop will end them`);
            console.log(`[queue.clear] ${this.queue.length} started item(s) kept — checkout owns them`);
        }
        scrollLog('[queue.clear] done');
        console.log('ExecutionQueue clear() done');
    }
    // Force-end ALL items in the queue, including started ones.
    // Called from restartKernel() and when abort retries are exhausted so the cell
    // spinner stops immediately even if the checkout loop has not yet processed the
    // abort.  If checkout later calls end(id) it will find the item already gone and
    // harmlessly log "id not found".
    forceEndAll() {
        const { scrollLog } = require('./utils/dev-logger');
        scrollLog(`[queue.forceEndAll] called | queueLen=${this.queue.length}`);
        const allItems = this.queue.slice();
        this.queue = [];
        allItems.forEach((item, index) => {
            const ex = item.execution;
            const cellIdx = ex?.cell?.index ?? '?';
            scrollLog(`[queue.forceEndAll] item ${index}: cell=${cellIdx} started=${item.started} preVisual=${item.preVisualStarted}`);
            if (!item.preVisualStarted && !item.started) {
                try { ex.start(Date.now()); } catch (_) {}
            }
            try { ex.end(false, Date.now()); scrollLog(`[queue.forceEndAll]   end() OK cell=${cellIdx}`); }
            catch (e) { scrollLog(`[queue.forceEndAll]   end() THREW: ${e.message} cell=${cellIdx}`); }
        });
        scrollLog('[queue.forceEndAll] done');
    }
    push(execution) {
        const id = uuid.v4();
        this.queue.push({ id, execution, hasOutput: false, started: false, preVisualStarted: false, hasLaunchingPlaceholder: false,
            _preVisualStartTime: null, _actualStartTime: null });
        return id;
    }
    // Mark that a "Kernel is starting…" placeholder output was written to this cell.
    // checkoutExecutionQueue reads this flag to skip restoring the placeholder as
    // a prev-output before real evaluation begins.
    markLaunchingPlaceholder(id) {
        const item = this.find(id);
        if (item) item.hasLaunchingPlaceholder = true;
    }
    // Show the running spinner immediately without marking the item as 'started'
    // (so checkoutExecutionQueue still picks it up via getNextPendingExecution).
    preVisualStart(id) {
        const item = this.find(id);
        if (!item) { console.warn('[preVisualStart] id not found:', id); return; }
        const cellIdx = item.execution.cell.index;
        if (!item.preVisualStarted && !item.started) {
            const _now = Date.now();
            try {
                item.execution.start(_now);
                console.log(`[preVisualStart] cell ${cellIdx} — spinner started OK`);
            } catch (e) {
                console.error(`[preVisualStart] cell ${cellIdx} — start() threw: ${e.message}`);
            }
            item._preVisualStartTime = _now;
            item.preVisualStarted = true;
        } else {
            console.log(`[preVisualStart] cell ${cellIdx} — skipped (started=${item.started} preVisual=${item.preVisualStarted})`);
        }
    }
    // True if this cell already has a not-yet-started pending item in the queue.
    hasPendingForCell(cell) {
        return this.queue.some(item => !item.started && item.execution.cell === cell);
    }
    findIndex(id) {
        return this.queue.findIndex(item => (item.id === id));
    }
    at(index) {
        return this.queue[index] || null;
    }
    find(id) {
        return this.at(this.findIndex(id));
    }
    remove(id) {
        const index = this.findIndex(id);
        if (index >= 0) {
            this.queue.splice(index, 1);
        }
    }
    start(id) {
        const { scrollLog } = require('./utils/dev-logger');
        const execution = this.find(id);
        if (execution) {
            const cellIdx = execution.execution.cell.index;
            // Guard: don't call .start() again if preVisualStart already triggered it.
            // Record _actualStartTime now so end() can compute the true elapsed duration.
            if (!execution.preVisualStarted) {
                scrollLog(`[queue.start] cell ${cellIdx} — calling .start() (no preVisual)`);
                execution.execution.start(Date.now());
            } else {
                scrollLog(`[queue.start] cell ${cellIdx} — skipping .start() (preVisual already did it); recording actualStartTime`);
            }
            execution._actualStartTime = Date.now();
            execution.started = true;
        } else {
            scrollLog('[queue.start] id not found:', id);
        }
    }
    end(id, succeed) {
        const { scrollLog } = require('./utils/dev-logger');
        const execution = this.find(id);
        if (execution) {
            const cellIdx = execution.execution.cell.index;
            // Only call .start() if neither started nor preVisualStarted has already done so.
            if (!execution.started && !execution.preVisualStarted) {
                execution.execution.start(Date.now());
            }
            // When preVisualStart() was called for all cells at queue-time (kernel-not-running
            // path), execution.start() fired early — VS Code's timer started then.  Adjust
            // the end timestamp so the displayed duration equals only the actual eval time:
            //   endTime = preVisualStartTime + (now - actualStartTime)
            // so: duration = endTime - preVisualStartTime = now - actualStartTime = eval time.
            // Falls back to Date.now() when no preVisual offset is stored (normal path).
            const now = Date.now();
            const endTime = (execution._preVisualStartTime && execution._actualStartTime)
                ? execution._preVisualStartTime + (now - execution._actualStartTime)
                : now;
            try {
                execution.execution.end(succeed, endTime);
                scrollLog(`[queue.end] cell=${cellIdx} succeed=${succeed} OK`);
            } catch (e) {
                scrollLog(`[queue.end] cell=${cellIdx} end() threw: ${e.message}`);
            }
            this.remove(id);
        } else {
            scrollLog(`[queue.end] id not found (already cleared) succeed=${succeed}`);
        }
    }
    getNextPendingExecution() {
        if (this.queue.length > 0 && !(this.queue[0]?.started)) {
            return this.queue[0];
        }
        else {
            return null;
        }
    }
}
exports.ExecutionQueue = ExecutionQueue;
//# sourceMappingURL=notebook-kernel.js.map