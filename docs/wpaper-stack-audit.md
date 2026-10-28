# WPaper stack audit

Audit date: 2026-10-02. Extension version: 2.10.1. Local host: macOS arm64,
VS Code 1.139.1. This audit covers WPaper with WLaTeX Pro enabled, with Pro
disabled, and with the optional runtime unavailable. It includes the preceding
mini-editor fixes requested in this session.

Confirmed consumer-side defects have been fixed in the working tree. Source
edits now reach VS Code immediately in both modes, and paragraph titles stay
with their opening prose. Standard mode still uses a debounced conventional
compiler for PDF updates; immediate source editing does not imply immediate
typesetting of every paper.

## Scope

The review follows activation and configuration through document projection,
render scheduling, native runtime selection, PDF transport, source mapping,
mini-editor edits, save and disk reconciliation, Pro controls, and recovery.
The existing suites also cover references, search, comments, review navigation,
folding, version comparison, TikZ, Mathematica blocks and Overleaf integration.
Those integration suites use fixtures or fake services where applicable;
this audit did not connect to a live Overleaf project or push Git changes.

The WLaTeX checkout was used as an external runtime. Its engine and SDK sources
were not changed. This is a consumer audit, not engine certification or a
replacement for the broader [release gates](wpaper-native-release-gates.md).

## Findings and fixes

