# Wolfram-Aware Code Folding for Wolfbook

## Goal

Implement a `FoldingRangeProvider` for the `wolfram` language that enables collapsing any bracket pair whose content spans multiple lines. This gives natural folding for long argument lists, nested function calls, list/association literals, Module/Block bodies, and multiline comments — all from a single rule.

## Core Rule

**If a matched bracket pair spans more than one line, it is foldable.** The folding range starts on the line of the opening bracket and ends on the line of the closing bracket.

## Mechanism: `FoldingRangeProvider`

Register via `vscode.languages.registerFoldingRangeProvider('wolfram', provider)`.

The provider scans the document text, finds all matched bracket pairs, and returns a `FoldingRange` for each pair that spans multiple lines.

```typescript
new vscode.FoldingRange(
  openBracketLine,   // line of the opening bracket
  closeBracketLine,  // line of the closing bracket
  kind               // FoldingRangeKind.Region for brackets, Comment for (* *)
)
```

VS Code handles the rest: rendering the fold gutter icons, showing collapsed placeholders, nesting folds, etc.

## Bracket Pairs

| Open | Close | Kind | Notes |
|------|-------|------|-------|
| `(` | `)` | Region | Grouping |
| `[` | `]` | Region | Function application |
| `{` | `}` | Region | List |
| `[[` | `]]` | Region | Part — treat as single tokens |
| `<\|` | `\|>` | Region | Association |
| `(*` | `*)` | Comment | Comments — these nest in Wolfram |

Use `FoldingRangeKind.Comment` for `(* *)` so that VS Code's "Fold All Block Comments" command works. All others use `FoldingRangeKind.Region`.

## Parsing Rules

The bracket scanner must:

1. **Skip string literals** — content between matched `"` characters. Handle `\"` escape sequences.
2. **Handle nested comments** — `(* ... (* inner *) ... *)` is valid Wolfram. Maintain a nesting depth counter for comment brackets. Each `(*` / `*)` pair at every nesting level that spans multiple lines gets its own `FoldingRange`.
3. **Handle `[[` and `]]` as single tokens** — when encountering `[[`, consume both characters as one opening bracket. Same for `]]`. A lone `[` followed by a non-`[` character is a regular function bracket. Care is needed when `]` is followed by `]` — check whether this closes a `[[` pair or two separate `[` pairs by tracking what was opened.
4. **Use a stack** — push each opening bracket (with its type and position) onto a stack. On a closing bracket, pop the matching opener and emit a `FoldingRange` if they're on different lines.

## Shared Code with SelectionRangeProvider

The bracket-scanning logic (string skipping, nested comment handling, `[[`/`]]` tokenisation, stack-based matching) is the same as needed for the Expanding Bracket Selection feature. Extract this into a shared utility module, e.g. `src/bracketScanner.ts`, that both providers can use.

Suggested shared API:

```typescript
interface BracketPair {
  open: { offset: number; line: number; type: BracketType };
  close: { offset: number; line: number; type: BracketType };
}

type BracketType = '(' | '[' | '{' | '[[' | '<|' | '(*';

function findAllBracketPairs(text: string): BracketPair[];
```

The `SelectionRangeProvider` uses this to find enclosing brackets at a position. The `FoldingRangeProvider` filters for pairs where `open.line !== close.line`.

## Collapsed Preview

VS Code automatically shows `...` at the fold point. The user will see e.g.:

```
Plot[...
]
```

or for a list:

```
data = {...
}
```

This is the standard VS Code fold display — no customisation needed.

## Edge Cases

- **Multiple bracket pairs on the same line**: e.g. `f[g[x,\n y], h[a,\n b]]` — each pair that spans lines gets an independent fold. VS Code handles nested folds natively.
- **Opening and closing bracket on the same line**: no fold produced (the core rule filters these out).
- **Unmatched brackets**: if the stack has unmatched openers at end-of-document, silently ignore them. Do not produce fold ranges for unmatched brackets.
- **Mixed `[` and `[[`**: e.g. `f[a[[i,\n j]],\n b]` — the `[[` is an inner fold, the `[` is an outer fold. The stack-based approach handles this naturally as long as `[[`/`]]` are tokenised correctly.
- **Empty multiline brackets**: e.g. `f[\n]` — still foldable (the user might have temporarily emptied a function body).
- **Very large files**: the scanner runs on every document change that triggers folding (VS Code debounces this). Keep it O(n) in document size — a single linear scan with a stack is sufficient.

## Files to Create / Modify

| File | Action |
|------|--------|
| `src/bracketScanner.ts` | **New** — shared bracket-scanning utility |
| `src/foldingRangeProvider.ts` | **New** — the `FoldingRangeProvider` implementation |
| `src/selectionRangeProvider.ts` | **Refactor** — use shared `bracketScanner` instead of inline scanning |
| `src/extension.ts` (or wherever `activate()` lives) | **Modify** — register the folding provider |

## Testing

### Test 1: Basic multiline function call

```wolfram
Plot[
  Sin[x] + Cos[x],
  {x, 0, 2 Pi},
  PlotStyle -> Red
]
```

Expected: one fold on `Plot[` (lines 1–5), one fold on `{x, 0, 2 Pi}` only if it were multiline (here it's single-line, so no fold for it).

### Test 2: Nested multiline brackets

```wolfram
Module[{
    x = 1,
    y = 2
  },
  Table[
    x + y + i,
    {i, 1, 10}
  ]
]
```

Expected: outer fold on `Module[` (lines 1–9), inner fold on `{` for vars (lines 1–3), inner fold on `Table[` (lines 5–8).

### Test 3: Multiline comment

```wolfram
(*
  This is a long comment
  explaining the algorithm.
*)
```

Expected: one fold with `FoldingRangeKind.Comment`.

### Test 4: Nested comments

```wolfram
(*
  outer comment
  (* inner comment
     continued *)
  still outer
*)
```

Expected: two folds — outer (lines 1–6) and inner (lines 3–4), both with `Comment` kind.

### Test 5: String with brackets (no false folds)

```wolfram
msg = "this has [\n brackets \n] inside";
```

Expected: no fold produced from the brackets inside the string. (Whether the string itself is foldable is not required — strings are not bracket pairs.)

### Test 6: Part syntax

```wolfram
result = matrix[[
  Range[1, 10],
  Range[5, 15]
]]
```

Expected: one fold on `[[` (lines 1–4).