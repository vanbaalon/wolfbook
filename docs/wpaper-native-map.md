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
Native range and mini-editor tracing, Shift-pick and widen/shrink selections
work against admitted current source while the PDF is older. Full interactive acceptance,
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

## 2026-09-20 — mini-editor caret admission

An open mini-editor now has explicit session/request admission through the native
cursor path. New caret messages supersede older native answers immediately,
before waiting for their text edits. A document open cannot restore an older
caret after a later message; closing/replacing the card or moving its block
invalidates pending answers. The handler awaits direct tracing, preserves the
PDF viewport and still mirrors a visible editor without exposing a hidden one.

Validation: all 25 native-policy tests and 207 existing sync tests pass. The real
PDF verifier now executes `_onEditCaret` after inserting source inside a word and
checks that the translated surviving glyph is highlighted with exact engine
geometry and no scrolling. Evidence is `/tmp/wpaper-native-mini-verification.json`
with the viewer/adapter hashes; rerun `verifyNativeNavigation.cjs` to regenerate.

This closes collapsed-caret tracing for an existing native mini-editor. Native
ranges, widened/shift-picked selections and opening/editing cards while source
is ahead still need work. WLaTeX remains optional and separately installed; no
native runtime is copied into the VSIX, and no push or deployment occurred.

## 2026-09-20 — opening cards from an older native PDF

An exact native point can now open the mini-editor against current source even
while the displayed PDF is older. Admission binds the click generation, PDF
hash, current map and current editor bytes. A displaced or unmapped point does
not open a card. Opening captures the source block from the current document,
so newly inserted source appears in the editor without pretending it already
has printed geometry. Page typing can reach this path only when the client has
an admitted native map.

Pending opens are superseded by newer opens, card closure/replacement, newer
navigation or caret gestures, and map changes. `editHere` performs its following
inverse selection only if its own open succeeded and that session still owns
the card. This prevents rejected or older requests from targeting an unrelated
card. The ordinary compiler path keeps its source-ahead pause.

Validation: 29 native-policy tests, 207 existing sync tests, 35 panel tests and
nine viewer-shipping tests pass. The real native PDF verifier executes card
opening after a source insertion, verifies the actual current source block, and
then verifies inverse and mini-editor caret geometry. Evidence:
`/tmp/wpaper-native-card-open-verification.json`, bound to viewer/adapter hashes.
This remains headless handler verification; native range selection and full
interactive acceptance remain open. WLaTeX stays optional and separate.

## 2026-09-20 — native editor and mini-editor ranges

`NativeMap.forwardRange` now selects output contributors from current source
ranges. Contiguous exact translations use the worker's mapped origins directly;
displaced and zero-length origins require actual worker point membership.
Repeated positions share query results, admitted items are deduplicated, and a
new selection or source revision cancels the remaining queries. UTF-16 scalar
boundaries, CRLF positions and half-open range ends are checked. Newly inserted
interiors cannot inherit an old enclosing span's glyphs.

Both editor and mini-editor selections now use this path, including when source
is ahead. The client paints the returned glyph rectangles without PDF text-row
searches or filling gaps between them. Native selection actions retain current
source bounds and map/version admission; source changes discard those bounds.
The ordinary compiler's rendering path is unchanged.

Validation: 42 native map/policy tests, 207 sync tests, 35 panel tests and nine
viewer-shipping tests pass. The real-PDF verifier checks a range consisting only
of inserted text (no geometry), the full edited word (five surviving glyphs),
and the actual mini-editor range handler. Evidence:
`/tmp/wpaper-native-range-verification.json`, bound to adapter/viewer hashes.

Large displaced ranges can still require many point queries; their latency has
not been benchmarked against the product budget. A producer-side batched range
query remains a potential contract improvement. Native shift-pick/widen gestures,
full interactive acceptance and separate four-platform releases remain open.
WLaTeX stays optional, with the ordinary WPaper compiler available without it.

## 2026-09-20 — native Shift-pick selection

Shift-pick now uses native source spans for both endpoints, without client
word-search hints. The first click publishes only a pending endpoint. Subsequent
points select the inclusive endpoint tokens in either source direction and use
`forwardRange` to paint the admitted glyph rectangles. A live drag retains its
first endpoint and can shrink; release clears it. The mini-editor receives the
same selected source interval as the source editor.

Endpoints are tied to a source document version and immutable native map. A
changed revision/map starts a new selection instead of shifting the old endpoint.
Displaced endpoints are rejected, and an unmapped plain click abandons a pending
pick. Late range answers retain the existing display/source/request admission.