| Area | Observed defect | Result |
| --- | --- | --- |
| Paragraph blocks | A `\paragraph` title could open separately from its prose. | Title and opening prose form one mini-editor block, including multiline titles and intervening comments. |
| Live source edits | Standard cards delayed input by 250 ms and replaced the entire block. | Each input sends its text and caret immediately; verified input operations replace only the edited range in either mode. |
| Typing environment braces | Incomplete `\begin{…}` and `\end{…}` commands duplicated the preceding character in the syntax layer, making `{` appear to insert a newline and shifting the visible text away from the caret. | Incomplete commands retain ordinary command highlighting; real keyboard tests check exact visible text, source messages and caret positions throughout typing and deletion in both modes. |
| Full builds during typing | A deadline forced conventional builds every three seconds and Pro settlements every ten seconds despite continued typing. | All automatic full builds use a trailing idle timer in both modes; cooldowns also retain their full pause. |
| Invisible settlement | Standard-mode automatic builds could still request the blue shade and continue after another key. | Automatic builds in both modes retain the displayed paper without a shade, cancel on resumed typing, and reject obsolete preparation or completion before merging. Current results retain the existing smooth PDF handoff. |
| Bitmap math fonts | `bbm10` had no vector outline, so the live renderer discarded the whole page and retained the old PDF even while the incremental engine recomputed it in milliseconds. | The native lane caches the actual PK bitmaps and supplies glyph paths at the same resolution and placement as the PDF producer. Final-line edits remain live. |
| Added page order | A missing page inserted after an existing later page produced sequences such as `8,10,9`. A live tail page could also be dropped if an intervening page was absent. | All placeholder insertion uses numerical page order and live tail pages create the intervening page boxes. Empty boxes needed by a later live page persist until reconciliation. |
| Pro fallback indication | The badge could report live while the visible page had fallen back to the PDF. | Pro is crossed on visible failed pages; hover and the details panel name the page and the actual font or drawing error. Successful live rendering clears the indication. |
| False engine incompatibility | A pdfLaTeX PDF with 12 errors was treated as proof that only pdfLaTeX could build the paper, disabling Pro until the preamble changed. | A fallback requires an error-free conventional build of the same current text. Comparisons from obsolete revisions cannot disable Pro. A proven fallback is retried after any source change. Temporary live syntax errors cross the badge with their actual reason while retaining the live lane; successful current previews clear it. |
| Macro inverse search | Only the first definition on a line and eight preceding lines were examined. Later `\newcommand` definitions on the same line, including the shared-line symbols in the user's paper, could send an inverse click to the preamble. | A cached index checks every defining command in the current source buffer, without a line-lookback cap. It respects comments, escaped delimiters, optional defaults and supported definition forms. Macro-generated ink targets its invocation in the equation; typed arguments and title text retain their own positions. Worker queries and local containment use the same rule for live and settled maps. |
| Error locations in the viewer | Live errors appeared only in a strip at the page top, and failed previews or conventional builds had no page annotation. | Expandable red banners sit beside the mapped source line in both modes, underline the affected ink and offer source navigation. Retained or nearby geometry is marked approximate. Errors without page geometry remain visible in an unmapped-error panel. Current successful diagnostics clear the banners; zoom and repeated updates preserve expansion without taking typing focus. |
| Mini-editor range expansion | Reaching the editor edge could only replace the current block through horizontal navigation. | A distinct Down press at the end appends the next block; Up at the start prepends the previous block. The same textarea and session retain focus, source gaps and comments. Expansion only reads the file, and keys typed during its reply are rebased as precise edits before save or close. Held or modified arrows retain their existing behaviour. |
| Shift cell boundaries | Expanded editors and the paper had no momentary indication of editable cell edges. | Holding Shift reveals faint rules between semantic cells in the mini-editor and at mapped cell edges in the paper, in both modes. Run-in titles stay with their prose. The decorations preserve text layout and native selection, follow edits and wrapping, and clear on release, blur or hiding the panel. Paper rules disappear while the source is ahead. Decoration requests use the existing map without compilation or map warm-up. |
| Duplicate PDF delivery | Overlapping render-state refreshes checked the old display hash before awaiting scroll capture and each sent the same generation. The user's WPaper log showed repeated PDF opens. | Refresh requests coalesce; the reproduced three-send case now ships one PDF. Browser checks preserve the same focused textarea, draft and backward selection through repeated updates in both modes. |
| Reader edit attribution and builds | Reader writes from the mini-editor and page-typing helpers shared the review bus with agent edits. The compile listener ignored `origin: 'user'` and requested a priority full build after every reader key. | The listener filters reader-origin events; incremental previews and the existing typing-pause settlement remain responsible for those edits. Genuine completed agent writes retain their priority build. A registration-level regression drives both real reader-edit helpers through document-change callbacks and checks both kinds of completion. |
| Idle saves | The viewer's automatic save entered the explicit authoritative-compile path, restarting work and potentially showing progress. Save metadata also reset the rendering timer. | Automatic persistence reuses the edit's render/convergence schedule. Metadata does not count as typing; background settlement stays quiet. Explicit saves and Compile retain their requested builds. |
| Closing a card | Closing could discard an edit already queued for application. | Close waits for queued edits and rejects an obsolete session identifier. |
| Fresh dirty buffers | The restored unsaved buffer was remembered as the disk baseline. | Startup reads the actual disk baseline, preventing unchanged disk events from producing a false conflict. Genuine external edits retain conflict handling. |
| Concurrent source edits | Standard mode could apply a stale card over newer source text. | Both modes check the source and card baseline before applying an edit; conflicting drafts are preserved. |
| CRLF documents | Standard caret and selection offsets treated textarea LF text as raw document text. | Both modes convert offsets in both directions and preserve document line endings. |
| Save notifications | A document event with no content changes invalidated maps and marked the PDF behind. | Metadata-only events do not enter the rendering edit path. |
| Source caches | Equal-size external writes with a restored modification time could reuse stale content. | Hash and folded-text caches also check change time; an external invalidation drops cached folded text. |
| Preview freshness | An older preview finishing after a newer key could claim to show that key. | Freshness belongs to the preview's captured input revision and edit time. |
| Pro status | A conventional PDF with a Pro lane attached could spin as settling indefinitely. | Completed output reports ready; status identifies its compiler and pending references. Ordinary native PDF delivery does not show the former preview warning. |
| Pro switches | Existing cards retained Pro controls and alias key handling after disabling Pro. | Controls and handlers follow mode changes while retaining the same textarea, draft, focus and caret. Host editing actions also check current Pro availability. |
| Native map waits | The advertised map deadline did not bound a worker refresh that never replied. | The caller returns at its deadline, independently of the refresh. |
| Cleanup | Delayed native work could run after disposal, retirement or disabling Pro. | Preview, reference, map and grace timers are cleared or rejected; late results from retired lanes cannot update state. |
| Engine settings | Changing engine settings left old workers and preparation work active until another compile. | Settings retire old lanes, invalidate pending preparation and maps, and rebuild the visible paper using the new configuration. |
| Cold viewer startup | Multiple opens could initialize competing PDF workers; PDFs were sent before the client was ready. | Startup waits for the ready replay and shares PDF.js initialization. The webview explicitly owns its shared PDF worker across document replacement. |
| PDF acknowledgement | With no intersecting page and no observer callback, an open could acknowledge without painting the replacement. | At least one page is painted before acknowledgement. PDF-open errors are available in the WPaper log. |
| Caret replay | Suppressing the native typing pause discarded the mini-editor's caret ownership. | Rebuild replay retains the originating editing surface. |

