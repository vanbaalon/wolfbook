# WPaper / WLaTeX release gates

Audit date: 2026-09-21. This is a consumer-side audit, not a completion claim for
the engine project. Requirements come from WLaTeX's `docs/next-steps-plan.md`
§4 and §6, `docs/source-provenance-plan.md` §7, the public SDK README, and the
user's explicit separate-installation requirement. That user requirement
supersedes the older plan's suggestion to include the engine in the VSIX.

| Requirement | Current evidence | Remaining work |
| --- | --- | --- |
| WPaper works without WLaTeX | Default and unavailable-runtime modes pass in an isolated real VS Code host; runtime/policy unit tests pass | Repeat native release acceptance on the other target hosts |
| WLaTeX installs separately | Runtime resolution uses configured external directories; `vsce ls` inventory passes `verifyNativePackage.cjs` | Produce and test separate native installations on all four targets |
| Ship the integration assets | Packaging inventory contains all eight required host/client files | Run the inventory check for each release; this does not validate every other extension dependency |
| Four targets | Resolver supports darwin-arm64, darwin-x64, win32-x64, linux-x64; consumer CI matrix exists | Actual native execution is demonstrated only on darwin-arm64; no remote CI success claimed |
| Engine source mapping | Real native forward/inverse, edited source, ranges, cards, pick and widen/shrink checks pass | Full corpus and physical gesture/visual acceptance remain open |
| Unsaved source fidelity | Real-host CRLF/multiline edits, conflicts, worker reconstruction preserve dirty buffers and saved files | `verifyNativeFiles.cjs` reports INCOMPLETE for an overlay whose file is absent on disk |
| Crash isolation and cancellation | Real native timeout/reconstruction and SIGKILL recovery pass; source query failures invalidate cached actions | Windows process-tree/crash behavior still needs execution evidence |
| Stable generations and publication | Native/conventional handoff, page/view admission, unique display generations and old-PDF retention pass | Native settled/page event contract is not exposed by the current SDK |
| Changed-page delivery | Unchanged canvases/text are reused; PDF.js loads native byte ranges through pinned handles | Still one full PDF artifact per build, not changed-page PDF or TXDL artifacts |
| Honest preview status | Native previews remain probably-current, with exact provenance separately represented | No complete parity/settlement receipt is admitted to promote them to authoritative freshness |
| P6 per-page glyph counts (Amendment 4) | Existing LuaLaTeX control passes; native report fails on pages 7, 12, 13 and 14, consistent with visible reflow | Meet the amended count gate; visual inspection and stock XeLaTeX agreement do not waive it |
| Long-lived incremental engine and viewport priority | Source worker is long-lived, but compilation calls the SDK full-build interface | Checkpoint/restore/convergence execution and viewport-prioritized output remain engine work |
| Reference-paper performance | The 15-page real adapter check samples all pages; earlier full builds took about 66 seconds | Does not meet interactive latency; new transport microchecks do not establish end-to-end latency |
| Reference fidelity | [All 15 frozen reference pages visually reviewed](wpaper-reference-visual-review.md); figures present, with layout differences and unresolved references in both PDFs | Resolve baseline references; agree layout tolerance; verify glyph/ink parity and regenerated current-engine output |
| Cache lifecycle | PDF handles release on replacement, conventional handoff and disposal; page-text cache prunes removed/changed pages; idle sweeps reclaim unreported build output | Live-generation leases remain GC-dependent; hard quotas, prompt eviction and crashed-host session cleanup remain open |
| Portable checkpoints and correctness fuzzing | Outside the consumer implementation | Engine plan's complete accounting, portable image, semantic convergence, corpus/fuzzer and timing gates must be audited and completed by their owner |
| Visible interaction | Real extension-host/PDF.js checks pass for tested service paths | Desktop automation lists VS Code but app-state reads time out; no physical-click or screenshot acceptance obtained |

## Packaging check

From the extension checkout, without deploying or publishing:

```sh
vsce ls > /tmp/wpaper-vsix-file-list.txt
node out/extension/tex/verifyNativePackage.cjs /tmp/wpaper-vsix-file-list.txt
```

The verifier checks required integration assets and rejects known WLaTeX runtime
locations, executable names and generated `.wlatex` caches. It is a packaging
inventory guard, not a binary-content scanner or a native-runtime installer.
Its dependency-free tests are included in the four-platform consumer workflow.

Detailed commands, measured scopes and local evidence logs are recorded in
[the integration log](wpaper-native-map.md). The engine repository remains at
a0710b8 during this audit. Its `docs/work-split.md` assigns engine/SDK changes to
Track A and WPaper integration to Track B; that ownership has not been changed.