Validation: 36 native-policy tests, 207 sync tests, 35 panel tests and nine
viewer-shipping tests pass. The real-PDF verifier picks two surviving glyphs with
newly inserted source between them: the source interval includes the inserted
text, while the selection paints only the two actual printed glyphs. Evidence:
`/tmp/wpaper-native-shift-pick-verification.json`, bound to adapter/viewer hashes.
High-frequency interaction acceptance and displaced-range latency remain to be
measured; native widen gestures and separate platform releases are still open.
WLaTeX remains optional and separately installed.


## 2026-09-20 — native widen/shrink selection

Native widen gestures now start from the exact worker source span and walk the
existing sentence, paragraph, math/container and section hierarchy. Shrink walks
back to the original source token. Every step must contain the preceding range,
including multiline source tokens. The client skips PDF text-layer guesses for
these gestures, and the native handler remains available while source is ahead.
The selected source interval is mirrored to the source editor and mini-editor;
`forwardRange` paints only admitted output rectangles.

Ladders retain the native map, source document version, file and click location.
A changed owner starts a fresh ladder. Displaced points and stale display
requests cannot widen, and a newer source gesture invalidates pending rectangle
answers.

Validation: 41 native-policy tests, 207 sync tests, 35 panel tests and nine
viewer-shipping tests pass. The real native PDF verifier widens across inserted
source, checks the five surviving glyph rectangles, then shrinks to the exact
translated token and its single printed glyph. Evidence:
`/tmp/wpaper-native-widen-verification.json`, bound to adapter/viewer hashes.
This is headless handler verification; live interaction acceptance, displaced
range latency, complete native execution and separate four-platform releases
remain open. WLaTeX remains optional and is not bundled into WPaper.

## 2026-09-20 — preserve native drag starts during asynchronous opens

Native Shift-pick reserves its first source endpoint before opening the source
document or editor. A newer pointer event can supersede an older request without
losing the gesture's starting token. The reservation carries its immutable map,
file and source text; its bounds are checked against that text, and document
bytes and version are admitted before selecting. Plain clicks cancel reserved
endpoints. Older document/editor completions cannot restore a finished pick.

Validation: 44 native-policy tests, 207 sync tests, 35 panel tests and nine
viewer-shipping tests pass. New tests exercise rapid events with document opens
resolved in both orders, cancellation during opening and delayed editor opens.
The existing real native PDF navigation/range/widen check passes with the changed
viewer (`/tmp/wpaper-native-rapid-verification.json`). Controlled asynchronous
handler tests close this specific race; they do not establish live UI latency
or full interactive acceptance. Separate platform releases remain open.

## 2026-09-20 — retire failed native workers before retrying

Native build or mapping failures now retire their owning lane. A preview build
still falls back to the configured compiler, and its refused snapshot prevents
an immediate restart loop. A subsequent changed snapshot creates a new SDK
session, reopens current sources and republishes the map. Session shutdown errors
are logged without preventing fallback. Expected build cancellation keeps its
existing behavior and does not retire a healthy lane.

Edit/refresh continuations capture the lane that owns their request. A late
completion cannot refresh a replacement session or install an old page view;
a late failure closes only the old lane. This also removes a null-lane access
when switching away from native mode during a pending edit.

Validation: 47 native-policy tests, 32 live-policy tests and 36 compiler tests
pass. Tests cover failure/fallback, no retry loop for the failed snapshot,
reconstruction after a changed source, old edit completions and shutdown errors.
`node out/extension/tex/verifyNativeRecovery.cjs /absolute/path/to/WLaTeX`
additionally exercises real session termination and reconstruction, old-view
invalidation, new source/map publication, unsaved-buffer preservation and old PDF
immutability. Local evidence: `/tmp/wpaper-native-recovery-verification.json`.
The verifier terminates through the SDK's public close contract; unexpected
process-crash recovery in a live VS Code session remains unverified. WLaTeX stays
optional and separately installed.

## 2026-09-20 — unique display generations across compiler lanes

Native generations now use the conventional compiler's shared display ID
allocator. The SDK retains its own strictly increasing, per-session build
counter. Previously both counters started at 1, so switching compiler lanes or
reconstructing a worker could reuse the displayed generation number and cause
`shipDecision` to suppress a changed PDF as "same generation". Shared display
IDs remove that collision while identical-content suppression still works.

Validation: a new regression executes the actual native lane with a controlled
SDK boundary, interleaves conventional ID allocation and reconstructs the lane.
It checks monotonic display IDs, independent SDK IDs and changed/unchanged PDF
shipping. That test, 47 native-policy tests, 36 compiler tests and nine
viewer-shipping tests pass. The real session-reconstruction verifier also checks
unique display IDs and admission of the changed recovered PDF. Evidence:
`/tmp/wpaper-native-generation-verification.json`. Full live UI acceptance and
separate four-platform release verification remain open.

## 2026-09-20 — distinguish native previews from authoritative output

