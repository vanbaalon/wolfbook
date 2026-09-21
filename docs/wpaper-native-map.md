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

## 2026-09-21 — precise native mini-editor mutations

Native mini-editor cards now capture the textarea's `beforeinput` selection and
send each supported input as an explicit source operation. The handler validates
the prior block text, current document text, UTF-16 boundaries and reconstructed
result before applying only that range. Ordinary insertions, selected replacements,
backspace, forward deletion and cut therefore preserve untouched source pieces.
Repeated text is not aligned or searched to guess which occurrence changed.
Unsupported or inconsistent browser input falls back to the previous whole-block
replacement, which conservatively loses provenance for that replaced text.
Non-native cards retain their existing debounced update policy.

This closes a real gap in the previous native card path: replacing an entire
block for every keystroke discarded the provenance of all its unchanged text.
Card offset tracking now also keeps the card's own insertions at either boundary
inside the block. Restored and stepped native cards carry the operation mode.

Validation: 52 native-policy tests, 207 sync tests and 35 panel tests pass.
Coverage includes repeated-character insertion positions, Unicode deletion,
selected paste, unknown/mismatched operations, and card-boundary tracking. The
real VS Code test opens a card over the older native PDF, inserts `NEW` inside
`Alpha`, verifies the retained `l` still maps and inserted characters do not,
and mirrors the card selection into the real editor. Evidence:
`/tmp/wpaper-vscode-mini-edit.log`. This uses the actual edit handler and VS Code
WorkspaceEdit; physical browser input/pointer and visual acceptance remain open.

## 2026-09-21 — reject stale native card edits

Native card updates now carry their prior displayed text, including browser
inputs without a precise range. If that baseline, the current block or the
session's text changed before application, the handler refuses the write rather
than falling back to a whole-block replacement. The session becomes conflicted
and cannot write or save again until reopened. A session closed/replaced while
its document opens likewise cannot write.

The client retains the latest local draft for copying, displays a persistent
"Source changed — copy edits, then reopen" label, and ignores later source-text
updates for that conflicted card. Local typing can continue for recovery/copying
but is not sent to the source. Reopening creates a new session against current
source. This is explicit conflict handling, not an automatic merge.

Validation: 55 native-policy, 207 sync, 35 panel and ten viewer-shipping checks
pass. Tests cover stale operation rejection, later save rejection, closure
during document opening and protection of the newest local draft against queued
updates. The real VS Code verifier now changes source outside the native card,
submits its old operation, and confirms both that operation and a later full-text
write are rejected while current document bytes remain intact. Evidence:
`/tmp/wpaper-vscode-card-conflict.log`. Physical input/visual acceptance,
incremental compilation and other-platform native validation remain open.

## 2026-09-21 — reuse unchanged native page canvases

Native open messages now carry per-page PDF hashes only from the SDK report
paired with that generation's PDF hash. On a live document swap, the webview
retains an existing canvas only when its page hash, render scale, display density
and mounted DOM canvas still match. Missing, malformed or mismatched identities
fall back to ordinary rendering. A new open still invalidates source highlights,
clears text caches and refreshes PDF links against the new document. Pending
render cleanup is tied to its own job so an older completion cannot remove a
newer pending render.

Open timing messages record reused page numbers. The real VS Code check now uses
a two-page paper, edits page 2 and verifies page 1's existing canvas is retained
while page 2 is excluded from reuse. It then repeats native source translation,
mini-editor provenance and conflict checks. Evidence:
`/tmp/wpaper-vscode-page-reuse.log` (macOS ARM64).

Validation: 56 native-policy, 207 sync, 35 panel and 11 viewer-shipping checks
pass. Coverage includes page identity pairing, invalid hashes, changed pages,
scale and density changes, and the ordinary compiler path. This avoids redraws
of unchanged pages; it still sends a whole PDF through the webview channel.
Per-page transport, native incremental compilation, full visual/pointer
acceptance and other-platform native execution remain open.

## 2026-09-21 — real-host authoritative/native handoff

