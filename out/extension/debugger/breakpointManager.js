'use strict';
/**
 * breakpointManager.js  —  Stage 4
 *
 * Manages breakpoint state (lookup table) per notebook cell.
 * Visual markers are provided entirely by VS Code's native breakpoint system;
 * this module no longer renders custom gutter decorations to avoid double-dots.
 * The _map is the authoritative lookup table, kept in sync with VS Code's
 * native SourceBreakpoints via onDidChangeBreakpoints in extension.js.
 */
const vscode = require('vscode');

class BreakpointManager {
    constructor(_context) {
        // uri (string) → Set<number>  (0-based line numbers)
        this._map = new Map();
        this._onChangeCb = null;
    }

    /** (kept for legacy callers — no-op for decoration, only updates _map) */
    toggleBreakpoint(editor) {
        if (!editor) return;
        const uri  = editor.document.uri.toString();
        const line = editor.selection.active.line;
        let set = this._map.get(uri);
        if (!set) { set = new Set(); this._map.set(uri, set); }
        if (set.has(line)) { set.delete(line); }
        else               { set.add(line); }
        if (set.size === 0) this._map.delete(uri);
        if (this._onChangeCb) this._onChangeCb();
    }

    /** Add a breakpoint at a specific URI + line (0-based). Idempotent. */
    addBreakpointAt(uri, line) {
        let set = this._map.get(uri);
        if (!set) { set = new Set(); this._map.set(uri, set); }
        set.add(line);
        if (this._onChangeCb) this._onChangeCb();
    }

    /** Return true if there is a breakpoint at the given URI + line (0-based). */
    hasBreakpointAt(uri, line) {
        return this._map.get(uri)?.has(line) ?? false;
    }

    /** Return the Set<number> of breakpoint line numbers for a cell (0-based), or empty Set. */
    getBreakpointsForCell(cell) {
        const uri = cell.document.uri.toString();
        return this._map.get(uri) || new Set();
    }

    /** Remove all breakpoints for a cell. */
    clearBreakpoints(cell) {
        const uri = cell.document.uri.toString();
        this._map.delete(uri);
        if (this._onChangeCb) this._onChangeCb();
    }

    /** Remove a single breakpoint line for a given URI. */
    removeBreakpointLine(uri, line) {
        const set = this._map.get(uri);
        if (!set) return;
        set.delete(line);
        if (set.size === 0) this._map.delete(uri);
        if (this._onChangeCb) this._onChangeCb();
    }

    /** Clear all breakpoints across all cells. */
    clearAllBreakpoints() {
        this._map.clear();
        if (this._onChangeCb) this._onChangeCb();
    }

    /** Register a callback fired whenever breakpoints change. */
    setOnChange(fn) { this._onChangeCb = fn; }

    /** Return all breakpoints as [{uri, cellLabel, lines}]. */
    getAllBreakpoints() {
        const result = [];
        let idx = 1;
        for (const [uri, lineSet] of this._map) {
            if (lineSet.size > 0) {
                result.push({
                    uri,
                    cellLabel: 'Cell ' + idx,
                    lines: [...lineSet].sort((a, b) => a - b),
                });
                idx++;
            }
        }
        return result;
    }

}


module.exports = { BreakpointManager };