## Validation

The full Node suite and browser results are recorded in
`/tmp/wpaper-stack-audit-final-tests.log` and
`/tmp/wpaper-stack-audit-final-webview.log`. Browser checks run the real WPaper
client and host-generated HTML in Chromium with a compiled fixture PDF.

| Check | Evidence |
| --- | --- |
| Full Node suite | 134 of 134 test suites passed. |
| Browser regression suite | 40 passed, including focused mini-editor preservation through PDF updates, environment brace typing and deletion, immediate input, mode switches, overlapping opens and missing viewport geometry. Latest follow-up log: `/tmp/wpaper-sticky-webview.log`. |
| Real VS Code standard mode, CRLF | Passed conventional unsaved rebuilding, precise multiline card edits, bidirectional selections and stale-edit rejection without WLaTeX. |
| Real VS Code missing-runtime mode, LF | Passed fallback rebuilding and the same mini-editor checks. |
| Real VS Code Pro mode, CRLF | Passed range transport, unchanged-page reuse, multiline cards, stale-edit rejection, live-page navigation, compiler handoffs, actual source-worker crash recovery, TikZ service operations and handle cleanup. |
| Real native interactive verifier | Passed reference replay, incremental convergence, page identity and map binding, glyph rendering, preview failure isolation and unchanged saved source. |
| Real native recovery verifier | Passed timeout enforcement, session reconstruction, unique generations, unsaved-text preservation, immutable old PDFs and recovered forward mapping. |
| Packaging inventory | Passed required integration assets and exclusion of bundled WLaTeX runtime executables and generated caches. |

On the two-page Pro fixture, five edits took 2–7 ms to apply and 12–23 ms to
reach a posted preview. These are extension-host measurements on a small
fixture, not physical screen latency or a long-paper performance guarantee.

The isolated VS Code service harness supplies a controlled animation clock.
Earlier uncontrolled runs timed out because macOS can suspend animation frames
in occluded test windows. The controlled clock applies only to
`verifyNativeVSCode.cjs`; product rendering uses the browser's normal clock.
Reports explicitly leave physical pointer gestures and visual acceptance
unverified. The interactive verifier was also updated to require each changed
page's own map identity while accepting a preceding paragraph-fragment map,
and to test a genuine missing-main-file failure rather than treating an
unrelated dirty file as a preview failure.

The typing/compile follow-up also passed the isolated VS Code checks in Pro
and standard mode. Logs are `/tmp/wpaper-sticky-vscode-native.log` and
`/tmp/wpaper-sticky-vscode-default.log`. The final full Node run passed all
134 suites (`/tmp/wpaper-sticky-all-tests-final.log`). Scheduling regressions simulate fifteen
seconds of sustained editing without a full build, then verify one build
after idle; Pro preview requests still follow every edit. These checks do not
measure perceived typing latency on the user's long paper.

The restored invisible-settlement logic subsequently passed all 134 suites
(`/tmp/wpaper-invisible-build-all-tests.log`) and the isolated VS Code Pro
check (`/tmp/wpaper-invisible-build-vscode-native.log`). Deferred-worker tests
exercise both engines and the actual viewer's shade messages: unchanged
results merge, resumed typing aborts immediately, late cancelled results
leave the displayed generation intact, and typing during asynchronous
preparation prevents an obsolete compiler launch.

## Remaining validation

The final-line and page-order follow-up passed all 135 Node suites
(`/tmp/wpaper-tail-all-tests.log`) and 43 real-browser regressions
(`/tmp/wpaper-tail-webview.log`). Both new page-order checks failed before
the fix. The native interactive verifier now includes bitmap math on its
last page and checks two consecutive final-line edits without fallback
(`/tmp/wpaper-tail-native.log`).

An isolated copy of the reported eight-page paper reproduced the `bbm10`
failure in the actual browser. After the fix, adding and extending its final
paragraph changed the last-page canvas pixels with no PDF fallback; the
second edit took about 13 ms in the native engine
(`/tmp/wpaper-real-tail-browser-final.log`). The real paper was read only.
These measurements do not include perceived latency in the user's live
VS Code window. No WLaTeX engine or SDK source was modified.
Package inventory also passed with `bitmapFont.js` required. The four
follow-up runtime files were installed and byte-verified; their previous
contents are backed up in
`/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-tail-preview-backup-fd_o1g4_`.

