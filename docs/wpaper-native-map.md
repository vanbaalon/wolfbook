# WLaTeX render-map adapter

`out/extension/tex/nativeMap.js` implements the synchronous WPaper render-map
surface using WLaTeX worker page views. `renderUi.makeMap` selects it when a
generation carries `nativeView` and `nativeSource`. WLaTeX is an optional, separately installed enhancement. The default `auto`
policy remains unchanged and does not initialize WLaTeX. To opt in, select
`wolfbook.tex.mapEngine: "wlatex"` and set `wolfbook.tex.wlatexDirectory` (or
`WLATEX_HOME`) to an absolute installation or built development-checkout path. The
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

Native editor carets now use asynchronous worker forward queries, including
when source is ahead of the displayed PDF. The current immutable page view must
match that PDF's digest, and answers are discarded after cursor, source, map,
root or display changes. Exact worker membership prevents newly inserted text
from borrowing an enclosing old source range's glyphs. The client paints the
returned engine rectangles directly. Native plain clicks and take-me navigation now consume the verified source
range directly, including translated ranges after edits. They require the click's
display generation, PDF digest, current map and editor bytes to agree. Plain
clicks place a caret; take-me selects the exact source token. Displaced ranges
only provide a collapsed navigation seam and cannot drive page typing or comment
attachment. Focused reading layout is preserved, and an existing mini-editor
receives the verified caret. Native client clicks bypass text-layer word guesses.
General range/mini-editor tracing and widened or shift-picked native selections
while source is ahead remain incomplete. Full interactive acceptance,
simultaneous authoritative and
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

## 2026-09-20 — native inverse navigation

Plain and take-me clicks now execute the native source range directly, including
source-ahead translation. The client exposes native availability only for its
current displayed generation and skips word/glyph text-layer searches for these
clicks. The extension rejects stale generations, mismatched source bytes, invalid
locations and answers overtaken during document/editor opening. The preceding
selection highlight is cleared. Displaced ranges navigate to a seam rather than
selecting newly inserted text. Widened and shift-picked selections, complete
mini-editor tracing and interactive acceptance remain separate work.

Run the real-engine navigation check from this checkout:

```sh
node out/extension/tex/verifyNativeNavigation.cjs /absolute/path/to/WLaTeX [1200]
```

It consumes the WLaTeX SDK, creates a temporary project/cache outside either
checkout, and executes the actual WPaper inverse handler against a native PDF
and worker map after a source insertion. The report binds adapter/viewer hashes
and verifies the translated caret as well as Poppler geometry and forward
membership. This is headless handler verification, not a live VS Code UI test.

Per the newly discovered `WLaTeX/docs/work-split.md`, subsequent WPaper changes
and evidence scripts stay in this repository. The WLaTeX SDK contract and engine
implementation remain owned by its implementation track. The coordination note's
Git warning is stale: `git rev-parse --show-toplevel` resolves to this nested
`Extension Development` repository, and `git ls-files` includes both viewer
sources. Existing native integration commits are tracked here on
`wslide-field-reports`; no un-ignore, new repository, push or deployment is needed.


## 2026-09-20 — optional separate installation

WLaTeX is not bundled into WPaper's VSIX. Normal WPaper installs retain their
existing compiler and map policy. Even when the reader opts into WLaTeX, a
missing or invalid installation falls back to the normal automatic map engine.
A native preview failure tries the configured compiler and avoids retrying that
failed native snapshot until sources change or Compile is explicitly requested.
Cancellation never starts a fallback build. Returning to normal map mode closes
the optional source worker.

`nativeRuntime.js` resolves only the configured installation or `WLATEX_HOME`;
it does not discover a runtime inside the extension. Development checkouts use
the existing SDK layout. A separate release installation can declare
`runtime.json` with schema 1, one of `darwin-arm64`, `darwin-x64`, `win32-x64`,
`linux-x64`, relative `sdk`, `labBinary`, `nativeBinary` entry points, and a `files`
array of `{path, sha256}` entries. The loader validates the target and declared
file checksums before requiring the SDK; traversal and symlink members are
rejected. The current resource contract is `resources: "external-tex"`, matching
the current SDK's installed-TeX requirement. This consumer support is not proof
that separate installers or self-contained resource distributions exist.

Validation covers all four target selections, absent installations, damaged
files, default-mode independence, optional fallback, cancellation and worker
shutdown. These are loader/policy tests; native execution across all four
platforms and the separate release installers remain unverified requirements.

Verification of this optional-install change: 27 runtime/policy tests, 32 live
policy tests, 36 compiler tests, 207 sync tests and nine viewer-shipping tests
pass. The real native navigation check also passes through the new external
runtime resolver using the existing macOS ARM64 development installation.
No installer, native runtime, push or deployment is produced by this change.