Native map answers now report `probably-current` while available. No verified
parity receipt with the configured authoritative compiler is admitted yet, so
native previews cannot claim `fresh`. This does not weaken the independent
`exact` source-span property: verified source tokens and glyph geometry still
support native navigation, typing and selection. Invalid views remain unmapped.

The viewer identifies WLaTeX output as a preview whose layout may differ from the
final PDF and points to Save/Compile for the configured compiler. It no longer
uses `rerunWanted` to claim native references are exactly one pass behind or that
background work is necessarily running. Build logs similarly identify a pending
authoritative build without inventing a pass count.

Validation: 12 native-map tests, 47 native-policy tests and ten viewer-shipping
tests pass. The real native PDF verifier still passes inverse navigation,
mini-editor, range, Shift-pick and widen/shrink checks with the changed flags.
Evidence: `/tmp/wpaper-native-honesty-verification.json`. This implements
conservative preview status, not the cross-engine parity gate: per-document
parity measurement, live UI acceptance and four-platform releases remain open.

## 2026-09-20 — full reference through the WPaper adapter

`verifyNativeProject.cjs WLATEX_INSTALL MAIN_TEX [EXPECTED_PAGES]` copies the
supplied project to a temporary directory, builds through the actual
`NativeBuildLane`, inserts an unsaved leading comment and rebuilds. It verifies
old-view invalidation, new map admission, independent display generations,
unchanged PDF suppression, no changed/removed SDK pages, preserved saved source
and old PDF bytes. One exact main-file source point is queried on each mapped
page. The report records page coverage, item counts, hashes and timings; it does
not claim every glyph was independently checked.

The frozen 15-page reference passes with 15 mapped pages and 22,363 exact
main-file items. Source SHA-256:
`d980e15d5b62076aa4df5f868c71a8d026464d4931a9f373faec6b3afb8c2bc5`.
Evidence: `/tmp/wpaper-native-reference-adapter.json`. The initial build took
66,318 ms and the comment-only rebuild 66,315 ms; the 15 sampled forward queries
took 46.9 ms total. These are single-run observations, not latency percentiles.
They demonstrate the delivery/map path on the reference and expose the missing
incremental engine path: this cold-build adapter is not yet an interactive
compilation solution.

Cross-engine endpoint/glyph parity remains owned by the engine's reference
verifiers and is not inferred from this adapter test. Its SDK has no parity
comparison API. Full live UI acceptance, incremental compilation, cross-engine
parity admission and separate four-platform release verification remain open.

## 2026-09-20 — cancel stale work before native compilation

The build lane now checks its captured source revision and abort signal before
reading sources, after queued edits, around source synchronization/capture,
while admitting discovered dependencies and around map publication. Previously
a request superseded while waiting for edits could still synchronize its old
source snapshot and launch a cold build before the final revision check refused
it. Stale work now stops before those subsequent operations. SDK process-group
cancellation remains responsible for interrupting an already running compiler;
these checks do not cancel an in-flight worker RPC themselves.

Validation: 50 native cancellation/generation/policy tests pass, including abort
and source-edit interleavings at queued edits, source open, capture and publication,
plus an already aborted request. The real session-recovery verifier also passes
with the final lane (`/tmp/wpaper-native-cancellation-recovery.json`). This avoids
unnecessary superseded cold builds; it does not close the measured 66-second
reference build latency or implement incremental native execution.

## 2026-09-20 — four-platform consumer CI

`.github/workflows/wpaper-native-integration.yml` runs dependency-free runtime,
map, generation, cancellation, coordinator and viewer-shipping checks on the four
release targets: macOS ARM64, macOS x64, Windows x64 and Linux x64. Each job
asserts Node's actual platform/architecture before testing. The matrix uses
GitHub's [documented hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
(`macos-15`, `macos-15-intel`, `windows-2022`, `ubuntu-24.04`) and Node 24.
It triggers for relevant pull requests/pushes and supports manual dispatch.

The tests require no npm dependencies, TeX Live or WLaTeX installation. Local
validation blocked external Node module loading and passed all 78 assertions
across the six suites (the Node runner reports 69 tests because the older
viewer-shipping suite wraps ten assertions in one file test). YAML parsing,
four-target membership and test-file existence checks also passed.

No workflow was pushed or dispatched. Remote results for the other platforms
remain unverified. This is WPaper consumer CI, not evidence of native compiler
execution, separate native release artifacts or installers. Those remain open.

## 2026-09-21 — await complete native shutdown

Lane shutdown now marks the lane closed and invalidates pending builds
immediately. Compiler and source-session cleanup are both attempted and awaited,
including when either operation throws or rejects. Repeated close calls share
one promise. Only after both finish are failures reported together. This prevents
retirement from completing early while the other resource is still shutting
down. Closed lanes reject edits/builds and do not refresh maps.

