# WLaTeX render-map adapter

`out/extension/tex/nativeMap.js` implements the synchronous WPaper render-map
surface using WLaTeX worker page views. `renderUi.makeMap` selects it when a
generation carries `nativeView` and `nativeSource`. Select `wolfbook.tex.mapEngine: "wlatex"` and set the machine setting
`wolfbook.tex.wlatexDirectory` to an absolute, built WLaTeX checkout path. The
coordinator now produces these generations for initial and live previews.
Explicit Compile, save and idle authoritative builds use the conventional engine
configured by `wolfbook.tex.engine`; these replace the preview with their PDF
and conventional map. Native builds do not claim authoritative settlement.

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

## Local native preview setup

In the WLaTeX checkout, build the host with `cargo build -p wlatex-lab --locked`,
install the SDK dependencies with `npm ci --prefix integrations/wpaper`, and
build the native release engine using the platform prerequisites in its
`native-lab/README.md`. On macOS the native build needs the Homebrew ICU
pkg-config path. The WPaper lane currently loads the SDK and binaries from that
checkout; these are not bundled into the extension. No extension deployment is
performed by the verification scripts.

The lane freezes unsaved buffers without writing project source files, owns a
persistent source worker, refreshes discovered local packages, cancels superseded
builds and preserves immutable earlier PDF artifacts. Its build cache is under
`.wlatex/native` beside the main TeX file. Worker edits invalidate page views and
refresh translated source locations. Externally changed files invalidate the map
until the next build. Native generations are not persisted as JSON because their
worker handles cannot survive an extension restart.

The current viewer still pauses general tracing while source is ahead of the
PDF. A refreshed worker map does not imply that newly inserted text has printed
geometry. Full interactive source-ahead tracing, simultaneous authoritative and
native views, packaged engine delivery and the reference-paper acceptance remain
open. Native cold compilation is not native incremental checkpoint execution.

Additional checks:

```sh
node --test out/extension/kernel/tests/tex-native-policy.test.js
# Run from the WLaTeX checkout:
node scripts/verify-wpaper-build.cjs /absolute/path/to/Wolfbook
```

The real-engine build check covers unsaved UTF-16 edits, translated page views,
changed and removed local packages, immutable old PDFs, and cancellation followed
by a successful build. The headless coordinator tests execute native versus
conventional selection, expected cancellation and external invalidation.