The VS Code acceptance test now takes its edited native paper through an
explicit authoritative build with the configured pdfLaTeX compiler, waits for
the new PDF.js acknowledgement, then rebuilds it as a native preview and waits
for that acknowledgement. It asserts increasing display generations, the
correct map type at each stage, unchanged current source bytes and a still-dirty
editor buffer. The return from a conventional PDF must not reuse canvases under
native page identities.

The complete native acceptance scenario passes on macOS ARM64, including prior
page reuse, mini-editor provenance and conflict checks. Evidence:
`/tmp/wpaper-vscode-engine-handoff.log`. This is service-level orchestration in a
real extension host/webview, not a physical Save-button test. Incremental engine
execution, per-page transport, visual/pointer acceptance and four-platform
native release verification remain open. The native engine/SDK remain assigned
to Track A by `WLaTeX/docs/work-split.md`; ownership clarification has been
requested before crossing that boundary.

## 2026-09-21 — CRLF native mini-editor protocol

Native cards now exchange LF text and UTF-16 textarea offsets explicitly while
retaining raw document text for source admission. Precise operations convert
those offsets back to CRLF document offsets; inserted text uses the document's
line endings. Caret and selection messages convert in both directions, and
restored card selections clamp to textarea length. An unchanged textarea does
not rewrite the source merely because its line endings are normalized.

The regression test covers a multiline insertion after an emoji, exact edit
bounds, backward selection, source-to-card selection, unchanged submission and
whole-block fallback. The 57 native-policy, 207 sync, 35 panel and 11 shipping
checks pass (`/tmp/wpaper-crlf-final-tests.log`).

The real VS Code launcher accepts a fourth `lf|crlf` argument. The native CRLF
scenario passes with multiline insertion, a subsequent edit after the newline,
caret selection, conflict rejection, PDF.js page reuse and conventional/native
handoff (`/tmp/wpaper-native-crlf-final-host.log`). This exercised Windows-style
source text on macOS ARM64, not the Windows native runtime. Physical gestures,
visual acceptance, other-platform native execution, incremental compilation and
per-page transport remain outstanding.

## 2026-09-21 — unexpected source-worker crash recovery

A rejected native point/range membership query now invalidates that map before
propagating the error. Cached inverse hits and source actions cannot continue
using a view after its live query failed; recovery needs a newly admitted map.
This does not detect an idle worker's exit before any operation observes it.

The real VS Code acceptance test now identifies the exact source-worker child
of its isolated extension host and sends SIGKILL. It checks query rejection and
immediate map invalidation, then edits the unsaved document, waits for lane
retirement and rebuilds. The replacement session contains the current unsaved
text, produces a newer display generation, answers forward navigation and opens
its PDF in PDF.js. The saved source and old PDF remain unchanged. Process killing
is currently exercised on Unix only; Windows reports the crash check as false.

All 70 native map/policy checks pass, including point and range failure paths.
The real CRLF/native acceptance scenario passes on macOS ARM64:
`/tmp/wpaper-native-worker-crash-final.log`. This closes the previously untested
unexpected-process-exit recovery path. Incremental compilation, per-page
transport, visual/pointer acceptance and four-platform native release testing
remain outstanding.

## 2026-09-21 — project-file lifecycle acceptance gate

Run `node out/extension/tex/verifyNativeFiles.cjs /absolute/WLaTeX/install`
with the same native format environment as the other real-producer verifiers.
It builds a project, renames an included file while retaining a stale host
include graph, deletes that file, submits its unsaved overlay, and checks
recovery, mapping, saved bytes and immutable prior PDFs.

The macOS ARM64 run proves native discovery handles the rename, cached source
bytes do not resurrect a deleted dependency, the missing include rejects without
a compiler timeout, and a recreated dependency compiles/maps its unsaved text
without saving it. However, the full gate currently returns **INCOMPLETE** and
exit code 1: the SDK/compiler rejects overlays for paths absent from its captured
on-disk project. Evidence: `/tmp/wpaper-native-file-lifecycle-final.log`.