The false engine-fallback follow-up passed all 135 Node suites
(`/tmp/wpaper-false-off-all-tests.log`) and 44 browser regressions
(`/tmp/wpaper-false-off-webview.log`). New host regressions failed before the
fix and cover best-effort PDFs with errors, typing during a compiler
comparison, and recovery without changing the preamble. The browser check
verifies that a source error crosses Pro with its line and message while
keeping editing enabled, then clears after a successful preview.

An isolated malformed equation reproduced the compiler distinction with the
real engines: WLaTeX rejected the extra brace, while pdfLaTeX returned a PDF
with one error. Repairing the equation without changing its preamble restored
the native build in about 41 ms (`/tmp/wpaper-recoverable-math.log`). The user's
paper was not edited. The three runtime files for this follow-up were installed
locally with backups and byte verification.

The error-banner feature passed all 136 Node suites
(`/tmp/wpaper-error-banner-all-tests-final.log`) and 46 browser regressions
(`/tmp/wpaper-error-banner-webview.log`). A real conventional two-page fixture
checks the error's file, line and second-page SyncTeX geometry. Native tests
check approximate hints from retained ink without admitting stale maps for
editing. Browser tests exercise both modes, expansion, source navigation,
zoom, focus preservation, recovery, unmapped errors and plain-text rendering
of compiler messages. An expanded banner was visually inspected in
`/tmp/wpaper-error-banner.png`. These checks use isolated fixtures and leave
the user's paper unchanged.

Packaging inventory passed with `errorAnnotations.js` required. The six
runtime files for error banners were installed locally and byte-verified;
the previous files and the inventory of newly added files are backed up in
`/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-error-banners-backup-0s18psaa`.

The subsequent mini-editor range expansion feature passed 137 Node suites
(`/tmp/wpaper-mini-extend-all-tests-final.log`) and 48 browser checks
(`/tmp/wpaper-mini-extend-webview.log`). New checks cover Up/Down growth in
both modes, LF and CRLF, run-in titles, equation blocks, preserved comments,
file boundaries, queued edits, conflicts, retained textarea focus and precise
rebasing of keys typed before the reply. Save and close remain ordered behind
those keys. A native clipboard test now executes the actual keyboard handler
with and without a pending expansion.
The two runtime files were installed locally and byte-verified, with previous
contents backed up in
`/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-mini-extend-backup-rwev_cj1`.

The subsequent Shift-boundary feature passed 137 Node suites
(`/tmp/wpaper-shift-all-tests-final.log`) and the 50-check browser suite
(`/tmp/wpaper-shift-webview.log`). Final focused checks
(`/tmp/wpaper-shift-final-focus.log`) also cover expanded-editor boundaries,
normal Shift+Arrow selection, LF/CRLF grouping, moved offsets, wrapping,
release/blur/visibility cleanup, stale geometry and the dedicated decoration
protocol. Visual inspection of `/tmp/wpaper-shift-mini.png` confirmed faint
rules without extra text spacing. Package inventory passed. The three runtime
files were installed and byte-verified; prior contents are backed up in
`/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-shift-cells-backup-16vdesk_`.

The follow-up reader-origin compile fix passed 137 Node suites
(`/tmp/wpaper-reader-agent-all-tests.log`). Its wiring regression fails with
the old listener recreated in memory (`/tmp/wpaper-reader-agent-before-fix.log`)
and passes with the fix (`/tmp/wpaper-reader-agent-build-focused.log`). All
99 focused native-policy/review-navigation tests also passed
(`/tmp/wpaper-reader-agent-native-focused.log`). The live WPaper log in
`output_logging_20261002T135304/4-WPaper.log` confirms incremental WLaTeX
updates; the same session's repeated priority builds and PDF resends follow
reader events being sent to the agent compile handler. The updated `index.js`
was installed and byte-verified, with its previous version saved in
`/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-reader-agent-build-backup-d1nxx8pz`. Reload is required to replace the listener already registered
in the running extension host.

