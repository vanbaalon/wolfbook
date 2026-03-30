# Expanding Bracket Selection for Wolfbook

## Goal

Implement Mathematica-style progressive selection expansion in code cells. When the user repeatedly triggers "Expand Selection" (or multi-clicks), the selection should grow outward through bracket nesting levels, ending with the full cell content.

## Mechanism: `SelectionRangeProvider`

Register a `vscode.languages.registerSelectionRangeProvider` for the `wolfram` language ID. This hooks into VS Code's built-in **Smart Select** (`editor.action.smartSelect.expand` / `editor.action.smartSelect.shrink`), bound by default to `Shift+Alt+Right` / `Shift+Alt+Left`.

The provider must return a **linked list** of `SelectionRange` objects (each with a `.parent`), from the innermost to the outermost range.

## Selection Chain (innermost → outermost)

For a given cursor position, build the following chain of ranges:

1. **Current word/token** — the identifier, number, or string at the cursor (analogous to double-click selection).
2. **Innermost bracket contents** — the content inside the nearest enclosing `()`, `[]`, `{}`, or `[[]]` pair, excluding the brackets themselves.
3. **Innermost bracket including brackets** — same span but including the bracket characters.
4. **Repeat levels 2–3** for each successive enclosing bracket pair, moving outward.
5. **Full expression** — from the head symbol through the outermost closing bracket, e.g. `f[x, g[y]]` as a whole.
6. **Full cell content** — the entire text content of the cell (i.e. the full document range, since each cell is a virtual document in Wolfbook's notebook model).

Each level becomes the `.parent` of the previous one.

## Bracket Types to Handle

- `(` `)` — grouping
- `[` `]` — function application
- `{` `}` — List
- `[[` `]]` — Part (double brackets). Treat `[[` and `]]` as single bracket tokens. When cursor is inside `expr[[i, j]]`, the inner expansion should cover `i, j`, then `[[i, j]]`, before moving to any outer brackets.
- `\[LeftAssociation]` `\[RightAssociation]` i.e. `<|` `|>` — Association (treat as bracket pair)

## Parsing Rules

The bracket scanner must skip over:

- **String literals**: content between matched `"` characters. Handle `\"` escape sequences inside strings.
- **Comments**: `(* ... *)`, which can nest (Wolfram comments nest, unlike C).
- **Escaped bracket characters in strings**: e.g. `"text[not a bracket]"` should not be treated as brackets.

The scanner operates on raw text only (no kernel calls) for instant responsiveness.

## Edge Cases

- **Cursor on a bracket character**: the first expansion should select the contents of that bracket pair; the next expansion should include the brackets.
- **Cursor between expressions** (e.g. between arguments separated by `,`): the innermost enclosing bracket pair is the first bracket-level expansion.
- **Nested `[[` inside `[`**: e.g. `f[a[[2]], b]` — the Part brackets `[[2]]` are an independent nesting level inside the function brackets `[a[[2]], b]`.
- **Empty brackets**: `f[]` — selecting inside should yield an empty range, then expand to include the brackets.
- **Multiple cells**: the provider only sees one cell at a time (each cell is a separate virtual document), so "full cell" is simply the full document range.

## Keybinding Override (Optional Enhancement)

To get Mathematica-like multi-click behavior, add an optional keybinding that maps double-click → word select (VS Code default), then tracks repeated clicks within a 500ms window and calls `editor.action.smartSelect.expand` for each subsequent click. This is a nice-to-have; the `SelectionRangeProvider` alone already delivers the core functionality via keyboard shortcuts.

## Files to Modify

The implementation should go in a new source file (e.g. `src/selectionRangeProvider.ts`) and be registered in the extension's `activate()` function. No changes to the notebook kernel or cell execution logic are needed — this is purely editor-side.

## Testing

Verify the selection chain on these expressions:

```wolfram
f[g[x + 1, h[{a, b, c}]], y]
```

With cursor on `b`:
1. `b`
2. `a, b, c`
3. `{a, b, c}`
4. `x + 1, h[{a, b, c}]`
5. `g[x + 1, h[{a, b, c}]]`
6. `g[x + 1, h[{a, b, c}]], y`
7. `f[g[x + 1, h[{a, b, c}]], y]`
8. Full cell content (if there's surrounding content)

```wolfram
mat[[i, j + 1]] + vec[[k]]
```

With cursor on `j`:
1. `j`
2. `j + 1` (not just `j` — `+` is part of the expression but the bracket content is `i, j + 1`)
3. `i, j + 1`
4. `[[i, j + 1]]`
5. `mat[[i, j + 1]]`
6. Full cell content

```wolfram
str = "hello [world]";
```

With cursor on `world` inside the string:
1. `world` (word)
2. `"hello [world]"` (string literal — brackets inside are ignored)
3. Full cell content