The rejected case is retained as a required assertion, not skipped or called
supported. After the SDK accepts missing-file overlays, this same verifier must
return PASS without recreating that file on disk. The restriction is in Track
A's `crates/lab/src/native_compile.rs` freeze function (the normal lab compiler
has the same restriction). Resolving it requires admitting safe project-relative
new files into the frozen image while preserving path validation, size limits,
source binding and unsaved-buffer semantics. No SDK/native-engine files were
changed across the documented ownership boundary.

## 2026-09-21 — displaced source-range sweep

Range highlighting now processes uncertain origin intervals in source order,
admits all matching candidates from each worker answer, and skips already
queried prefixes. It no longer stores one membership set per source character
or repeatedly awaits those cached answers for every overlapping origin. Exact
contiguous origins still need no worker queries. Current-view checks, worker
failure invalidation, Unicode boundaries and CRLF traversal are preserved.

The independent membership oracle covers 80 seeded generated selections with
mixed overlapping and zero-length origins. Additional tests cover 300 overlapping
origins across 4,000 characters and explicit Unicode/CRLF query coordinates.
All 73 native map/policy tests pass. The real native navigation verifier also
passes range, Shift-pick, widen/shrink, mini-editor and inserted-source exclusion
checks (`/tmp/wpaper-native-range-navigation.log`).

An illustrative local run of the same large synthetic test against commit
196ca4b took 783 ms; the sweep took 11 ms. These are mock-worker host-bookkeeping
measurements, not real-worker latency acceptance. Both versions issue 4,000
point queries in that case; SDK range batching and incremental engine execution
remain necessary. Logs: `/tmp/wpaper-native-range-before.log` and
`/tmp/wpaper-native-range-final-unit.log`.

## 2026-09-21 — native PDF byte-range transport

Native preview messages now carry an opaque PDF descriptor instead of a complete
base64 PDF. PDF.js requests the byte ranges it needs over the existing webview
channel. The host pins an admitted PDF with a read-only file handle, checks each
requested offset/length and never accepts a client-supplied file path. Separate
builds have separate tokens; out-of-order responses cannot cross documents.
Conventional builds retain their existing full-PDF delivery path.

The client validates reply coordinates and length, handles read errors/timeouts,
and releases its token on abort/destruction. The host releases all remaining
handles on root change or panel disposal. This avoids relying on resource URLs
and the existing macOS `/var` versus `/private/var` access problem. PDF.js uses
64 KiB range chunks with automatic prefetch disabled. Larger requested ranges
are still valid; this is not a maximum-transfer-size guarantee.

Validation: 57 native-policy, 4 transport, 207 sync, 35 panel and 11 viewer-shipping
checks pass. The four-platform consumer CI now includes transport tests. Real
VS Code checks pass on macOS ARM64 both in CRLF/native mode and in default mode
without WLaTeX. Native checks cover PDF.js opening, unchanged-canvas reuse,
conventional/native handoff, worker crash recovery, and handle release after
handoff and panel disposal. Evidence: `/tmp/wpaper-pdf-ranges-final-host.log`,
`/tmp/wpaper-pdf-ranges-default-host.log`, `/tmp/wpaper-pdf-ranges-final-unit.log`.

This closes mandatory whole-PDF transfer in each native open message. It does
not establish changed-page-only delivery: PDF.js parsing/text extraction can
still request the entire file. Native incremental execution, semantic per-page
artifacts/TXDL, reference-paper latency/visual acceptance and other-platform
native execution remain outstanding. No runtime is bundled in the extension.

## 2026-09-21 — reuse native page text and reject stale sweeps

The viewer retains extracted text for native pages under their verified page
hashes. A subsequent PDF reuses only matching same-index pages and extracts
changed pages normally. Conventional PDFs clear this cache and keep their full
text sweep. Label/equation overlays still receive the text they require; every
new generation receives its page messages, including reused text.

Each asynchronous sweep captures one PDF document, page count and hash array.
It rechecks document identity and generation after extraction and before posting
completion. A replaced document cannot populate the cache or send stale text,
even when a force-open uses the same generation. The host independently rejects
text/completion messages for a generation it has not displayed.