Validation: 52 native cancellation/generation/policy tests pass. New tests cover
a synchronous compiler-close failure while source shutdown is delayed,
idempotent closure, post-close operations and a build waiting on queued edits
when shutdown starts. The real session-reconstruction verifier also passes:
`/tmp/wpaper-native-lifecycle-recovery.json`. Native incremental execution,
reference build latency, full live UI acceptance and separate platform release
verification remain outstanding.

## 2026-09-21 — prevent obsolete build preparation from creating sessions

The coordinator now tracks preparation ownership before asynchronous runtime
shutdown and compiler probing. A newer build request supersedes earlier
preparation, and disposal prevents any waiting preparation from constructing a
new lane or starting compilation. Retiring a lane detaches only that owner, so
an old continuation cannot replace a newly created session. Disposal is
idempotent and prevents build completion from scheduling another live pass or
notifying the disposed emitter.

Validation: 82 checks across the native CI suites and 32 live-policy checks pass.
New controlled interleavings verify disposal during runtime replacement and a
newer build completing before an older shutdown returns. No native SDK or
engine changes are involved. Incremental compilation, full live UI acceptance,
remote CI results and separate platform release artifacts remain open.

## 2026-09-21 — configurable compiler timeout

`wolfbook.tex.compileTimeoutMs` now controls both conventional builds and optional
native previews. Its default is 180,000 ms, preserving the conventional compiler's
existing default; settings allow 1,000 through 3,600,000 ms. Each fallback compiler
receives its own limit. The limit covers the compiler operation, not the lane's
source synchronization or subsequent map publication. NativeBuildLane now forwards
a caller-supplied `timeoutMs` to the SDK instead of silently using its default.

Validation: 55 native cancellation/generation/policy checks and 32 live-policy
checks pass. Tests verify propagation to the actual native adapter's SDK call
and to both branches of coordinator fallback. The real recovery verifier now
also forces a one-millisecond SDK timeout, then reconstructs a session and
successfully builds and publishes a map. Evidence:
`/tmp/wpaper-native-timeout-verification.json`. This bounds expensive work; it
does not implement incremental compilation or close the interactive latency gate.

## 2026-09-21 — real VS Code extension-host/webview smoke check

`launchNativeVSCodeCheck.cjs WLATEX_INSTALL CODE_CLI` creates a temporary user
profile, extension directory and four-line paper, then launches this checkout
with VS Code's extension test runner. WLaTeX's machine-scoped installation path
is configured in that isolated user profile; workspace settings cannot supply
it. The test instantiates the actual coordinator, projection and viewer with
in-memory view-state storage inside the real extension host. It opens the native
PDF in the actual webview and waits for PDF.js's opened acknowledgement, makes
an unsaved editor edit, refreshes the native map, and executes inverse navigation
against the current displayed generation. Assertions use real VS Code documents
and selections, not the headless vscode stub.

Run on macOS, with a compatible optional frozen format if available:

```sh
node out/extension/tex/launchNativeVSCodeCheck.cjs /absolute/WLaTeX "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
```

The check passes on VS Code 1.137.0 / Node 24.18.1 / macOS ARM64. Evidence:
`/tmp/wpaper-native-vscode-check.log`, with the temporary run directory and JSON
report. The development instances exited after testing. This proves the native
build, actual PDF.js opening, unsaved source translation and inverse selection
path together. It does not verify complete extension-command registration,
canvas pixels, physical pointer gestures, all platforms or interactive latency.
Desktop inspection through the computer-use tool timed out, so visual/pointer
acceptance is explicitly false in the report rather than inferred from the
extension-host result.

## 2026-09-21 — real-host checks with WLaTeX absent

The isolated VS Code launcher now accepts a third argument: `native` (default),
`default` or `missing`. The latter two clear the installation setting and remove
`WLATEX_HOME` from the launched process environment. `default` uses the ordinary
`auto` map policy; `missing` explicitly opts into WLaTeX with no configured
installation. These tests assert a conventional generation, no native lane or
cache, a real PDF.js open acknowledgement, and successful rebuilding of unsaved
source. The rebuilt acknowledgement must name the new generation even when PDF
content is unchanged. The missing-install mode additionally checks the fallback
reason; normal mode must not report a native error.

All three modes pass in fresh VS Code 1.137.0 / Node 24.18.1 sessions on macOS
ARM64. Final-code evidence: `/tmp/wpaper-vscode-default-final.log`,
`/tmp/wpaper-vscode-missing-final.log`, `/tmp/wpaper-vscode-native-final.log`.
Each report names its isolated profile/workspace. Native mode still verifies
translated inverse selection after an unsaved edit. These checks do not exercise
physical pointer gestures or prove canvas pixels, native execution on other
platforms, or incremental compilation. The WLaTeX checkout exists on this host;
absence tests prove operation without a configured installation, not uninstall
behavior.