The macro inverse-search follow-up passed 137 Node suites
(`/tmp/wpaper-macro-inverse-all-tests.log`) and 128 focused native-map/policy
tests (`/tmp/wpaper-macro-inverse-focused.log`). The shared-line regression
reproduced a definition-line target before the change
(`/tmp/wpaper-macro-inverse-before.log`). New checks cover each symbol in a
shared-line definition fixture, worker and local inverse paths, live and settled
views, definitions longer than eight lines, optional defaults, comments,
escaped delimiters, title text, typed arguments and cache refresh for edited
buffers. The updated `nativeMap.js` was installed and byte-verified; its
previous version is saved in `/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-macro-inverse-backup-96rhebi6`.


The two-panel interaction follow-up removes the unused Ask/Find refs/Copy key
source CodeLens row while retaining managed-block status and review controls.
Double-click requests source focus before PDF extraction or inverse mapping,
and cancels the preceding single-click replies so they cannot refocus an open
mini-editor. Viewer-only navigation retains its existing layout transition.
Cut/delete and drag use the same structural range expansion: matched braces,
parentheses, brackets, math delimiters and nested environments, with directly
attached sentence/phrase punctuation. Drag preview redraws the expanded range
before resolving the landing point; cut copies the complete removed fragment,
and deletion anchors follow its expanded beginning. Source edits remain one
WorkspaceEdit/undo.

Validation: 137/137 Node suites (`/tmp/wpaper-viewer-actions-all-tests.log`)
and 51 browser checks (`/tmp/wpaper-viewer-actions-webview.log`). Subsequent
focused checks cover delayed single-click cancellation, map-free editor focus,
expanded delete/cut/drag behavior, CodeLens registration, native map compatibility
and preserved review controls. The final focus browser check also passes while
mapping is paused in both modes. JavaScript syntax and `git diff --check` passed.
The four runtime files were installed and byte-verified; previous contents are
saved in `/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-viewer-actions-backup-zfw_aysx`. No VS Code reload, commit, push, version bump or
paper-source modification was performed.


The repeated own-edit disk-conflict report exposed an additional save race:
will-save text can be changed by save participants, while the TextDocument
passed to did-save can already contain newer unsaved mini-editor typing.
Neither snapshot then identifies the bytes actually written. DiskWatch now
tracks the buffer versions during a save, confirms actual persisted bytes at
completion, discards unused save intent/candidate snapshots, and keeps the
confirmed baseline separate from the current dirty buffer. Unknown watcher
bytes arriving before completion wait briefly and are reread before any
external-change/review handling. Failed save transactions expire, and ordinary
keystrokes outside a save do not read/hash buffer text for this tracking.

The two new real-registration regressions fail against the previous installed
runtime loaded in memory (`/tmp/wpaper-own-save-race-before.log`) and pass with
the fix (`/tmp/wpaper-own-save-race-focused.log`: 14 checks). Pure disk-guard
checks cover confirmed bytes after delayed events, newer unsaved text, failed
save expiration, and genuinely external content (`/tmp/wpaper-own-save-race-diskguard.log`: 19 checks).
All 137 Node suites pass (`/tmp/wpaper-own-save-race-all-tests-final.log`).
An extracted-client test fixture also received the focus epoch introduced by
the preceding double-click fix. Syntax and whitespace checks pass. The two
runtime files were installed and byte-verified; previous contents are backed
up in `/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-own-save-race-backup-399obht7`. The running host needs a user-initiated window reload. No
paper source, global settings, extension version, or repository history was
changed.


The mini-editor shortcut follow-up adds selected-line LaTeX comment toggling
via Cmd+/ and Shift+Alt+A (Ctrl+/ also works when not owned by Pro's existing
fraction shortcut). The edit preserves indentation, blank lines, LF/CRLF,
selection direction and the textarea undo stack, and uses the normal immediate
reader edit path. Math structure shortcuts keep their existing behavior.

Comment panes now let native copy/cut shortcuts propagate. Ctrl/Cmd+V in any
editable text field uses a request/reply bridge to VS Code's text clipboard,
without browser permissions. Paste replaces that field's selection and remains
one undo operation. Replies cannot overwrite newer typing, a moved selection,
a closed field or another focused field; host clipboard failures leave text
intact. Covered fields include the source card, new/existing block comments and
the sidebar comment draft.