Validation: 60 native-policy, 207 sync and 35 panel checks pass. Tests cover changed
and unchanged pages, transition to conventional PDFs, replacement during pending
extraction and stale host messages. Two legacy fixtures now explicitly set the
shown generation when simulating a new PDF. The real VS Code native/CRLF scenario
passes and confirms a page-2 edit reuses only page 1's extracted text, alongside
prior rendering, range-resource cleanup and crash recovery checks. Evidence:
`/tmp/wpaper-native-text-reuse-final-unit.log` and
`/tmp/wpaper-native-text-reuse-host.log`.

This reduces repeated extraction; it neither skips required label data nor
claims changed-page-only PDF transfer or reference-paper latency acceptance.

## 2026-09-21 — native text-cache admission regressions

Three additional tests exercise cache failure/recovery boundaries: a failed PDF
read is re-extracted on the next document rather than retained as an empty page;
malformed hashes and pages moved to another index do not reuse text; removed
pages are evicted and extracted again if later restored. All 63 native-policy
checks pass (`/tmp/wpaper-text-cache-admission.log`). These verify the existing
cache implementation; they do not add engine capabilities or close the broader
release/latency/visual gates.

## 2026-09-21 — visible interaction acceptance remains unverified

A fresh desktop-automation attempt can list running applications and identify
VS Code, but both the initial app-state request and a longer retry time out.
The retry reached the terminal tool result `Sky Computer Use request timed out`;
there is no remaining live UI request. No screenshot, physical click or pointer
sequence was obtained. Extension-host/webview checks remain valid evidence for
the scenarios they exercise, but do not establish visible interaction acceptance.

The native engine repository is still clean at a0710b8. Its public SDK contract
still exposes full builds and point queries, and the missing-file-overlay
acceptance gate remains INCOMPLETE. The existing Track A/Track B ownership split
has not changed. Completing the goal still requires engine-side incremental
execution/convergence and SDK work, separate native distributions and execution
on the four target platforms, and real visual/pointer acceptance. WPaper's new
byte-range delivery and page-content reuse do not substitute for those gates.

## 2026-09-21 — packaging inventory and release-gate audit

The actual `vsce ls` inventory includes the seven required native-integration
host/client assets and passes the new `verifyNativePackage.cjs` check: known
WLaTeX runtime directories/executables and generated `.wlatex` caches are absent.
No deployment script, package publication or installation was performed. Eight
runtime/package tests pass; package tests now join the four-platform consumer
CI matrix. Evidence: `/tmp/wpaper-vsix-native-admission.json` and
`/tmp/wpaper-package-admission-tests.log`.

[Release gates](wpaper-native-release-gates.md) now distinguish measured
consumer behavior from missing engine, packaging, performance, cache and visual
requirements. This audit does not mark the full project complete.

## 2026-09-21 — owned artifact caches and shared lifetime tokens

Each native lane now creates its own cache directory beneath `.wlatex/native`.
Generations and their public build reports carry a shared `nativeArtifactLease`;
map copies retain it, and range-loaded PDF handles retain it until release.
Code that keeps artifact paths beyond a generation's lifetime must also retain
this token. A finalization registry can reclaim returned artifact/source/log
paths after their tokens disappear. Shared or enclosing paths still referenced
by another report are retained. Collection pauses throughout compilation and
publication, and a successfully closed lane removes its owned directory once
no leases remain. Old shared cache directories are never swept.

Paths must be descendants of the owned cache and cannot traverse symlinks.
Cleanup failures retain entries for a later collection attempt. A lane whose
worker shutdown fails does not authorize cache removal. Returned-report cleanup
is opportunistic: it depends on normal JavaScript garbage collection, does not
force GC in the extension, and does not establish a hard disk quota. Partial
runs with no report are removed only when their lane's owned directory becomes
reclaimable. Crashed-process leftovers still need a separate startup policy.
Deletion currently runs synchronously at collection boundaries; large-directory
cleanup latency is not yet measured or bounded.

