// wl-highlight.js — a real Wolfram Language tokenizer for the viewer.
//
// WHY NOT THE EXTENSION'S ONE: `renderer-highlight.js` applies two regexes
// (strings, comments) plus two leaf rules (numbers, anything Capitalised). That
// is fine for a short output snippet, but on a 138-cell notebook it paints every
// capitalised word the same colour, so `Table` and a user's `BSolver2D` are
// indistinguishable — and it has no idea about patterns, slots or operators.
//
// WHY NOT TEXTMATE: running the extension's real grammar in a browser needs
// vscode-textmate plus an Oniguruma WASM build (~800 KB) to interpret regexes
// JS cannot. The part of the grammar that carries the visual weight is its
// builtin-symbol list, and that is plain data — extracted by extract-builtins.mjs.
//
// This is a single-pass character scanner: no backtracking, linear in input, and
// safe to run over every cell of a large notebook.

import { WL_BUILTINS } from './wl-builtins.js';

/** Cells larger than this are left unhighlighted rather than risk a visible stall. */
const MAX_CHARS = 200_000;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s) => s.replace(/[&<>]/g, (c) => ESC[c]);

const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isDigit = (c) => c >= '0' && c <= '9';
const isSymbolChar = (c) => isLetter(c) || isDigit(c) || c === '$';

// Sorted longest-first below, so `===` is never read as `==` followed by `=`.
// Sorting programmatically rather than trusting the literal order: the hand-
// written order had `==` before `===`, which silently mis-tokenised equality.
const OPERATORS = [
  ';;', '///@', '//@', '//.', '@@@', '///', '|->', ':>', '/;', '/.', '->', '<->',
  '==', '!=', '<=', '>=', '===', '=!=', '&&', '||', '^:=', '^=', ':=', '+=', '-=',
  '*=', '/=', '@@', '/@', '//', '<>', '~~', '...', '..', '::', '<<', '>>>', '>>',
  '++', '--', '**', '^^', '+', '-', '*', '/', '^', '=', '<', '>', '!', '&', '|',
  '@', '~', '?', ',', ';', ':', '.',
].sort((a, b) => b.length - a.length);

/**
 * Tokenise Wolfram source into highlighted HTML.
 * @param {string} src
 * @returns {string} HTML with wl-hl-* spans; input is HTML-escaped.
 */
export function highlightWolfram(src) {
  const text = String(src ?? '');
  if (text.length > MAX_CHARS) return esc(text);

  let out = '';
  let i = 0;
  const n = text.length;
  const emit = (cls, s) => { out += cls ? `<span class="wl-hl-${cls}">${esc(s)}</span>` : esc(s); };

  while (i < n) {
    const c = text[i];

    // ── comments, which NEST in Wolfram ──────────────────────────────────
    if (c === '(' && text[i + 1] === '*') {
      const start = i;
      let depth = 0;
      while (i < n) {
        if (text[i] === '(' && text[i + 1] === '*') { depth++; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === ')') { depth--; i += 2; if (!depth) break; continue; }
        i++;
      }
      emit('cmt', text.slice(start, i));
      continue;
    }

    // ── strings ──────────────────────────────────────────────────────────
    if (c === '"') {
      const start = i++;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '"') { i++; break; }
        i++;
      }
      emit('str', text.slice(start, i));
      continue;
    }

    // ── named characters: \[Alpha] ───────────────────────────────────────
    if (c === '\\' && text[i + 1] === '[') {
      const end = text.indexOf(']', i);
      if (end > 0) { emit('esc', text.slice(i, end + 1)); i = end + 1; continue; }
    }

    // ── numbers, including 2^^1010, 1.5`20 and 1.5*^-19 ──────────────────
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1]))) {
      const start = i;
      while (i < n && isDigit(text[i])) i++;
      if (text[i] === '^' && text[i + 1] === '^') {          // base-n literal
        i += 2;
        while (i < n && (isSymbolChar(text[i]) || text[i] === '.')) i++;
      } else {
        if (text[i] === '.' && isDigit(text[i + 1])) { i++; while (i < n && isDigit(text[i])) i++; }
        else if (text[i] === '.' && !isDigit(text[i + 1]) && text[i + 1] !== '.') i++;
        if (text[i] === '`') {                                // precision mark
          i++;
          if (text[i] === '`') i++;
          while (i < n && (isDigit(text[i]) || text[i] === '.')) i++;
        }
        if (text[i] === '*' && text[i + 1] === '^') {          // scientific
          i += 2;
          if (text[i] === '+' || text[i] === '-') i++;
          while (i < n && isDigit(text[i])) i++;
        }
      }
      emit('num', text.slice(start, i));
      continue;
    }

    // ── slots: # ## #3 #name ─────────────────────────────────────────────
    if (c === '#') {
      const start = i++;
      if (text[i] === '#') i++;
      while (i < n && isSymbolChar(text[i])) i++;
      emit('slot', text.slice(start, i));
      continue;
    }

    // ── blanks and patterns: _ __ ___ _Head ──────────────────────────────
    if (c === '_') {
      const start = i;
      while (text[i] === '_') i++;
      while (i < n && isSymbolChar(text[i])) i++;
      emit('pat', text.slice(start, i));
      continue;
    }

    // ── symbols, contexts, and named patterns ────────────────────────────
    if (isLetter(c) || c === '$' || c === '`') {
      const start = i;
      while (i < n && (isSymbolChar(text[i]) || text[i] === '`')) i++;
      const word = text.slice(start, i);

      // `x_` and `x_Head` — the name belongs to the pattern.
      if (text[i] === '_') {
        while (text[i] === '_') i++;
        while (i < n && isSymbolChar(text[i])) i++;
        emit('pat', text.slice(start, i));
        continue;
      }

      // A trailing ` makes it a context prefix (BSolver2D`).
      const bare = word.includes('`') ? word.slice(word.lastIndexOf('`') + 1) : word;
      if (word.includes('`')) {
        emit('ctx', word.slice(0, word.lastIndexOf('`') + 1));
        if (bare) emit(WL_BUILTINS.has(bare) ? 'sym' : 'usr', bare);
      } else {
        emit(WL_BUILTINS.has(word) ? 'sym' : 'usr', word);
      }
      continue;
    }

    // ── brackets ─────────────────────────────────────────────────────────
    if ('[](){}'.includes(c)) { emit('brk', c); i++; continue; }

    // ── operators ────────────────────────────────────────────────────────
    let matched = null;
    for (const op of OPERATORS) {
      if (text.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) { emit('op', matched); i += matched.length; continue; }

    emit(null, c);
    i++;
  }

  return out;
}

/** Highlight a <pre> in place. */
export function highlightWolframInto(pre) {
  const src = pre.textContent;
  if (!src) return;
  pre.innerHTML = highlightWolfram(src);
}