Validation: 137 Node suites (`/tmp/wpaper-mini-shortcuts-all-tests.log`) and
53 browser checks (`/tmp/wpaper-mini-shortcuts-webview.log`), plus the final
sidebar/Pro clipboard check (`/tmp/wpaper-mini-shortcuts-sidebar-browser.log`).
Pure checks cover CRLF, indentation, empty first lines and literal escaped
percent signs; host checks exercise clipboard replies and failures. JavaScript
syntax and whitespace checks pass. The two runtime files were installed and
byte-verified; previous files are backed up in `/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-mini-shortcuts-backup-b7szmdwl`. A user-initiated
window reload activates the host clipboard handler. No source paper, settings,
manifest, version or git history was changed.


The selection-toolbar follow-up adds Copy source location (file:line), beside
the existing LaTeX copy action. It copies the absolute path of the selection's
actual source document and its one-based starting line, including selections
in included files. It keeps source text and selection unchanged and uses the
same native selection validity guard as other selection actions. The action
is available with and without Pro.

Validation: 220 executed host sync checks
(`/tmp/wpaper-selection-location-sync.log`), a browser check exercising the
button in both modes and verifying it cannot initiate inverse navigation or
a drag (`/tmp/wpaper-selection-location-browser.log`), plus syntax/whitespace
checks. The two runtime files were installed and byte-verified; previous files
are backed up in `/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-selection-location-backup-qgi9msgk`. A user-initiated window reload activates the
host handler. No paper source or repository history was changed.


Cmd-click Compile (Ctrl-click where the OS delivers a click) now runs a full
build and writes `<root>.pdf` beside the root `.tex`, without a Save dialog.
Ordinary Compile retains the viewer-only build. The toolbar includes the
latest mini-editor draft; the host applies it in order before compiling, and
a pending block extension defers the request until its text has been rebased.
The exporter accepts the panel root and an explicit target, so another active
source editor cannot redirect the PDF. Current unsaved buffers are compiled
through overlays; TeX source is not saved. Export refuses a failed or obsolete
build, leaving the previous output intact. The existing Export PDF command
retains its destination dialog. The button tooltip documents the modifier.

Validation: 137 Node suites (`/tmp/wpaper-command-compile-all-tests.log`) and
55 browser checks (`/tmp/wpaper-command-compile-webview.log`). Focused checks
cover modifier gestures in both modes, the freshest draft, ordered apply/export,
actual file publication with a different active source editor, no source save,
and preservation of existing PDFs after failed/obsolete builds. Syntax and
whitespace checks pass. The four runtime assets were installed and byte-verified;
previous files are backed up in `/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-command-compile-backup-ohdve8dx`. A user-initiated window reload
activates the handler and tooltip. No user paper was compiled or modified,
and no settings, version or git history were changed.

Right-click caret follow-up: opening a mini-editor now explicitly requests a
collapsed insertion caret in standard mode. Exact glyph alignment has priority;
without it, a clicked prose word uses its PDF fraction for the source position,
and a math symbol places the caret before its source command. This applies even
when ordinary inverse clicks are configured to select words. Native glyph source
columns continue to initialize the card directly. Nearest-block margin handling,
ordinary click selections, and table grid focus are preserved.

Validation: 137 Node suites (`/tmp/wpaper-right-click-all-tests.log`), including
222 host sync checks and 98 native policy checks. Two browser checks exercise
native opening and the standard delayed caret answer, then type to verify text
is inserted at the click without replacing the word
(`/tmp/wpaper-right-click-browser.log`). Syntax and whitespace checks pass.
The runtime host file was installed and byte-verified; its previous contents are
backed up in `/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-right-click-caret-backup-2j3sf6p0`. A user-initiated window reload activates the fix.
No research paper, settings, version or repository history was changed.

Before/After now defaults to rendered LaTeX, with Rendered/Code controls.
Each side is a complete immutable document build, using the real root, document
class, packages, included headers, macros, counters and references. Before uses
the agreed review baselines; After includes current unsaved project buffers.
Preview builds have separate temporary directories and a bounded snapshot cache,
with no source save, live-viewer compile request or compile shade. Selection and
revision checks reject obsolete replies; closing the panel cancels and cleans up
preview work. Accepting another file's header change invalidates the preview.
Build failures remain explained beside the Code option.

