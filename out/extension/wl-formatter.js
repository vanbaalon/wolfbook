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
    // Track bracket stack to disambiguate ]] (Part close vs two ] closes)
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

    // ── Identifiers and numbers ──
    // Non-ASCII characters (Greek letters, etc.) are valid WL identifier chars.
    if (/[a-zA-Z$]/.test(ch) || ch.codePointAt(0) > 127) {
      let j = i;
      while (j < n && (/[a-zA-Z0-9$`]/.test(src[j]) || src[j].codePointAt(0) > 127)) j++;
      tokens.push({ type: T.WORD, value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Numbers (including decimals like 3.14, and precision like 2^^101)
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < n && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      // integer part
      while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      // precision/accuracy marks
      if (j < n && (src[j] === '`' || src[j] === '*')) {
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

    // ── Everything else (single char operators: + - * / ^ ! ~ ? ' etc) ──
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
};

function format(src, opts) {
  opts = { ...DEFAULT_OPTIONS, ...opts };
  const tokens = tokenize(src);
  
  const indent = opts.indentString;
  const maxW = opts.lineWidth;
  
  // ── Build a tree of "groups" from bracket structure ──
  // Then render with indentation decisions.
  // 
  // Strategy: We do a single-pass render. We track:
  //  - current bracket depth
  //  - current line length
  //  - pending indentation
  // When a line gets too long, we insert breaks at the best positions.

  // First, strip all existing whitespace (spaces + newlines) and re-insert our own.
  // Keep comments and strings intact.
  
  let stripped = [];
  let _hadSpace = false;
  let _newlineCount = 0;
  for (let t of tokens) {
    if (t.type === T.SPACE) {
      _hadSpace = true;
      continue;
    }
    if (t.type === T.NEWLINE) {
      _hadSpace = true;
      _newlineCount++;
      continue;
    }
    t.hadSpaceBefore = _hadSpace;
    t.hadNewlineBefore = _newlineCount > 0;
    t.blankLineBefore = _newlineCount >= 2;
    t.blankLineCount = Math.max(0, _newlineCount - 1); // number of blank lines (preserve user's spacing)
    stripped.push(t);
    _hadSpace = false;
    _newlineCount = 0;
  }

  // ── Classify bracket pairs and measure their "flat length" ──
  // This tells us whether a bracketed group fits on one line.
  
  // Find matching brackets
  const matchingClose = new Map(); // open index -> close index
  const matchingOpen = new Map();  // close index -> open index
  const bracketStack = [];
  
  for (let i = 0; i < stripped.length; i++) {
    const t = stripped[i];
    if (t.type === T.OPEN) {
      bracketStack.push(i);
    } else if (t.type === T.CLOSE) {
      if (bracketStack.length > 0) {
        const openIdx = bracketStack.pop();
        matchingClose.set(openIdx, i);
        matchingOpen.set(i, openIdx);
      }
    }
  }

  // Measure flat length of a bracket group (open..close inclusive)
  function flatLen(from, to) {
    let len = 0;
    for (let i = from; i <= to; i++) {
      len += stripped[i].value.length;
      // Add space between tokens where needed
      if (i < to && needsSpaceBetween(stripped[i], stripped[i + 1])) {
        len += 1;
      }
    }
    return len;
  }

  // Does this bracket group fit on one line (given current column)?
  function fitsOnLine(openIdx, col) {
    const closeIdx = matchingClose.get(openIdx);
    if (closeIdx === undefined) return true;
    return col + flatLen(openIdx, closeIdx) <= maxW;
  }

  // ── Determine where spaces are needed between tokens ──
  function needsSpaceBetween(a, b) {
    if (!a || !b) return false;
    // No space before comma or semi or span
    if (b.type === T.COMMA || b.type === T.SEMI || b.type === T.SPAN) return false;
    // Space after comma
    if (a.type === T.COMMA) return true;
    // Space after semi
    if (a.type === T.SEMI) return true;
    // No space around ;;  (Span, e.g. a[[1;;3]])
    if (a.type === T.SPAN || b.type === T.SPAN) return false;
    // Space around logical operators && ||
    if (a.type === T.LOGICAL || b.type === T.LOGICAL) return true;
    // Space around comparison operators
    if (a.type === T.COMPARE || b.type === T.COMPARE) return true;
    // Space around arrows, assigns, rule-apply, postfix
    if (a.type === T.ARROW || b.type === T.ARROW) return true;
    if (a.type === T.ASSIGN || b.type === T.ASSIGN) return true;
    if (a.type === T.RULE_APPLY || b.type === T.RULE_APPLY) return true;
    if (a.type === T.STRJOIN || b.type === T.STRJOIN) return true;
    // No space before [ after word (function call)
    if (b.type === T.OPEN && b.value === '[' && 
        (a.type === T.WORD || a.type === T.NAMEDCHAR || a.type === T.CLOSE)) return false;
    if (b.type === T.OPEN && b.value === '[[' &&
        (a.type === T.WORD || a.type === T.NAMEDCHAR || a.type === T.CLOSE)) return false;
    // No space after open bracket
    if (a.type === T.OPEN) return false;
    // No space before close bracket
    if (b.type === T.CLOSE) return false;
    // No space between # and number, or between word and _
    if (a.type === T.SLOT) return false;
    if (b.type === T.PATTERN && a.type === T.WORD) return false;
    if (a.type === T.PATTERN) return false;
    // No space in identifier continuation: \[Chi]up, x\[Alpha], xϕ
    // But preserve space when original had one (multiplication): I \[Theta], I ϕ0
    if (a.type === T.NAMEDCHAR && b.type === T.WORD) return !!b.hadSpaceBefore;
    if (a.type === T.WORD && b.type === T.NAMEDCHAR) return !!b.hadSpaceBefore;
    if (a.type === T.NAMEDCHAR && b.type === T.NAMEDCHAR) return !!b.hadSpaceBefore;
    // Two adjacent WORD tokens that are both pure non-ASCII (e.g. I ϕ0) or
    // one ASCII word followed by a non-ASCII word: preserve original spacing.
    if (a.type === T.WORD && b.type === T.WORD) {
      // If b starts with a non-ASCII char the tokens could be identifier
      // continuation (e.g. from a split) OR implicit multiplication (I ϕ0).
      // Use the original space to disambiguate — if there was a space, keep it.
      if (b.value.codePointAt(0) > 127 || a.value.codePointAt(0) > 127)
        return !!b.hadSpaceBefore;
      return true;  // two ASCII words always need a space
    }
    // No space before &
    if (b.type === T.AMP) return false;
    // No space between word and ' (Derivative)
    if (b.type === T.OTHER && b.value === "'") return false;
    // Space around + -
    if ((a.value === '+' || a.value === '-') && a.type === T.OTHER) {
      // Could be unary: after open bracket or after comma/semi
      // Keep space in binary contexts
      return true;
    }
    if ((b.value === '+' || b.value === '-') && b.type === T.OTHER) return true;
    // Space around bare > < (comparison context)
    if ((a.value === '>' || a.value === '<') && a.type === T.OTHER) return true;
    if ((b.value === '>' || b.value === '<') && b.type === T.OTHER) return true;
    // Space around * and / in binary context (between expressions)
    if (a.type === T.OTHER && (a.value === '*' || a.value === '/')) return true;
    if (b.type === T.OTHER && (b.value === '*' || b.value === '/')) return true;
    // Space around . (Dot product) — but not decimal point
    // This is tricky; for now skip
    // No space between ^ and exponent
    if (a.value === '^' || b.value === '^') return false;
    // Space between word/number tokens
    if ((a.type === T.WORD || a.type === T.NAMEDCHAR || a.type === T.STRING || a.type === T.CLOSE || a.type === T.AMP) &&
        (b.type === T.WORD || b.type === T.NAMEDCHAR || b.type === T.STRING || b.type === T.OPEN && b.value === '(')) return true;
    // Space around //
    if (a.type === T.POSTFIX || b.type === T.POSTFIX) return true;
    // Space around @
    if (a.type === T.AT || b.type === T.AT) return true;
    // Space after comment
    if (a.type === T.COMMENT) return true;
    if (b.type === T.COMMENT) return true;
    
    return false;
  }

  // ── Render pass ──
  // Walk through stripped tokens, building output lines.
  
  let out = '';
  let depth = 0;           // bracket nesting depth  
  let col = 0;             // current column
  let lineStart = true;    // are we at the start of a line?
  let suppressNextSpace = false; // set by comma/semi/bracket handlers that already positioned the next token
  
  // Stack of bracket contexts
  // Each entry: { type: '{' | '[' | '(' | '[[', startCol, multiline, argCount }
  const ctxStack = [];
  
  function currentIndent() {
    return indent.repeat(depth);
  }
  
  function emit(s) {
    out += s;
    // Update col: count from last newline
    const lastNl = s.lastIndexOf('\n');
    if (lastNl >= 0) {
      col = s.length - lastNl - 1;
      lineStart = (col === 0);
    } else {
      col += s.length;
      lineStart = false;
    }
  }
  
  function emitNewline() {
    out += '\n';
    col = 0;
    lineStart = true;
  }
  
  function emitIndent() {
    const ind = currentIndent();
    out += ind;
    col = ind.length;
    lineStart = false;
  }

  // Determine if a bracket group should be multiline
  function shouldBreakGroup(openIdx) {
    const closeIdx = matchingClose.get(openIdx);
    if (closeIdx === undefined) return false;
    
    // Count commas and semis at this level
    let commas = 0, semis = 0, innerDepth = 0;
    for (let i = openIdx + 1; i < closeIdx; i++) {
      if (stripped[i].type === T.OPEN) innerDepth++;
      else if (stripped[i].type === T.CLOSE) innerDepth--;
      else if (innerDepth === 0) {
        if (stripped[i].type === T.COMMA) commas++;
        if (stripped[i].type === T.SEMI) semis++;
      }
    }
    
    // Check if it fits on one line
    const fl = flatLen(openIdx, closeIdx);
    if (col + fl <= maxW) return false;
    
    // No natural break points (no commas, no semis) — keep on one line
    // e.g. B[__], f[singleArg], even if it overflows
    if (commas === 0 && semis === 0) return false;

    // If there are semis, definitely break
    if (semis > 0) return true;
    
    // If there are multiple commas and it doesn't fit, break
    if (commas > 0) return true;
    
    return true; // doesn't fit, break somehow
  }

  // Is the next meaningful token at this depth an arrow? (for rule lists)
  function isRuleList(openIdx) {
    const closeIdx = matchingClose.get(openIdx);
    if (closeIdx === undefined) return false;
    let innerDepth = 0;
    for (let i = openIdx + 1; i < closeIdx; i++) {
      if (stripped[i].type === T.OPEN) innerDepth++;
      else if (stripped[i].type === T.CLOSE) innerDepth--;
      else if (innerDepth === 0 && stripped[i].type === T.ARROW) return true;
    }
    return false;
  }

  // ── Main rendering loop ──
  for (let i = 0; i < stripped.length; i++) {
    const tok = stripped[i];
    const prev = i > 0 ? stripped[i - 1] : null;
    const next = i + 1 < stripped.length ? stripped[i + 1] : null;

    // ── Opening bracket ──
    if (tok.type === T.OPEN) {
      // Preserve top-level newlines between expressions
      if (ctxStack.length === 0 && tok.hadNewlineBefore && !lineStart) {
        emitNewline();
        for (let _bl = 0; _bl < (tok.blankLineCount || 0); _bl++) emit('\n');
      }

      const multiline = shouldBreakGroup(i);
      
      // Add space before ( if needed
      if (!suppressNextSpace && prev && needsSpaceBetween(prev, tok) && !lineStart) {
        emit(' ');
      }
      suppressNextSpace = false;
      
      emit(tok.value);
      
      if (multiline) {
        depth++;
        ctxStack.push({ type: tok.value, multiline: true, startCol: col });
        emitNewline();
        emitIndent();
        suppressNextSpace = true;
      } else {
        ctxStack.push({ type: tok.value, multiline: false, startCol: col });
      }
      continue;
    }

    // ── Closing bracket ──
    if (tok.type === T.CLOSE) {
      suppressNextSpace = false;
      const ctx = ctxStack.pop() || { multiline: false };
      
      if (ctx.multiline) {
        depth--;
        emitNewline();
        emitIndent();
      }
      
      emit(tok.value);
      continue;
    }

    // ── Comma ──
    if (tok.type === T.COMMA) {
      emit(',');
      const ctx = ctxStack.length > 0 ? ctxStack[ctxStack.length - 1] : null;
      
      if (ctx && ctx.multiline) {
        emitNewline();
        emitIndent();
      } else if (next) {
        // Check if adding next chunk would overflow
        let chunkLen = 0;
        for (let j = i + 1; j < stripped.length; j++) {
          if (stripped[j].type === T.COMMA || stripped[j].type === T.CLOSE || 
              stripped[j].type === T.SEMI) break;
          chunkLen += stripped[j].value.length + 1;
        }
        if (col + chunkLen > maxW && ctx) {
          // Upgrade to multiline
          ctx.multiline = true;
          depth++;
          emitNewline();
          emitIndent();
        } else {
          emit(' ');
        }
      }
      suppressNextSpace = true;
      continue;
    }

    // ── Semicolon ──
    if (tok.type === T.SEMI) {
      emit(';');
      const ctx = ctxStack.length > 0 ? ctxStack[ctxStack.length - 1] : null;
      const atTopLevel = ctxStack.length === 0;
      
      if (opts.newlineAfterSemi && (atTopLevel || (ctx && ctx.multiline))) {
        // Skip newline+indent when next non-comment token is a closing bracket —
        // the CLOSE handler will emit its own newline before `]`, avoiding a blank line.
        let _nextSig = null;
        for (let _j = i + 1; _j < stripped.length; _j++) {
          if (stripped[_j].type !== T.COMMENT) { _nextSig = stripped[_j]; break; }
        }
        if (!_nextSig || _nextSig.type !== T.CLOSE) {
          emitNewline();
          if (!atTopLevel) {
            emitIndent();
          }
          // Preserve user-inserted blank line at top level
          if (atTopLevel && _nextSig && _nextSig.blankLineBefore) {
            emit('\n');
          }
        }
        suppressNextSpace = true;
        // If top-level and next token is an assignment (:= or symbol =), add blank line
        // Skip if user already had a blank line (already emitted above)
        if (atTopLevel && opts.blankLineBetweenDefs && next && !(_nextSig && _nextSig.blankLineBefore)) {
          // Look ahead to see if the next statement is a definition
          let j = i + 1;
          while (j < stripped.length && stripped[j].type === T.COMMENT) j++;
          if (j < stripped.length && j + 1 < stripped.length) {
            // Check for x := or x[_] := pattern
            let k = j;
            while (k < stripped.length && (stripped[k].type === T.WORD || 
                   stripped[k].type === T.NAMEDCHAR || stripped[k].type === T.OPEN || 
                   stripped[k].type === T.CLOSE || stripped[k].type === T.PATTERN ||
                   stripped[k].type === T.COMMA)) k++;
            if (k < stripped.length && stripped[k].type === T.ASSIGN && stripped[k].value === ':=') {
              emit('\n');
            }
          }
        }
      } else {
        if (next) emit(' ');
      }
      suppressNextSpace = true;
      continue;
    }

    // ── Comment ──  
    if (tok.type === T.COMMENT) {
      if (!suppressNextSpace && prev && !lineStart) emit(' ');
      suppressNextSpace = false;
      // At top level, ensure a blank line before the comment if there was
      // at least one newline in the source (i.e. the comment sits on its
      // own line, not trailing an expression on the same line).
      if (ctxStack.length === 0 && tok.hadNewlineBefore && prev && !lineStart) {
        emitNewline();
        emit('\n');
      } else if (ctxStack.length === 0 && tok.hadNewlineBefore && lineStart && prev) {
        // Already on a new line — just ensure a blank line separator
        if (!tok.blankLineBefore) {
          emit('\n');
        }
      }
      // Preserve internal newlines in multiline comments
      emit(tok.value);
      if (next && next.type !== T.CLOSE && next.type !== T.COMMA && next.type !== T.SEMI) {
        // If comment is on its own line at top level, add newline
        if (ctxStack.length === 0 || (ctxStack.length > 0 && ctxStack[ctxStack.length - 1].multiline)) {
          emitNewline();
          // Add a blank line after the comment only when it was originally on its own line
          // (not when it was inline-trailing a semicolon and got moved to the next line)
          if (ctxStack.length === 0 && tok.hadNewlineBefore) emit('\n');
          if (ctxStack.length > 0) emitIndent();
          suppressNextSpace = true;
        }
      }
      continue;
    }

    // ── All other tokens ──
    // Preserve top-level newlines between expressions
    if (ctxStack.length === 0 && tok.hadNewlineBefore && !lineStart) {
      emitNewline();
      for (let _bl = 0; _bl < (tok.blankLineCount || 0); _bl++) emit('\n');
    }
    // Add space if needed
    if (!suppressNextSpace && prev && needsSpaceBetween(prev, tok) && !lineStart) {
      emit(' ');
    }
    suppressNextSpace = false;

    // Check if we need to break the line before this token
    if (!lineStart && col + tok.value.length > maxW) {
      // Try to break. Find a good break point.
      // Simple: break before operators
      if (tok.type === T.RULE_APPLY || tok.type === T.POSTFIX || 
          tok.type === T.STRJOIN || tok.type === T.AT ||
          (tok.type === T.OTHER && (tok.value === '+' || tok.value === '-'))) {
        emitNewline();
        emitIndent();
        emit(indent); // extra indent for continuation
      }
    }

    // Optionally replace \[Name] with UTF
    if (tok.type === T.NAMEDCHAR && opts.replaceNamedChars) {
      const name = tok.value.slice(2, -1); // strip \[ and ]
      const code = NAMED_CHARS[name];
      if (code) {
        emit(String.fromCodePoint(code));
      } else {
        emit(tok.value); // keep original if no mapping
      }
    } else {
      emit(tok.value);
    }
  }

  // Preserve the exact number of trailing newlines from the source
  const trailingNLs = src.match(/\n+$/)?.[0] ?? '';
  out = out.replace(/\n+$/, '');
  out += trailingNLs;

  return out;
}

// ─── Exports ────────────────────────────────────────────────────

return { format, tokenize, T, DEFAULT_OPTIONS };
}));