Validation: 71 cache/policy/package/transport tests pass, plus five native
cancellation/generation tests. An isolated test process with explicit GC verifies
that live generations, shared source paths, active builds and PDF handles protect
their resources; unrelated directories remain untouched. The real VS Code
CRLF/native scenario passes with cache isolation, compiler handoff, worker crash
reconstruction, old-PDF retention, text/canvas reuse and handle release.
Evidence: `/tmp/wpaper-native-cache-final-unit.log`,
`/tmp/wpaper-native-cache-unit.log`, `/tmp/wpaper-native-cache-host.log`.
The package inventory guard now requires eight integration assets, including
`nativeArtifactCache.js`; see `/tmp/wpaper-vsix-cache-admission.json`.

## 2026-09-21 — asynchronous artifact reclamation

Recursive artifact deletion now uses asynchronous filesystem operations. Build
startup reserves its slot and waits for any collection already in progress;
leases may be created only within an active build. Collection remains disabled
while compilation/publication uses shared paths. Lane shutdown awaits the
applicable cleanup promise. Source-version and cancellation checks bracket both
cleanup waits, so an edit while deletion is pending cannot admit an obsolete
generation afterward. This supersedes the synchronous-deletion limitation above.

All 72 cache, cancellation, generation and native-policy checks pass. A controlled
pending filesystem deletion proves the event loop can run while a build is held
at the cleanup boundary. Tests cover source changes during both entry and exit
waits. The real VS Code native/CRLF scenario passes, including worker crash
recovery, old artifact retention, PDF handles and reused page content. Evidence:
`/tmp/wpaper-async-cache-final-unit.log` and `/tmp/wpaper-async-cache-host.log`.

GC-dependent eviction timing, a hard disk quota and recovery of crashed-session
leftovers remain open. Asynchronous deletion does not establish the engine's
interactive latency or checkpoint-storage acceptance gates.

## 2026-09-21 — retain deferred reclamation paths

Artifact paths now have a persistent cleanup ledger separate from live-generation
records. Previously a dead generation's parent directory could be protected by
a live nested artifact, then lose its cleanup record and remain until shutdown.
The ledger keeps that parent pending until the nested reference expires.
Collection requests made during an asynchronous deletion trigger a subsequent
pass instead of being lost, while build reservations still suspend collection.

Eleven cache/lifecycle/generation checks pass, including a real forced-GC child
process that checks parent-directory reclamation before closing the cache. The
real native recovery verifier also passes timeout enforcement, session rebuilding,
unsaved-source preservation, old-PDF immutability and forward mapping. Evidence:
`/tmp/wpaper-cache-ledger-final-tests.log` and
`/tmp/wpaper-cache-ledger-recovery.log`. Hard quotas and orphaned-session cleanup
remain open, alongside the engine and release requirements in the gate audit.

## 2026-09-21 — frozen reference visual inspection

Completed full-page visual comparison of all 15 pages in the frozen native and
authoritative PDFs, with actual PDF hashes verified. The figures are visibly
present, but line wrapping and equation spacing differ; both versions retain
unresolved references on page 14. This closes the coarse inspection task, not
the rendered-fidelity acceptance gate. Reproduction, artifact identities,
observations and limits are recorded in
[the reference review](wpaper-reference-visual-review.md). No engine files or
source PDFs were changed.

## 2026-09-21 — reclaim unreported build artifacts

At idle build boundaries, the cache now sweeps its exclusively owned session
directory for files not protected by a live artifact lease. This also finds
partial output from cancelled or failed producers that never returned a report;
previously those files survived until lane shutdown. The sweep uses no SDK
directory-layout assumptions. It preserves leased directories and files,
reclaims unleased siblings, does not follow symlinks, and never traverses another
session's cache. Build reservations await the entire asynchronous sweep.
Deletion failures remain retryable at the next collection boundary.

Thirteen cache/cancellation/generation tests pass, including new unreported-output
and temporary-deletion-failure cases. The real VS Code native/CRLF scenario also
passes with old-PDF retention, worker crash recovery, native/conventional handoff,
PDF range handles and unchanged page reuse. Evidence:
`/tmp/wpaper-unreported-cache-host.log` (isolated host
`wpaper-ui-kZJm9G`). This closes cleanup of unreported artifacts in a running
session; live-generation eviction remains GC-dependent, hard quotas remain
unimplemented, and crashed-host session cleanup still requires lifecycle support.
