(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./namedchars'));
  } else {
    root.WolframFormatter = factory(root.WOLFRAM_NAMED_CHARS || {});
  }
}(typeof window !== 'undefined' ? window : global, function(NAMED_CHARS) {
'use strict';
NAMED_CHARS = NAMED_CHARS || {};

/**
 * Wolfram Language Code Formatter
 * 
 * A bracket-depth-aware formatter that understands:
 *  - Strings "..." (no breaking inside)
 *  - Comments (* ... *) including multiline / nested
 *  - Named characters \[Name] (no breaking inside)
 *  - Bracket nesting [ ] ( ) { }
 *  - Semicolons as statement separators
 *  - Commas as argument/list separators
 *  - Operators: =, :=, ->, :>, /., //., //, @@, @@@, <>
 *  - Line width target with smart breaking
 *  - Optional \[Name] -> UTF replacement
 */

// ─── Token types ────────────────────────────────────────────────
const T = {
  WORD:       'WORD',       // identifiers, numbers, operators like +, -, *, /
  STRING:     'STRING',     // "..."
  COMMENT:    'COMMENT',    // (* ... *)
  NAMEDCHAR:  'NAMEDCHAR',  // \[Alpha] etc.
  OPEN:       'OPEN',       // [ ( {
  CLOSE:      'CLOSE',      // ] ) }
  COMMA:      'COMMA',      // ,
  SEMI:       'SEMI',       // ;
  NEWLINE:    'NEWLINE',    // explicit \n in source
  SPACE:      'SPACE',      // whitespace run (not newline)
  ARROW:      'ARROW',      // -> :> 
  RULE_APPLY: 'RULE_APPLY', // /. //.
  ASSIGN:     'ASSIGN',     // = := ^= ^:= 
  POSTFIX:    'POSTFIX',    // //
  SLOT:       'SLOT',       // # ## #1 etc.
  AMP:        'AMP',        // &
  AT:         'AT',         // @ @@ @@@
  STRJOIN:    'STRJOIN',    // <>
  PATTERN:    'PATTERN',    // _ __ ___ _Head
  DOTDOT:     'DOTDOT',     // .. ...
  SPAN:       'SPAN',       // ;;
  COMPARE:    'COMPARE',    // == != >= <= > <
  LOGICAL:    'LOGICAL',    // && ||
  OTHER:      'OTHER',      // anything else
};

// ─── Tokenizer ──────────────────────────────────────────────────

function tokenize(src) {
  const tokens = [];
  const bracketStack = []; // track open brackets for ]] disambiguation
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    // ── Newlines ──
    if (ch === '\n') {
      tokens.push({ type: T.NEWLINE, value: '\n' });
      i++;
      continue;
    }
    if (ch === '\r') {
      if (i + 1 < n && src[i + 1] === '\n') {
        tokens.push({ type: T.NEWLINE, value: '\n' });
        i += 2;
      } else {
        tokens.push({ type: T.NEWLINE, value: '\n' });
        i++;
      }
      continue;
    }

    // ── Whitespace (non-newline) ──
    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
      tokens.push({ type: T.SPACE, value: src.slice(i, j) });
      i = j;
      continue;
    }

    // ── Strings ──
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\' && j + 1 < n) { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        j++;
      }
      tokens.push({ type: T.STRING, value: src.slice(i, j) });
      i = j;
      continue;
    }

    // ── Comments (* ... *) — supports nesting ──
    if (ch === '(' && i + 1 < n && src[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '(' && j + 1 < n && src[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (src[j] === '*' && j + 1 < n && src[j + 1] === ')') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      tokens.push({ type: T.COMMENT, value: src.slice(i, j) });
      i = j;
      continue;
    }

    // ── Named characters \[Name] ──
    if (ch === '\\' && i + 1 < n && src[i + 1] === '[') {
      let j = i + 2;
      while (j < n && src[j] !== ']') j++;
      if (j < n) j++; // consume ]
      tokens.push({ type: T.NAMEDCHAR, value: src.slice(i, j) });
      i = j;
      continue;
    }

    // ── Brackets ──
    // Track bracket stack to disambiguate ]] (Part close vs two ] closes).
    // Also accept 〚 (U+301A) / 〛 (U+301B) as already-rendered Part brackets.
    if (ch === '\u301a') {
      tokens.push({ type: T.OPEN, value: '[[', bracket: 'part' });
      bracketStack.push('[[');
      i++;
      continue;
    }
    if (ch === '\u301b') {
      tokens.push({ type: T.CLOSE, value: ']]', bracket: 'part' });
      if (bracketStack.length > 0 && bracketStack[bracketStack.length - 1] === '[[') bracketStack.pop();
      i++;
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') {
      if (ch === '[' && i + 1 < n && src[i + 1] === '[') {
        tokens.push({ type: T.OPEN, value: '[[', bracket: 'part' });
        bracketStack.push('[[');
        i += 2;
      } else {
        tokens.push({ type: T.OPEN, value: ch });
        bracketStack.push(ch);
        i++;
      }
      continue;
    }
    if (ch === ']' || ch === ')' || ch === '}') {
      if (ch === ']' && i + 1 < n && src[i + 1] === ']') {
        // ]] is Part close ONLY if the top of the bracket stack is [[
        if (bracketStack.length > 0 && bracketStack[bracketStack.length - 1] === '[[') {
          tokens.push({ type: T.CLOSE, value: ']]', bracket: 'part' });
          bracketStack.pop();
          i += 2;
        } else {
          // Two separate ] closes
          tokens.push({ type: T.CLOSE, value: ']' });
          if (bracketStack.length > 0) bracketStack.pop();
          i++;
        }
      } else {
        tokens.push({ type: T.CLOSE, value: ch });
        if (bracketStack.length > 0) bracketStack.pop();
        i++;
      }
      continue;
    }

    // ── Comma ──
    if (ch === ',') {
      tokens.push({ type: T.COMMA, value: ',' });
      i++;
      continue;
    }

    // ── Semicolon or Span ;; ──
    if (ch === ';') {
      if (i + 1 < n && src[i + 1] === ';') {
        tokens.push({ type: T.SPAN, value: ';;' });
        i += 2;
      } else {
        tokens.push({ type: T.SEMI, value: ';' });
        i++;
      }
      continue;
    }

    // ── Multi-char operators (order matters) ──

    // .. and ...
    if (ch === '.' && i + 1 < n && src[i + 1] === '.') {
      if (i + 2 < n && src[i + 2] === '.') {
        tokens.push({ type: T.DOTDOT, value: '...' });
        i += 3;
      } else {
        tokens.push({ type: T.DOTDOT, value: '..' });
        i += 2;
      }
      continue;
    }

    // /. and //.  and // (order matters: check //. before //)
    if (ch === '/' && i + 1 < n && src[i + 1] === '/') {
      if (i + 2 < n && src[i + 2] === '.') {
        tokens.push({ type: T.RULE_APPLY, value: '//.' });
        i += 3;
      } else {
        tokens.push({ type: T.POSTFIX, value: '//' });
        i += 2;
      }
      continue;
    }
    if (ch === '/' && i + 1 < n && src[i + 1] === '.') {
      tokens.push({ type: T.RULE_APPLY, value: '/.' });
      i += 2;
      continue;
    }
    // /@ (Map shorthand — must be checked before single-/ fallthrough)
    if (ch === '/' && i + 1 < n && src[i + 1] === '@') {
      tokens.push({ type: T.AT, value: '/@' });
      i += 2;
      continue;
    }

    // -> and :>
    if (ch === '-' && i + 1 < n && src[i + 1] === '>') {
      tokens.push({ type: T.ARROW, value: '->' });
      i += 2;
      continue;
    }
    if (ch === ':' && i + 1 < n && src[i + 1] === '>') {
      tokens.push({ type: T.ARROW, value: ':>' });
      i += 2;
      continue;
    }
    // → (U+2192, Rule) and ⧴ (U+29F4, RuleDelayed) — emitted by formatter,
    // recognized as the same ARROW tokens so the safety guard accepts them.
    if (ch === '\u2192') {
      tokens.push({ type: T.ARROW, value: '\u2192' });
      i++;
      continue;
    }
    if (ch === '\u29f4') {
      tokens.push({ type: T.ARROW, value: '\u29f4' });
      i++;
      continue;
    }

    // := ^= ^:=
    if (ch === ':' && i + 1 < n && src[i + 1] === '=') {
      tokens.push({ type: T.ASSIGN, value: ':=' });
      i += 2;
      continue;
    }
    if (ch === '^' && i + 1 < n && src[i + 1] === ':' && i + 2 < n && src[i + 2] === '=') {
      tokens.push({ type: T.ASSIGN, value: '^:=' });
      i += 3;
      continue;
    }
    if (ch === '^' && i + 1 < n && src[i + 1] === '=') {
      tokens.push({ type: T.ASSIGN, value: '^=' });
      i += 2;
      continue;
    }
    // == != >= <=  (comparison operators — must come before = check)
    if (ch === '=' && i + 1 < n && src[i + 1] === '=') {
      tokens.push({ type: T.COMPARE, value: '==' });
      i += 2;
      continue;
    }
    if (ch === '!' && i + 1 < n && src[i + 1] === '=') {
      tokens.push({ type: T.COMPARE, value: '!=' });
      i += 2;
      continue;
    }
    if (ch === '>' && i + 1 < n && src[i + 1] === '=') {
      tokens.push({ type: T.COMPARE, value: '>=' });
      i += 2;
      continue;
    }

    // >>> (PutAppend) and >> (Put) — keep together; must follow >= check
    if (ch === '>' && i + 1 < n && src[i + 1] === '>') {
      if (i + 2 < n && src[i + 2] === '>') {
        tokens.push({ type: T.OTHER, value: '>>>' });
        i += 3;
      } else {
        tokens.push({ type: T.OTHER, value: '>>' });
        i += 2;
      }
      continue;
    }
    if (ch === '<' && i + 1 < n && src[i + 1] === '=') {
      tokens.push({ type: T.COMPARE, value: '<=' });
      i += 2;
      continue;
    }
    // = (assignment, but not == which is handled above)
    // =. (Unset) must be checked before plain = so it stays together
    if (ch === '=' && i + 1 < n && src[i + 1] === '.') {
      tokens.push({ type: T.ASSIGN, value: '=.' });
      i += 2;
      continue;
    }
    if (ch === '=') {
      tokens.push({ type: T.ASSIGN, value: '=' });
      i++;
      continue;
    }

    // <> (StringJoin)
    if (ch === '<' && i + 1 < n && src[i + 1] === '>') {
      tokens.push({ type: T.STRJOIN, value: '<>' });
      i += 2;
      continue;
    }

    // << (Get short form — keep together so the formatter doesn't split it)
    if (ch === '<' && i + 1 < n && src[i + 1] === '<') {
      tokens.push({ type: T.OTHER, value: '<<' });
      i += 2;
      continue;
    }

    // @@ @@@ @
    if (ch === '@') {
      if (i + 1 < n && src[i + 1] === '@') {
        if (i + 2 < n && src[i + 2] === '@') {
          tokens.push({ type: T.AT, value: '@@@' });
          i += 3;
        } else {
          tokens.push({ type: T.AT, value: '@@' });
          i += 2;
        }
      } else {
        tokens.push({ type: T.AT, value: '@' });
        i++;
      }
      continue;
    }

    // # ## #1 etc
    if (ch === '#') {
      let j = i + 1;
      while (j < n && (src[j] === '#' || (src[j] >= '0' && src[j] <= '9'))) j++;
      tokens.push({ type: T.SLOT, value: src.slice(i, j) });
      i = j;
      continue;
    }

    // && (And) — must come before single & check
    if (ch === '&' && i + 1 < n && src[i + 1] === '&') {
      tokens.push({ type: T.LOGICAL, value: '&&' });
      i += 2;
      continue;
    }
    // || (Or)
    if (ch === '|' && i + 1 < n && src[i + 1] === '|') {
      tokens.push({ type: T.LOGICAL, value: '||' });
      i += 2;
      continue;
    }

    // &
    if (ch === '&') {
      tokens.push({ type: T.AMP, value: '&' });
      i++;
      continue;
    }

    // _ __ ___ possibly followed by a head name
    if (ch === '_') {
      let j = i;
      while (j < n && src[j] === '_') j++;
      // optionally followed by identifier
      while (j < n && /[a-zA-Z0-9$`]/.test(src[j])) j++;
      tokens.push({ type: T.PATTERN, value: src.slice(i, j) });
      i = j;
      continue;
    }

    // ⩵ (U+2A75, Equal) — display replacement for ==, recognized as COMPARE token.
    // Must be before the non-ASCII word handler so it isn't swallowed as an identifier.
    if (ch === '\u2a75') {
      tokens.push({ type: T.COMPARE, value: '\u2a75' });
      i++;
      continue;
    }

    // ── Identifiers and numbers ──
    // Non-ASCII characters (Greek letters, etc.) are valid WL identifier chars,
    // but NOT the special bracket replacements 〚 (U+301A), 〛 (U+301B), or ⩵ (U+2A75).
    if (/[a-zA-Z$]/.test(ch) || (ch.codePointAt(0) > 127 && ch !== '\u301a' && ch !== '\u301b' && ch !== '\u2a75')) {
      let j = i;
      while (j < n && (/[a-zA-Z0-9$`]/.test(src[j]) ||
             (src[j].codePointAt(0) > 127 && src[j] !== '\u301a' && src[j] !== '\u301b' && src[j] !== '\u2a75'))) j++;
      tokens.push({ type: T.WORD, value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Numbers (including decimals like 3.14, and precision like 2^^101)
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < n && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      // integer part
      while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      // precision/accuracy marks (backtick only — * is NOT a precision mark; *^ is handled below)
      if (j < n && src[j] === '`') {
        j++;
        while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      }
      // base notation ^^
      if (j + 1 < n && src[j] === '^' && src[j + 1] === '^') {
        j += 2;
        while (j < n && /[0-9a-fA-F.]/.test(src[j])) j++;
      }
      // scientific notation *^
      if (j + 1 < n && src[j] === '*' && src[j + 1] === '^') {
        j += 2;
        if (j < n && (src[j] === '+' || src[j] === '-')) j++;
        while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      }
      tokens.push({ type: T.WORD, value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Compound assignments: *= /= += -= (TimesBy, DivideBy, AddTo, SubtractFrom)
    if ((ch === '*' || ch === '/' || ch === '+' || ch === '-') && i + 1 < n && src[i + 1] === '=') {
      tokens.push({ type: T.ASSIGN, value: ch + '=' });
      i += 2;
      continue;
    }

    // ++ -- (Increment/Decrement — unary, no surrounding spaces)
    if ((ch === '+' || ch === '-') && i + 1 < n && src[i + 1] === ch) {
      tokens.push({ type: T.OTHER, value: ch + ch });
      i += 2;
      continue;
    }

    // ? — Information query glob (?WBPrint, ?WB*, ?*Name*) — keep entire glob as one token
    // so the formatter never inserts spaces within ?symbol* patterns.
    if (ch === '?') {
      const peek = i + 1 < n ? src[i + 1] : '';
      if (/[a-zA-Z$]/.test(peek) || peek === '*' || peek.codePointAt(0) > 127) {
        let j = i + 1;
        while (j < n && (/[a-zA-Z0-9$`_*]/.test(src[j]) || src[j].codePointAt(0) > 127)) j++;
        tokens.push({ type: T.WORD, value: src.slice(i, j) });
        i = j;
      } else {
        tokens.push({ type: T.OTHER, value: '?' });
        i++;
      }
      continue;
    }

    // ── Everything else (single char operators: + - * / ^ ! ~ ' etc) ──
    tokens.push({ type: T.OTHER, value: ch });
    i++;
  }

  return tokens;
}

// ─── Formatter ──────────────────────────────────────────────────

const DEFAULT_OPTIONS = {
  lineWidth: 90,
  indentString: '    ',       // 4 spaces
  newlineAfterSemi: true,     // newline after ; at top level
  newlineAfterComma: 'auto',  // 'auto' | 'always' | 'never'
  compactBrackets: true,      // keep short arg lists on one line
  alignArrows: false,         // align -> in rule lists
  blankLineBetweenDefs: true, // blank line between top-level := definitions
  replaceNamedChars: false,   // replace \[Alpha] etc. with UTF characters
  replaceMultiply: false,     // replace * (Times) with implicit-multiplication space
  replacePartBrackets: false, // replace [[ ]] with 〚 〛 (U+301A / U+301B)
};

// ─── Statement splitter (same algorithm as execution/checkout.js) ────────────
// Splits src into top-level statements on bare newlines, respecting:
//   • bracket depth  • strings  • (* comments *)  • continuation operators
// Returns [{text, blankLinesBefore}].  Single-statement src returns [{text:src,0}].
function splitStatements(src) {
  const ENDS_OP = /(&&|\|\||->|:>|\u2192|\u29f4|\/\/\.|\/\/|\/@|@@|<>|~~|;;|\^:=|:=|\+=|-=|\*=|\/=|[+\-*\/=,|~@?])$/;
  const parts = [];
  let current = '';
  let depth = 0, inStr = false, cDepth = 0;
  let i = 0;
  const n = src.length;
  let blankLinesBefore = 0; // blank lines that precede the next part

  while (i < n) {
    const ch   = src[i];
    const next = i + 1 < n ? src[i + 1] : '';

    if (inStr) {
      current += ch;
      if (ch === '\\' && i + 1 < n) { current += next; i += 2; continue; }
      if (ch === '"') inStr = false;
      i++; continue;
    }
    if (cDepth > 0) {
      current += ch;
      if (ch === '(' && next === '*') { cDepth++; current += next; i += 2; continue; }
      if (ch === '*' && next === ')') { cDepth--; current += next; i += 2; continue; }
      i++; continue;
    }

    if      (ch === '"')                    { inStr = true;  current += ch; i++; }
    else if (ch === '(' && next === '*')    { cDepth = 1;    current += ch + next; i += 2; }
    else if (ch === '<' && next === '|')    { depth++;       current += ch + next; i += 2; }
    else if (ch === '|' && next === '>')    { depth--;       current += ch + next; i += 2; }
    else if ('([{'.includes(ch))            { depth++;       current += ch; i++; }
    else if (')]}'.includes(ch))            { depth--;       current += ch; i++; }
    else if ((ch === '\n' || ch === '\r') && depth === 0 && cDepth === 0) {
      const trimmed = current.trim();
      // Peek at first non-space char(s) of the next line
      let peekPos = i + 1;
      if (ch === '\r' && next === '\n') peekPos++;
      while (peekPos < n && (src[peekPos] === ' ' || src[peekPos] === '\t')) peekPos++;
      const peekCh  = peekPos < n ? src[peekPos] : '';
      const peekTwo = peekPos + 1 < n ? src.slice(peekPos, peekPos + 2) : peekCh;
      const endsWithOp  = trimmed.length > 0 && ENDS_OP.test(trimmed);
      const startsWithOp = trimmed.length > 0 && peekCh.length > 0 && (
        '=+-*/,|~@?'.includes(peekCh) ||
        peekTwo === '&&' || peekTwo === '||' || peekTwo === '->' || peekTwo === ':>' ||
        peekTwo === '//' || peekTwo === '<>' || peekTwo === '!=' || peekTwo === '>=' || peekTwo === '<='
      );
      if (endsWithOp || startsWithOp) {
        // Continuation line — join with a space
        current += ' ';
        if (ch === '\r' && next === '\n') i++;
        i++;
      } else {
        // Split point
        if (ch === '\r' && next === '\n') i++;
        i++;
        // Consume remaining blank lines to record how many follow this part
        let newlines = 1;
        while (i < n) {
          if (src[i] === ' ' || src[i] === '\t') { i++; continue; }
          if (src[i] === '\n') { newlines++; i++; continue; }
          if (src[i] === '\r') {
            newlines++;
            if (i + 1 < n && src[i + 1] === '\n') i++;
            i++; continue;
          }
          break;
        }
        if (trimmed.length > 0) {
          parts.push({ text: trimmed, blankLinesBefore });
        }
        blankLinesBefore = Math.max(0, newlines - 1);
        current = '';
      }
    } else {
      current += ch; i++;
    }
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) parts.push({ text: trimmed, blankLinesBefore });
  return parts.length > 0 ? parts : [{ text: src, blankLinesBefore: 0 }];
}

// Compare two token streams for semantic equivalence, ignoring only
// whitespace (SPACE, NEWLINE). Any other difference (added/removed/changed
// token, including commas, semicolons, brackets, operators, identifiers)
// means the formatter would alter parsed meaning.
// Canonical value for equivalence comparison: maps display-Unicode operators
// back to their ASCII source forms so the safety guard doesn't reject them.
function canonicalValue(t) {
  if (t.type === T.ARROW) {
    if (t.value === '\u2192') return '->'; // → → ->
    if (t.value === '\u29f4') return ':>'; // ⧴ → :>
  }
  // 〚 / 〛 are display replacements for [[ / ]] — treat as equivalent for guard.
  if (t.type === T.OPEN  && t.value === '\u301a') return '[[';
  if (t.type === T.CLOSE && t.value === '\u301b') return ']]';
  // ⩵ (U+2A75, Equal) — display replacement for == — treat as equivalent for guard.
  if (t.type === T.COMPARE && t.value === '\u2a75') return '==';
  return t.value;
}

function tokensEquivalent(a, b) {
  const filter = (toks) => toks.filter(t => t.type !== T.SPACE && t.type !== T.NEWLINE);
  const A = filter(a), B = filter(b);
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) {
    if (A[i].type !== B[i].type) return false;
    if (canonicalValue(A[i]) !== canonicalValue(B[i])) return false;
  }
  return true;
}

function format(src, opts) {
  try {
    const inputStmtCount = splitStatements(src).length;
    const result = _formatUnsafe(src, opts);
    // Guard 1: token equivalence — no non-whitespace tokens may be added/removed/changed.
    // When replaceNamedChars is true, pre-apply the same \[Name]→UTF transformation
    // to the input before tokenizing, so that NAMEDCHAR+adjacent-WORD merges
    // (e.g. \[CurlyTheta]1 → ϑ1) are handled identically on both sides.
    const mergedOpts = { ...DEFAULT_OPTIONS, ...opts };
    const srcForCmp = mergedOpts.replaceNamedChars
      ? src.replace(/\\\[([A-Za-z]+)\]/g, (_, name) => {
          const code = NAMED_CHARS[name];
          return code ? String.fromCodePoint(code) : '\\[' + name + ']';
        })
      : src;
    // Filter standalone * tokens when replaceMultiply is on (they become implicit spaces).
    // Preserve *= (TimesBy): * followed by = ASSIGN token.
    const filterMultiply = mergedOpts.replaceMultiply
      ? (toks) => {
          const out = [];
          for (let i = 0; i < toks.length; i++) {
            if (toks[i].type === T.OTHER && toks[i].value === '*') {
              let j = i + 1;
              while (j < toks.length && (toks[j].type === T.SPACE || toks[j].type === T.NEWLINE)) j++;
              const nxt = toks[j];
              if (nxt && nxt.type === T.ASSIGN && nxt.value === '=') out.push(toks[i]);
              // else drop standalone *
            } else {
              out.push(toks[i]);
            }
          }
          return out;
        }
      : (toks) => toks;
    const inTokens  = filterMultiply(tokenize(srcForCmp));
    const outTokens = filterMultiply(tokenize(result));
    if (!tokensEquivalent(inTokens, outTokens)) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[wl-formatter] token mismatch after formatting — returning original source');
      }
      return src;
    }
    // Guard 2: statement count must not decrease (merging separate expressions is wrong).
    const outputStmtCount = splitStatements(result).length;
    if (outputStmtCount < inputStmtCount) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[wl-formatter] statement count decreased (' + inputStmtCount + ' -> ' + outputStmtCount + ') — returning original source');
      }
      return src;
    }
    return result;
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[wl-formatter] formatting error — returning original source:', e && e.message);
    }
    return src;
  }
}

// _formatSingle: format one statement (no top-level splitting).
// This is the original _formatUnsafe body.
function _formatSingle(src, opts) {
  opts = { ...DEFAULT_OPTIONS, ...opts };
  const tokens = tokenize(src);
  const indentStr = opts.indentString;
  const indentW   = indentStr.length;
  const maxW      = opts.lineWidth;

  // ── Step 1: strip whitespace tokens; keep provenance for blank lines ──
  const toks = [];
  {
    let hadSpace = false;
    let nlCount  = 0;
    for (const t of tokens) {
      if (t.type === T.SPACE) { hadSpace = true; continue; }
      if (t.type === T.NEWLINE) { hadSpace = true; nlCount++; continue; }
      toks.push({
        ...t,
        hadSpaceBefore: hadSpace,
        blankLinesBefore: Math.max(0, nlCount - 1),
      });
      hadSpace = false;
      nlCount  = 0;
    }
  }

  // ── Step 1b: mark unary +/- tokens (preceded by nothing, an opener,
  // a comma/semi, or another operator). These never take a space before
  // the following operand.
  {
    const startsExpr = (p) => !p ||
      p.type === T.OPEN || p.type === T.COMMA || p.type === T.SEMI ||
      p.type === T.ASSIGN || p.type === T.ARROW || p.type === T.COMPARE ||
      p.type === T.LOGICAL || p.type === T.RULE_APPLY || p.type === T.POSTFIX ||
      p.type === T.AT || p.type === T.STRJOIN ||
      (p.type === T.OTHER && /^(\+|-|\*|\/|\^)$/.test(p.value));
    let prev = null;
    for (const t of toks) {
      if (t.type === T.OTHER && (t.value === '+' || t.value === '-') && startsExpr(prev)) {
        t.isUnary = true;
      }
      if (t.type !== T.COMMENT) prev = t;
    }
  }

  // ── Step 2: match brackets ──
  const closeOf = new Map(); // open-index  -> close-index
  const openOf  = new Map(); // close-index -> open-index
  {
    const stack = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === T.OPEN) stack.push(i);
      else if (t.type === T.CLOSE) {
        const o = stack.pop();
        if (o !== undefined) { closeOf.set(o, i); openOf.set(i, o); }
      }
    }
  }

  // Optional \[Name] → UTF on emission; also render -> as → and :> as ⧴,
  // and (when replacePartBrackets) [[ / ]] as 〚 / 〛.
  function renderToken(t) {
    if (t.type === T.NAMEDCHAR && opts.replaceNamedChars) {
      const code = NAMED_CHARS[t.value.slice(2, -1)];
      if (code) return String.fromCodePoint(code);
    }
    if (t.type === T.ARROW) {
      if (t.value === '->') return '\u2192';   // →
      if (t.value === ':>') return '\u29f4';   // ⧴
    }
    if (opts.replacePartBrackets) {
      if (t.type === T.OPEN  && t.value === '[[') return '\u301a';  // 〚
      if (t.type === T.CLOSE && t.value === ']]') return '\u301b';  // 〛
    }
    // ⩵ (U+2A75) ↔ == : UTF path converts == → ⩵; src path normalizes ⩵ → ==
    if (t.type === T.COMPARE) {
      if (opts.replaceNamedChars && (t.value === '==' || t.value === '\u2a75')) return '\u2a75'; // ⩵
      if (t.value === '\u2a75') return '==';
    }
    return t.value;
  }

  // ── Spacing rules between adjacent tokens (unchanged from old formatter) ──
  function needsSpace(a, b) {
    if (!a || !b) return false;
    if (a._implicitMult) return false; // space already emitted for * → implicit mult
    if (b.type === T.COMMA || b.type === T.SEMI || b.type === T.SPAN) return false;
    if (a.type === T.COMMA) return true;
    if (a.type === T.SEMI) return true;
    if (a.type === T.SPAN || b.type === T.SPAN) return false;
    if (a.type === T.LOGICAL || b.type === T.LOGICAL) return true;
    if (a.type === T.COMPARE || b.type === T.COMPARE) return true;
    if (a.type === T.ARROW || b.type === T.ARROW) return true;
    if (a.type === T.ASSIGN || b.type === T.ASSIGN) return true;
    if (a.type === T.RULE_APPLY || b.type === T.RULE_APPLY) return true;
    if (a.type === T.STRJOIN || b.type === T.STRJOIN) return true;
    if (b.type === T.OPEN && (b.value === '[' || b.value === '[[' || b.value === '\u301a') &&
        (a.type === T.WORD || a.type === T.NAMEDCHAR || a.type === T.CLOSE || a.type === T.SLOT)) return false;
    if (a.type === T.OPEN) return false;
    if (b.type === T.CLOSE) return false;
    if (a.type === T.SLOT) return false;
    if (b.type === T.PATTERN && a.type === T.WORD) return false;
    if (a.type === T.PATTERN) return false;
    // Preserve source's implicit-multiplication vs identifier-glue disambiguation.
    if (a.type === T.NAMEDCHAR && b.type === T.WORD) return !!b.hadSpaceBefore;
    if (a.type === T.WORD && b.type === T.NAMEDCHAR) return !!b.hadSpaceBefore;
    if (a.type === T.NAMEDCHAR && b.type === T.NAMEDCHAR) return !!b.hadSpaceBefore;
    if (a.type === T.WORD && b.type === T.WORD) {
      if (b.value.codePointAt(0) > 127 || a.value.codePointAt(0) > 127) return !!b.hadSpaceBefore;
      return true;
    }
    if (b.type === T.AMP) return false;
    if (b.type === T.OTHER && b.value === "'") return false;
    if (a.type === T.OTHER && (a.value === '++' || a.value === '--')) return false;
    if (b.type === T.OTHER && (b.value === '++' || b.value === '--')) return false;
    // Unary +/- : no space between the sign and the operand that follows.
    if (a.type === T.OTHER && (a.value === '+' || a.value === '-') && a.isUnary) return false;
    if (a.type === T.OTHER && (a.value === '+' || a.value === '-')) return true;
    if (b.type === T.OTHER && (b.value === '+' || b.value === '-')) return true;
    if (a.type === T.OTHER && (a.value === '>' || a.value === '<' || a.value === '<<' || a.value === '>>' || a.value === '>>>')) return true;
    if (b.type === T.OTHER && (b.value === '>' || b.value === '<' || b.value === '<<' || b.value === '>>' || b.value === '>>>')) return true;
    if (a.type === T.OTHER && (a.value === '*' || a.value === '/')) return true;
    if (b.type === T.OTHER && (b.value === '*' || b.value === '/')) return true;
    if (a.value === '^' || b.value === '^') return false;
    if ((a.type === T.WORD || a.type === T.NAMEDCHAR || a.type === T.STRING || a.type === T.CLOSE || a.type === T.AMP) &&
        (b.type === T.WORD || b.type === T.NAMEDCHAR || b.type === T.STRING ||
         (b.type === T.OPEN && b.value === '('))) return true;
    if (a.type === T.POSTFIX || b.type === T.POSTFIX) return true;
    if (a.type === T.AT || b.type === T.AT) return true;
    if (a.type === T.COMMENT || b.type === T.COMMENT) return true;
    return false;
  }

  // ── Step 3: Doc IR (Wadler-style pretty-printer) ──
  //   nil, text(s), line(flat), softline(), hardline(),
  //   nest(n, d), group(d), cat(...docs)
  const D = {
    nil:      () => ({ t: 'nil' }),
    text:     (s) => (s === '' ? { t: 'nil' } : { t: 'text', s }),
    line:     (flat = ' ') => ({ t: 'line', flat }),
    softline: () => ({ t: 'line', flat: '' }),
    hardline: () => ({ t: 'hardline' }),
    nest:     (n, d) => ({ t: 'nest', n, d }),
    group:    (d) => ({ t: 'group', d, forceBreak: containsHardline(d) }),
    cat:      (...docs) => {
      const flat = [];
      for (const d of docs) {
        if (!d || d.t === 'nil') continue;
        if (d.t === 'cat') flat.push(...d.docs); else flat.push(d);
      }
      if (flat.length === 0) return { t: 'nil' };
      if (flat.length === 1) return flat[0];
      return { t: 'cat', docs: flat };
    },
  };

  // A group that (transitively, outside any inner group) contains a hardline
  // must always render in break mode — otherwise `fits` would short-circuit
  // true on the hardline and the enclosing group would render flat but the
  // hardline would still emit a newline, producing broken output.
  function containsHardline(d) {
    if (!d) return false;
    switch (d.t) {
      case 'hardline': return true;
      case 'cat':      return d.docs.some(containsHardline);
      case 'nest':     return containsHardline(d.d);
      case 'group':    return false; // inner group's own check handles it
      default:         return false;
    }
  }

  // Flat length of a doc (group-aware). Used to decide whether a group
  // fits on the current line.
  function flatLen(d) {
    if (!d) return 0;
    if (d._flatLen !== undefined) return d._flatLen;
    let n = 0;
    switch (d.t) {
      case 'nil':      n = 0; break;
      case 'text':     n = d.s.length; break;
      case 'hardline': n = Infinity; break;
      case 'line':     n = d.flat.length; break;
      case 'nest':     n = flatLen(d.d); break;
      case 'cat':      for (const c of d.docs) n += flatLen(c); break;
      case 'group':    n = d.forceBreak ? Infinity : flatLen(d.d); break;
    }
    d._flatLen = n;
    return n;
  }

  // Does `doc` fit when rendered flat starting at column `col`?
  // Per-group decision: a group goes flat iff its OWN flat content fits in
  // the remaining width. Subsequent siblings on the same line are not
  // considered (they will themselves be groups or texts that handle their
  // own line management). This avoids the cascade where a long outer group
  // forces every tiny inner group to break.
  function groupFits(groupContent, col) {
    return flatLen(groupContent) <= (maxW - col);
  }

  function layout(doc) {
    let out = '';
    let col = 0;
    const stack = [[0, 'break', doc]];
    while (stack.length) {
      const [ind, mode, d] = stack.pop();
      switch (d.t) {
        case 'nil': break;
        case 'text': out += d.s; col += d.s.length; break;
        case 'hardline': out += '\n' + ' '.repeat(ind); col = ind; break;
        case 'line':
          if (mode === 'flat') { out += d.flat; col += d.flat.length; }
          else { out += '\n' + ' '.repeat(ind); col = ind; }
          break;
        case 'nest': stack.push([ind + d.n, mode, d.d]); break;
        case 'cat':
          for (let j = d.docs.length - 1; j >= 0; j--) stack.push([ind, mode, d.docs[j]]);
          break;
        case 'group': {
          if (d.forceBreak) { stack.push([ind, 'break', d.d]); break; }
          if (groupFits(d.d, col)) stack.push([ind, 'flat', d.d]);
          else                     stack.push([ind, 'break', d.d]);
          break;
        }
      }
    }
    return out;
  }

  // ── Step 4: build Doc from token range ──
  // Operator precedence classes (weakest first). Each class lists predicates
  // returning true when token `t` is a splittable operator at that class.
  // Ordered from LOOSEST (split first) to TIGHTEST, matching Wolfram operator
  // precedences. Note: /. (~110) is looser than -> (~120), so RULE_APPLY must
  // come before ARROW.
  const OP_CLASSES = [
    // :=, =, ^=, ^:=   (Set / SetDelayed / etc., prec ~40)
    (t) => t.type === T.ASSIGN && t.value !== '=.',
    // //              (Postfix application, prec ~70)
    (t) => t.type === T.POSTFIX,
    // /., //.          (ReplaceAll / ReplaceRepeated, prec ~110)
    (t) => t.type === T.RULE_APPLY,
    // ->, :>           (Rule / RuleDelayed, prec ~120)
    (t) => t.type === T.ARROW,
    // ||               (Or, prec ~215)
    (t) => t.type === T.LOGICAL && t.value === '||',
    // &&               (And, prec ~225)
    (t) => t.type === T.LOGICAL && t.value === '&&',
    // ==, !=, <, >, <=, >=  (Equal/Unequal/etc., prec ~290)
    (t) => t.type === T.COMPARE,
    // +, -             (Plus / Minus, prec ~310)
    (t) => t.type === T.OTHER && (t.value === '+' || t.value === '-'),
    // *, /             (Times / Divide, prec ~400)
    (t) => t.type === T.OTHER && (t.value === '*' || t.value === '/'),
    // <>               (StringJoin, prec ~600)
    (t) => t.type === T.STRJOIN,
    // @, @@, @@@, /@   (Prefix / Apply, prec ~640)
    (t) => t.type === T.AT,
  ];

  // Find top-level (bracket depth 0 within [from,to]) indices of each operator
  // at the weakest present class. Returns { class, indices } or null.
  function findTopLevelSplits(from, to) {
    // collect depth-0 positions
    const depthZero = [];
    let depth = 0;
    for (let i = from; i <= to; i++) {
      const t = toks[i];
      if (t.type === T.OPEN) { depth++; continue; }
      if (t.type === T.CLOSE) { depth--; continue; }
      if (depth === 0) depthZero.push(i);
    }
    // semicolons handled separately — but if a ; appears at this depth, it means
    // we have CompoundExpression; caller splits first.
    for (const test of OP_CLASSES) {
      const idx = [];
      for (const i of depthZero) {
        const t = toks[i];
        if (!test(t)) continue;
        // Reject unary +/- as split points.
        if (t.type === T.OTHER && (t.value === '+' || t.value === '-') && t.isUnary) continue;
        idx.push(i);
      }
      if (idx.length > 0) return idx;
    }
    return null;
  }

  function prevSigIndex(i, from) {
    let j = i - 1;
    while (j >= from && toks[j].type === T.COMMENT) j--;
    return j;
  }

  // Find top-level COMMA positions within [from, to].
  function findCommas(from, to) {
    const out = [];
    let depth = 0;
    for (let i = from; i <= to; i++) {
      const t = toks[i];
      if (t.type === T.OPEN) { depth++; continue; }
      if (t.type === T.CLOSE) { depth--; continue; }
      if (depth === 0 && t.type === T.COMMA) out.push(i);
    }
    return out;
  }

  // Find top-level SEMI positions within [from, to].
  function findSemis(from, to) {
    const out = [];
    let depth = 0;
    for (let i = from; i <= to; i++) {
      const t = toks[i];
      if (t.type === T.OPEN) { depth++; continue; }
      if (t.type === T.CLOSE) { depth--; continue; }
      if (depth === 0 && t.type === T.SEMI) out.push(i);
    }
    return out;
  }

  // Build a Doc for the token range [from, to] inclusive. Handles (in order):
  //   1. statement separation by ';'
  //   2. comma separation (argList = true)
  //   3. weakest binary operator split
  //   4. walk tokens linearly, descending into brackets
  // `argList`: true when we are rendering the inside of a bracket-pair whose
  // separator is comma (function-call args, list, assoc).
  function docForRange(from, to, argList) {
    if (from > to) return D.nil();

    // (1) semicolons at this level → CompoundExpression
    const semis = findSemis(from, to);
    if (semis.length > 0 && !argList) {
      const parts = [];
      let s = from;
      for (const si of semis) {
        parts.push(docForRange(s, si - 1, false));
        s = si + 1;
      }
      // s > to means the range ended with ';' (trailing semicolon, e.g. Do[Print[...];, …]).
      // Record this so we can re-emit it after the last part — otherwise it would be dropped.
      const trailingHadSemi = (s > to);
      if (s <= to) parts.push(docForRange(s, to, false));
      // Join with ';' + hardline (preserving blank lines between top-level stmts).
      const joined = [];
      for (let k = 0; k < parts.length; k++) {
        if (k > 0) {
          // find the first significant token of parts[k] to see blankLinesBefore
          const firstTokIdx = semis[k - 1] + 1 <= to
            ? findFirstNonCommentIndex(semis[k - 1] + 1, to)
            : -1;
          const blanks = firstTokIdx >= 0 ? toks[firstTokIdx].blankLinesBefore : 0;
          joined.push(D.text(';'));
          joined.push(D.hardline());
          for (let _ = 0; _ < blanks; _++) joined.push(D.hardline());
        }
        joined.push(parts[k]);
      }
      // Re-emit trailing ';' when the range ended with one (e.g. the body of Do[expr;, iter]).
      if (trailingHadSemi) joined.push(D.text(';'));
      return D.cat(...joined);
    }

    // (2) commas (only if we're an arg list)
    if (argList) {
      const commas = findCommas(from, to);
      if (commas.length > 0) {
        const parts = [];
        let s = from;
        for (const ci of commas) {
          parts.push(docForRange(s, ci - 1, false));
          s = ci + 1;
        }
        if (s <= to) parts.push(docForRange(s, to, false));
        // Render as: a, <line> b, <line> c    (inside a group)
        const joined = [];
        for (let k = 0; k < parts.length; k++) {
          if (k > 0) joined.push(D.text(','), D.line());
          joined.push(parts[k]);
        }
        return D.cat(...joined);
      }
      // single arg — fall through
    }

    // (3) weakest binary operator split
    const opIdxs = findTopLevelSplits(from, to);
    if (opIdxs && opIdxs.length > 0) {
      // Classify break style for the operator at opIdxs[0].
      // - ASSIGN (:= = ^= ^:=) and ARROW (-> :>)  →  op clings to LHS, RHS on next line indented.
      //     lhs := <line>
      //         rhs
      // - Others (+ - * / /. // @ <> && || == etc.)  →  op starts the new line (math convention).
      //     lhs <line>
      //     op rhs
      const firstOp = toks[opIdxs[0]];
      const clingLeft = (firstOp.type === T.ASSIGN || firstOp.type === T.ARROW);

      const parts = [];
      let s = from;
      for (const oi of opIdxs) {
        parts.push({ operand: [s, oi - 1], opIdx: oi });
        s = oi + 1;
      }
      parts.push({ operand: [s, to], opIdx: null });

      if (clingLeft) {
        // Only a single assignment/arrow split is meaningful at a given level
        // (chained `a = b = c` is rare; render it the same way).
        const pieces = [];
        for (let k = 0; k < parts.length; k++) {
          const [a, b] = parts[k].operand;
          if (k > 0) {
            const opTok = toks[parts[k - 1].opIdx];
            pieces.push(D.text(' ' + renderToken(opTok)));
            pieces.push(D.nest(indentW, D.cat(D.line(' '), docForRange(a, b, false))));
          } else {
            pieces.push(docForRange(a, b, false));
          }
        }
        return D.group(D.cat(...pieces));
      }

      // Break-at-start style (+, -, *, /, etc.)
      // Render the first operand flat, then wrap all remaining op+operand
      // pairs in a sub-group so they try to stay on one line together before
      // resorting to per-item breaks (e.g. two /. rules stay on one line).
      const [a0, b0] = parts[0].operand;
      const firstDoc = docForRange(a0, b0, false);
      if (parts.length === 1) return firstDoc;

      // When replaceMultiply is on and ALL operators in this group are * (and
      // none is part of *=), render them as implicit multiplication (plain space).
      if (opts.replaceMultiply && opIdxs.every(oi => {
        const t = toks[oi];
        if (t.type !== T.OTHER || t.value !== '*') return false;
        // *=  (TimesBy) must not be treated as implicit multiply
        const nxt = toks[oi + 1];
        return !(nxt && nxt.type === T.ASSIGN && nxt.value === '=');
      })) {
        const implPieces = [firstDoc];
        for (let k = 1; k < parts.length; k++) {
          implPieces.push(D.text(' '));
          const [a, b] = parts[k].operand;
          implPieces.push(docForRange(a, b, false));
        }
        return D.cat(...implPieces);
      }

      const tailPieces = [];
      for (let k = 1; k < parts.length; k++) {
        if (k > 1) tailPieces.push(D.line(' '));
        const opTok = toks[parts[k - 1].opIdx];
        tailPieces.push(D.text(renderToken(opTok) + ' '));
        const [a, b] = parts[k].operand;
        tailPieces.push(docForRange(a, b, false));
      }
      const tailDoc = D.group(D.cat(...tailPieces));
      return D.group(D.cat(firstDoc, D.line(' '), tailDoc));
    }

    // (4) walk tokens linearly: brackets become nested docs.
    return walkTokens(from, to);
  }

  function findFirstNonCommentIndex(from, to) {
    for (let i = from; i <= to; i++) if (toks[i].type !== T.COMMENT) return i;
    return -1;
  }

  // Walk tokens [from, to] linearly; descend into brackets recursively.
  function walkTokens(from, to) {
    const pieces = [];
    let i = from;
    let prev = null;
    while (i <= to) {
      const t = toks[i];

      if (t.type === T.OPEN) {
        const close = closeOf.get(i);
        if (close !== undefined && close <= to) {
          // Space before bracket if needed (mainly before '(' after a word).
          if (prev && needsSpace(prev, t)) pieces.push(D.text(' '));
          // Determine separator kind inside this bracket.
          const isArgBracket = (t.value === '[' || t.value === '[[' ||
                                t.value === '{' || t.value === '(');
          // For parentheses used as grouping (no commas), argList=false.
          const inner = docForRange(i + 1, close - 1, isArgBracket);
          // Rendering style:
          //   open  nest(indent, softline + inner) softline  close
          const doc = D.group(
            D.cat(
              D.text(renderToken(t)),
              D.nest(indentW, D.cat(D.softline(), inner)),
              D.softline(),
              D.text(renderToken(toks[close]))
            )
          );
          pieces.push(doc);
          prev = toks[close];
          i = close + 1;
          continue;
        }
      }

      if (t.type === T.COMMENT) {
        // Comments: if original source had newlines around them, use hardlines.
        if (t.blankLinesBefore > 0 || (prev && t.hadSpaceBefore /* conservative */)) {
          // Put space before comment if on same line.
          if (prev && needsSpace(prev, t)) pieces.push(D.text(' '));
        } else if (prev && needsSpace(prev, t)) {
          pieces.push(D.text(' '));
        }
        pieces.push(D.text(t.value));
        prev = t;
        i++;
        continue;
      }

      // Replace * with implicit multiplication (space) when replaceMultiply is on.
      // Exception: *=  (TimesBy) — detected by checking toks[i+1] for ASSIGN '='.
      if (opts.replaceMultiply && t.type === T.OTHER && t.value === '*') {
        const nextTok = toks[i + 1];
        const isTimesBy = nextTok && nextTok.type === T.ASSIGN && nextTok.value === '=';
        if (!isTimesBy) {
          if (prev) pieces.push(D.text(' '));
          prev = { type: T.OTHER, value: '', _implicitMult: true };
          i++;
          continue;
        }
      }

      // Plain token.
      if (prev && needsSpace(prev, t)) pieces.push(D.text(' '));
      pieces.push(D.text(renderToken(t)));
      prev = t;
      i++;
    }
    return D.cat(...pieces);
  }

  // ── Step 5: split the whole file into top-level statements and render. ──
  // Preserve blank lines and top-level comments between statements.
  function formatAll() {
    if (toks.length === 0) return '';

    const out = [];
    // Find statement boundaries (top-level `;`). Also treat runs of
    // comment-only tokens as separate statements so they stay in place.
    const stmts = [];
    let start = 0;
    let depth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === T.OPEN)  depth++;
      else if (t.type === T.CLOSE) depth--;
      else if (depth === 0 && t.type === T.SEMI) {
        // Look ahead for trailing comments on the same line (blankLinesBefore===0).
        // Keep them inline with the statement rather than as a new statement.
        let j = i + 1;
        const trailComments = [];
        while (j < toks.length && toks[j].type === T.COMMENT && toks[j].blankLinesBefore === 0) {
          trailComments.push(j);
          j++;
        }
        stmts.push({ from: start, to: i - 1, trailingSemi: true, trailComments });
        start = j;
        i = j - 1; // loop will i++
      } else if (depth === 0 && i > start && t.blankLinesBefore >= 1) {
        // A blank line at top level is a visual statement separator even
        // without a semicolon (e.g. two SetDelayed definitions back-to-back).
        // Split here so both expressions remain independent.
        const prevTok = toks[i - 1];
        if (prevTok && prevTok.type !== T.SEMI) {
          stmts.push({ from: start, to: i - 1, trailingSemi: false, blankAfter: t.blankLinesBefore });
          start = i;
        }
      }
    }
    if (start < toks.length) stmts.push({ from: start, to: toks.length - 1, trailingSemi: false });

    let pieces = [];
    for (let k = 0; k < stmts.length; k++) {
      const s = stmts[k];
      if (s.from > s.to && !s.trailingSemi) continue; // empty
      // Blank lines preceding this statement.
      if (k > 0) {
        // For blank-line-split stmts, blankAfter on the stmt record tells us
        // exactly how many blank lines were in the source. For ;-split stmts
        // we look at blankLinesBefore of the first token.
        let blanks;
        if (s.blankAfter !== undefined) {
          blanks = s.blankAfter;
        } else {
          const firstI = findFirstNonCommentIndex(s.from, s.to);
          blanks = firstI >= 0 ? toks[firstI].blankLinesBefore : 0;
        }
        pieces.push('\n');
        for (let _ = 0; _ < blanks; _++) pieces.push('\n');
      }
      const doc = docForRange(s.from, s.to, false);
      pieces.push(layout(doc));
      if (s.trailingSemi) {
        pieces.push(';');
        if (s.trailComments && s.trailComments.length > 0) {
          pieces.push(' ' + s.trailComments.map(ci => toks[ci].value).join(' '));
        }
      }
    }
    return pieces.join('');
  }

  let result = formatAll();
  // Preserve exact trailing newlines from source.
  const trailing = src.match(/\n+$/)?.[0] ?? '';
  result = result.replace(/\n+$/, '') + trailing;
  return result;
}

// _formatUnsafe: entry point that first splits into statements, then
// formats each independently via _formatSingle and reassembles.
function _formatUnsafe(src, opts) {
  const stmts = splitStatements(src);
  if (stmts.length <= 1) return _formatSingle(src, opts);

  const pieces = [];
  for (let k = 0; k < stmts.length; k++) {
    const s = stmts[k];
    if (k > 0) {
      // Preserve the exact number of blank lines from the source.
      // blanks=0 → consecutive lines (just \n), blanks=1 → one blank line, etc.
      const blanks = s.blankLinesBefore;
      pieces.push('\n'.repeat(blanks + 1));
    }
    pieces.push(_formatSingle(s.text, opts));
  }
  // Preserve exact trailing newlines from the original source.
  const trailing = src.match(/\n+$/)?.[0] ?? '';
  return pieces.join('').replace(/\n+$/, '') + trailing;
}

// ─── Exports ────────────────────────────────────────────────────

return { format, tokenize, T, DEFAULT_OPTIONS };
}));