Only differing source spans are coloured and underlined; line numbers and +/-
signs distinguish source changes while unchanged text remains neutral. Common
characters inside a replaced token remain neutral too (including Unicode
surrogate boundaries), so an equation numeral can be marked on its own. Code
shows the complete hunk instead of silently truncating at 4000 characters. The
source editor also underlines changed spans. Rendered marks use source alignment
and PDF.js text-layer character measurements with the PDF's font/run corrections.
Displays are aligned separately from prose, and generated equation tags are
excluded. A partial/unprinted correspondence points the reader to Code instead
of colouring unrelated ink. Source ranges and full snapshot maps stay in the host.

Validation: 138 Node suites (`/tmp/wpaper-rendered-review-all-tests.log`),
56 browser checks (`/tmp/wpaper-rendered-review-browser-final.log`), and 224 host
checks after the final shared-header revision guard
(`/tmp/wpaper-rendered-review-sync-final.log`). The real-TeX fixture verifies an
included macro header, both versions, cached builds and unchanged source/output
directories. Browser tests cover both Pro settings, default rendering, precise
word/numeral marks, unchanged equation numbers, numbered code, caching across
mode switches, and stale replies. Screenshots were visually checked:
`/tmp/wpaper-rendered-review.png` and `/tmp/wpaper-review-code.png`.
The package inventory passes (2196 files), including the new review renderer;
syntax and whitespace checks pass.

The eight runtime assets were installed and byte-verified, with previous files
backed up in `/var/folders/3y/7n9b49lj2jsdclx96f857hym0000gr/T/wolfbook-rendered-review-backup-tj7nanj_`. The manifest records the new module separately:
`/tmp/wpaper-rendered-review-install.json`. A user-initiated window reload
activates the feature. No research paper, settings, version or git history was
changed.

### Review preview source fallback (workspace only)

Before/After now shows numbered, highlighted source immediately while the
rendered preview loads. Each side keeps its source until all of its canvases
finish drawing, then swaps them in together. Empty crops, missing printed
content, compiler errors and PDF drawing failures retain the source with a
small status note. Explicit Code mode and stale-response guards are preserved.

Browser coverage verifies the loading fallback, successful replacement in
both Pro settings, empty/error responses, invalid PDF data, invalid PDF pages,
precise source marks and line numbers, cached errors, and stale replies.
All 57 browser checks pass (`/tmp/wpaper-review-code-fallback-browser.log`),
as do JavaScript syntax and whitespace checks. The screenshot at
`/tmp/wpaper-review-code-fallback.png` was visually checked.
This follow-up is **not deployed**, as explicitly requested by the user.

### Verified paragraph previews and added-text underlines (workspace only)

Review previews now extract complete candidate PDF pages and verify the
source paragraph against long printed prose anchors before displaying it.
The source remains visible until location and highlighting are ready. Matching
requires coverage of the source, rather than coverage of a smaller unrelated
equation. Run-in headings retain their complete body; short final prose rows
use PDF content order so they cannot be mistaken for equation scripts.
Preview bounds come from matched ink, fit the pane's usable width, and clip
row envelopes to exclude neighbouring displays without cutting radicals.

Rendered changes use thin red/green underlines. The main viewer retains quiet
fragment markers and underlines only verified added words/symbols, removing
the broad background fill. Pro uses native source origins directly; standard
mode aligns measured PDF characters. Source revision, document and displayed
generation checks reject stale results, including changes during asynchronous
native mapping. Underlines repaint accurately on zoom.

Validation: 138/138 Node suites (`/tmp/wpaper-review-ink-all-tests.log`),
59 browser checks (`/tmp/wpaper-review-ink-browser.log`), 225 host sync checks
(`/tmp/wpaper-review-ink-sync.log`), and final focused crop/underline checks
(`/tmp/wpaper-review-ink-crops.log`). The synthetic fixture uses the reported
weight/one-cut paragraphs, intentionally points SyncTeX crops at the unchanged
logarithm, and verifies complete headings/body tails and no logarithm marks.
Screenshots `/tmp/wpaper-review-paragraph-location.png` and
`/tmp/wpaper-review-word-underline-standard.png` were visually checked after
the final clipping refinement. All work remains **undeployed**; the user's
research paper and installed extension were not changed.

### Continuous review regions (workspace only)

Removed the per-fragment left-edge shadows that appeared as brackets inside
sentences. Review fills now share the focus contour's row envelopes: fragments
on one printed row become a single highlight including intervening spaces,
and ordinary leading is tiled without white gaps. Square band corners avoid
holes at fragment joins. The complete region has a gentle green fill, with
only an exterior focus contour; precise added-text underlines are retained.
Separated paragraphs and deletion seams preserve their distinct geometry.

