# WLaTeX render-map adapter

`out/extension/tex/nativeMap.js` implements the synchronous WPaper render-map
surface using WLaTeX worker page views. `renderUi.makeMap` selects it when a
generation carries `nativeView` and `nativeSource`. The compile policy does not
produce those fields yet; this is the renderer integration boundary, not a
completed native-engine rollout.

The expected generation has:

- `pdfHash`: the paired native artifact's PDF digest.
- `projectDir`: the real project directory used to resolve worker filenames.
- `nativeView`: an immutable result of `NativeSourceSession.readPages`.
- `nativeSource`: the owning `NativeSourceSession`.

Every synchronous lookup checks `isCurrentView`. Source edits and legacy
`noteEdit` notifications invalidate the adapter, including same-line edits.
After applying edits through the worker, fetch fresh page views and construct a
replacement map. Do not translate native positions with the old line-delta list.

Page and line boxes come from engine geometry and horizontal box paths. Inverse
queries require containment and return the worker's preferred source and UTF-16
column; they do not pick a nearby source line for whitespace or furniture.
Column maps use exact translated contributors, including multiple contributors
to one glyph, without running `glyphAlign.align` or guessing collector windows.
Displaced ranges are excluded from the column map; use the worker's asynchronous
forward query when exact cursor admission after an edit is required. The adapter
retains native hits for callers that need all origins and box paths.

The coordinate boundary adds xdvipdfmx's 72 bp DVI origin and applies stream
magnification. Raw geometry already includes TeX offsets, so header offsets are
not added again. Negative extents are normalized for hit testing. These are
engine metric boxes, not a claim that general independent ink bounds are proven.
The remaining font metadata, complete semantic-role coverage, viewer policy and
native engine packaging requirements are not closed by this adapter.

Checks:

```sh
node --test out/extension/kernel/tests/tex-nativemap.test.js
node out/extension/kernel/tests/tex-glyphmap.test.js
node out/extension/kernel/tests/tex-rendermap.test.js
```

The WLaTeX repository also provides `scripts/verify-wpaper-map.cjs CHECKOUT
[MAGNIFICATION]`. It compiles a real native PDF, admits its map through the
worker, constructs this adapter, compares word geometry with Poppler, and checks
source columns and edit invalidation/retranslation. Local checks cover 1000 and
1200 magnification. This is a focused renderer contract check, not full interactive
VS Code acceptance or broad cross-engine fidelity evidence.
