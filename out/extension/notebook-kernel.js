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
        console.log(`ExecutionQueue.clear() called with ${this.queue.length} items in queue`);
        const itemsToProcess = [...this.queue]; // Make a copy to avoid modification during iteration
        itemsToProcess.forEach((item, index) => {
            console.log(`Clearing execution ${index}: id=${item.id}, started=${item.started}`);
            try {
                this.end(item.id, false);
                console.log(`Successfully ended execution ${index}`);
            } catch (err) {
                console.error(`Failed to end execution ${index}:`, err);
            }
        });
        this.queue = [];
        console.log("ExecutionQueue cleared, queue is now empty");
    }
    push(execution) {
        const id = uuid.v4();
        this.queue.push({ id, execution, hasOutput: false, started: false, preVisualStarted: false, hasLaunchingPlaceholder: false });
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
            try {
                item.execution.start(Date.now());
                console.log(`[preVisualStart] cell ${cellIdx} — spinner started OK`);
            } catch (e) {
                console.error(`[preVisualStart] cell ${cellIdx} — start() threw: ${e.message}`);
            }
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
        const execution = this.find(id);
        if (execution) {
            const cellIdx = execution.execution.cell.index;
            // Guard: don't call .start() again if preVisualStart already triggered it
            if (!execution.preVisualStarted) {
                console.log(`[queue.start] cell ${cellIdx} — calling .start() (no preVisual)`);
                execution.execution.start(Date.now());
            } else {
                console.log(`[queue.start] cell ${cellIdx} — skipping .start() (preVisual already did it)`);
            }
            execution.started = true;
        } else {
            console.warn('[queue.start] id not found:', id);
        }
    }
    end(id, succeed) {
        const execution = this.find(id);
        if (execution) {
            // Only call .start() if neither started nor preVisualStarted has already done so.
            if (!execution.started && !execution.preVisualStarted) {
                execution.execution.start(Date.now());
            }
            execution.execution.end(succeed, Date.now());
            this.remove(id);
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