Validation: 60 browser checks (`/tmp/wpaper-continuous-review-browser.log`),
37 panel checks, JavaScript syntax and whitespace checks pass. The new browser
case splits each row into three separated fragments and checks continuous
coverage, tiled leading, no bracket-like borders/shadows, zoom, both Pro
settings, a genuine paragraph gap, and deletion seams. The screenshot at
`/tmp/wpaper-review-continuous-region.png` was visually checked. This change
remains **undeployed** as requested earlier in the session.

Repeat hands-on typing, deletion, scrolling and Pro switching on the user's
long paper after reloading the extension. This audit does not establish
cross-engine layout parity, full-corpus performance, native execution on
Windows or Linux, or every engine-side release gate.

Five runtime files were installed locally after the final checks, with a
backup of their previous contents. They require a VS Code window reload and
reopening WPaper to replace the active
extension host and webview. No release, version bump, commit or push is part of
this audit.

### Background correction previews (workspace only)

Correction previews previously waited 600 ms after selection, compiled the
complete before/after documents sequentially with latexmk, and cancelled
unfinished work when the selection changed. This is separate from WLaTeX's
incremental typing lane. Each selection also reopened its PDFs and measured
their text again.

The review now prepares every pending correction after an input pause, with
one shared build per document version. The two versions can build concurrently;
selection changes reuse their in-flight work and completed fragments. Identical
settled output is reused without another compile, including a Pro PDF when its
complete, current native geometry can be copied safely. Windowed, displaced or
live native geometry is excluded. Source/review changes and closing the viewer
cancel obsolete work. Failing versions are shared too, avoiding one failed build
per correction.

The webview warms the affected pages' fonts and measured text before selection
and keeps a bounded PDF cache. It requests the selected preview without the old
600 ms delay; code remains readable until the verified rendering is ready.
Added or replaced ink in the viewer receives a stronger green tint and a fine
underline. Adjacent changed glyphs share a continuous underline; unchanged
words and mathematical scripts remain distinct. Existing continuous review
regions and red deletion seams remain in place.

Validation covers real isolated LaTeX builds, concurrent preloading and
selection, conventional/Pro PDF reuse and artifact ownership, source
cancellation, failed-build sharing, input-pause scheduling, browser preloading
before selection, font/text reuse, paragraph location, code fallback and viewer
marking through zoom in both modes. The first uncached historical document
still needs a complete build; these fixture checks do not establish latency
for the user's long paper. This change is **not deployed**.

### Viewer-only tab retention and one-shot Fit (workspace only)

Viewer-only previously closed clean source tabs. Switching the shared WPaper
panel to another paper then removed the first paper's remaining tab from the
reader's navigation. Viewer-only now retains source tabs behind WPaper, pins a
source preview so VS Code cannot replace it, and recreates a missing source tab
when restoring an older viewer-only session. Only empty groups left by moving
the viewer are closed. Each paper keeps its remembered layout and reading
position.

Explicitly entering viewer-only/max mode applies Fit once after the group
layout settles. A request before the PDF opens is deferred until it is ready.
This does not enable responsive Fit; manual zoom and later resize remain under
the reader's control. Repeated layout messages and restored layouts preserve
the saved zoom. Browser checks cover both Pro and standard mode, deferred Fit,
manual zoom, resize, restoration and double-click source navigation. Workbench
tests cover two-paper switches, source previews and legacy tab restoration.
These changes are **not deployed**.

## Repeat the checks

From the extension repository:

```sh
node out/extension/kernel/tests/run-all.js
node out/extension/kernel/tests/webview/harness.cjs
node out/extension/tex/verifyNativeInteractive.cjs /absolute/WLaTeX/directory
node out/extension/tex/verifyNativeRecovery.cjs /absolute/WLaTeX/directory
node out/extension/tex/launchNativeVSCodeCheck.cjs /absolute/WLaTeX/directory /absolute/code native crlf
node out/extension/tex/launchNativeVSCodeCheck.cjs /absolute/WLaTeX/directory /absolute/code default crlf
node out/extension/tex/launchNativeVSCodeCheck.cjs /absolute/WLaTeX/directory /absolute/code missing lf
vsce ls > /tmp/wpaper-package-files.txt
node out/extension/tex/verifyNativePackage.cjs /tmp/wpaper-package-files.txt
```
