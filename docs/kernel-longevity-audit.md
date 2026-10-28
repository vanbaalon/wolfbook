# Kernel longevity audit — 2026-10-04

Workspace changes only. No deployment, window reload, kernel restart, abort or
evaluation into an existing session was performed. Live inspection used the
Wolfbook status and crash-log tools; two agent-owned kernels were busy.

## Evidence

Audited VS Code sessions dated September 25–October 4 under
`~/Library/Application Support/Code/logs/`. Read renderer, main, extension-host
and Wolfram Notebook output logs. Verbose kernel diagnostics were disabled in
the inspected windows. There were no accessible Wolfram crash reports in the
user/system DiagnosticReports directories.

- `20260930T171820/main.log`, October 4 at **01:47:17.724**: extension host PID
  **9887** exited with code **6**, recorded as a utility-process crash. The
  corresponding `window3/renderer.log` records unexpected termination and an
  automatic extension-host restart. Multiple extensions were loaded; no native
  stack identifies the responsible component.
- `20260928T111648/main.log`, September 28 at **23:10:54.609**: another host exit
  with code **6**. The matching renderer also records unexpected termination.
- The latest session contains **45** extension-host “unresponsive” events and
  numerous code-0 host exits. The older September 29 session contains **194**
  unresponsive events. These indicate host interruptions; they do not identify
  which extension blocked the event loop or establish that every exit was a
  crash. Code-0 exits are consistent with normal closes/reloads.
- The process snapshot showed Wolfram kernels alive for up to approximately
  **3 days 20 hours**, and **no `caffeinate` companion processes**. Some kernel
  processes used several GB of RAM; this alone does not establish an OOM event.
- One older output log records a **30-second VsCodeRender timeout**. This is an
  output-rendering deadline, not evidence of a kernel disconnection.

No logged WSTP-dead/keepalive/worker-disconnected event could be tied to a
specific reported evaluation. Absence of a diagnostic report is not evidence
that no crash occurred.

## Verified defects and changes

| Defect | Consequence | Change |
|---|---|---|
| Startup reads `$ProcessID` as a bare WExpr, although `evaluate()` returns an EvalResult containing `.result`. | Normal PID tracking and the macOS sleep companion are skipped. | Accept both result shapes; validate a positive integer PID before tracking/spawning. |
| Ready notification/callback fires before PID/version metadata finishes. | Ready listeners can submit work during startup metadata collection. | Notify listeners after metadata completes and the session reaches resolved state. |
| Primary routing expires a worker after 60 seconds without a heartbeat, even if its local owner PID is alive. | A host stall or sleep can make agents lose access to a kernel which is still running. | Use OS process liveness for known local owners; retain TTL fallback for registrations with no usable owner PID. |
| One health request can count twice when timeout destroys it and emits error. | Three-failure election threshold can be reached prematurely. | Settle each health poll once; handle aborted/error responses too. |
| Native Dynamic timer detaches a thread capturing the session and WSTP link. | A sleeping thread can wake on freed session memory or a closed link. | Make its cross-thread open flag atomic; keep the thread joinable; stop and join before clearing queues, releasing callbacks or closing WSTP. |
| Watcher treats `isOpen` as process liveness. Native `isOpen` is only the session's open flag; dead links have a separate flag. | A dead link/process can remain apparently connected. | Observe `isLinkDead` and tracked OS PID without submitting work; show faulted status for a closed/dead link. |
| Recovery closes the old session before asking whether to restart; a delayed prompt can act on a replacement session. | Cancellation cannot preserve the original session, and an old prompt can close a newer one. | Ask before closing; verify session identity/disposal after the response; use controller shutdown to invalidate operations/leases only on confirmed restart. |
| Useful kernel logs require verbose diagnostics and are truncated during startup. | Historical evidence is missing after long runs or restarts. | Add a small persistent lifecycle journal, surfaced by `wolfbook_kernelCrashLog` even when verbose diagnostics are disabled. |

`caffeinate -i -w <pid>` prevents **idle system sleep** while that PID lives. It
does not guarantee survival across explicit sleep, host crashes, shutdown,
license failures, kernel crashes or memory exhaustion. Earlier comments
claiming that idle pipes are reclaimed, or that this guard disables App Nap,
were removed; the audit did not establish those claims.

The liveness watcher sends **no heartbeat evaluations** and gives a running
calculation **no deadline**. Remote evaluation calls likewise have no implicit
HTTP evaluation deadline. Explicit agent-requested computation time limits and
bounded control/rendering calls retain their existing semantics.

## Persistent evidence

Location: `<extension globalStorage>/logs/lifecycle/host-<lifetime>.jsonl`.
Events include launch, tracked PID, sleep-companion status, shutdown reason,
connection failure, recovery choice, routing eviction and primary election.
Rows contain timestamps, host/kernel IDs, PIDs, epochs and reason/error codes;
no Wolfram expressions, notebook contents or credentials.

Writes are asynchronous, with a bounded queue. Each host file rotates at
256 KB, retaining one previous file; startup prunes to the newest 20 existing
files. The reader includes recent previous hosts so crash/reload evidence is
retained. Logging failures cannot prevent evaluation or launch.

## Validation

- New longevity regression: actual nested/legacy PID results; invalid PIDs;
  macOS/non-macOS companion behavior; **seven simulated days** of busy watcher
  ticks without evaluation/abort/close; cancelled and stale recovery prompts;
  live routing after seven stale days; dead/unknown-owner pruning; single-count
  HTTP health failures; faulted link status; diagnostic-off journal filtering
  and file rotation. No real Wolfram process is launched by this test.
- Updated routing regression preserves live stale workers while removing dead
  or ownerless expired registrations.
- Native timer regression compiles the **actual timer method and cleanup
  prefix** against fake WSTP and runs **100 idle/busy session teardown cycles
  under AddressSanitizer with optimization enabled**. No Wolfram kernel is involved.
- The native session and addon entry translation units pass `clang++ -fsyntax-only`
  with Node/N-API and installed WSTP headers. The distributed addon binary has
  not been rebuilt or replaced.
- **139/139 extension test suites passed** after the final changes. The
  strengthened watcher regression also passed separately. Results:
  `/tmp/wolfbook-longevity-tests.log`. Changed JavaScript passed `node --check`;
  both repositories passed `git diff --check`.

These checks cover the repaired lifecycle paths, not an actual multi-day soak
test or recovery from every native crash.

## Remaining architectural limits / investigation

1. **Host death/reload loses the link.** Local native sessions belong to the VS
   Code extension-host process; normal shutdown closes/kills their kernels, and
   the orphan reaper cleans up kernels whose host died. Existing owner-aware
   reaping protects kernels belonging to other live hosts. Preserving state
   across a host crash/reload requires moving WSTP ownership into a separate
   durable broker process; adding a ping cannot provide that guarantee.
2. **Crash attribution is still open.** The timer lifetime bug is a concrete
   native crash risk, but there is no crash stack proving it caused PID 9887's
   failure. Other extensions share that host. Future lifecycle evidence and a
   native crash stack should distinguish kernel, host and transport failures.
3. **Active native close needs additional stress testing.** Native cleanup has
   bounded waits for an active reader, then closes the link; AsyncWorker
   completion callbacks also capture the session. This audit repairs detached
   timer ownership, but does not claim exhaustive verification of concurrent
   native reader/GC teardown. A separate fake-WSTP integration harness or
   isolated broker would support testing that path without real research work.
4. **Historical channel counts are not a proven leak.** The log trees contain
   hundreds of cumulative Wolfram Notebook output-channel files. Controller
   resource disposal is already implemented and covered by existing churn/
   disposal tests; historical file counts alone cannot establish an active
   output-channel leak.

No settings or unrelated extensions were changed. Future deployment should be
scheduled when current agent computations have finished; this audit leaves the
installed extension and native addon untouched.


## Follow-up — 2026-10-14

The original per-kernel sleep companion prevented idle system sleep for every
open kernel, including idle processes. This has been replaced by one guard per
extension host, acquired around native evaluation calls and released when all
calls finish, fail or their session closes. Its `-w` target is the extension-host
PID; a host exit cannot leave a persistent sleep assertion. Kernel PID tracking,
passive liveness checks and explicit restart rules remain in place. Idle kernels
retain their definitions; this change does not introduce automatic shutdown.

The October 14 unresponsive-host CPU profile also identifies repeated TeX review
revision normalization/hashing. Per-session text digests now cache the baseline
and current text, so repeated glyph/preload checks hash only compact project
identities. A 100-check benchmark on the current SoV paper changed from 762 ms to
0.28 ms with a warm cache (cold first check: 5.1 ms). This measures revision-key
work, not end-to-end UI latency. Text, baseline, file-set and source revision
changes still invalidate stale rendered corrections.

Notebook controllers now share a leased `wolfram-syntax` diagnostic collection;
disposing a remote proxy does not dispose another controller's diagnostics.
The regressions use fake sessions/processes and real controller construction;
no existing user kernels are restarted or evaluated by them.

## October 28: live development-window acceptance

Tested on macOS arm64, Wolfram 15.0.1, in a separate VS Code Extension
Development Host using disposable notebooks. The two existing research/development
windows and their seven Wolfram processes kept their original PIDs. Notebook
creation/editing and agent evaluation used Wolfbook MCP; keyboard checks used
physical UI shortcuts. A loopback test driver observed VS Code notebook state.

| Scenario | Observed result |
| --- | --- |
| Empty window activation, notebook creation/reveal without evaluation | Zero Wolfram processes |
| Reload/reopen with two saved kernel slots and notebook assignments | Both slots restored offline; no process launched |
| Cold Shift+Enter in edit mode; repeat in notebook command mode | Correct bound kernel launched and committed output |
| Native notebook kernel picker and status-bar binding menu | Immediate Shift+Enter evaluated in the newly selected process |
| Agent's first evaluation in a dormant isolated slot | Only that WSTP slot launched; unused default stayed offline |
| Concurrent cold requests to two slots | One process per requested slot; one deferred LSP per window |
| Variables and process identity across switches | Definitions isolated between K2 and K3 |
| Busy notebook rebind | Refused; other kernel remained usable |
| Command-period during Pause | Committed `$Aborted`; subsequent evaluation worked |
| Idle and busy MCP restart | Only target PID changed; other kernel's PID and sentinel value survived |
| Command-Shift-R, then Shift+Enter | Restarted selected kernel and evaluated successfully |
| Foreign working-directory declaration | Inventory showed exact roots and `recommended:false`; explicit cross-folder use succeeded |
| Idle window close | All owned WSTP/LSP processes and extension host exited |
| Close with both kernels running `Pause[120]` | Both WSTP kernels, LSP and host exited; both shutdown completions logged |
| Close immediately after cold Shift+Enter | Launch cancelled during preflight; no late kernel/host remained |

Live testing reproduced and repaired three additional failures:

1. A status-bar picker restored focus to its button. Returning focus to the
   same still-active notebook makes the next Shift+Enter work without a click.
2. Deactivation called only the default controller and did not await it.
   It now awaits all local controllers and LSP, excludes remote owners, and
   prevents a pending launch from starting after window shutdown.
3. A native SharedMemory reader could remain inside `WSNextPacket` after its
   kernel was terminated, leaving the extension host stuck in thread-pool exit.
   The addon now installs per-session cancellation through a
   [WSTP yield function](https://reference.wolfram.com/language/ref/c/WSSetYieldFunction.html).
   The callback reads the atomic close flag; link memory is released only after
   readers and callbacks finish. In the final busy-close run, shutdown requests
   were logged at 18:09:29.500/503 UTC and completions at .545/.569; host 80386
   and kernels 80442, 80499 and 80505 were all absent in the subsequent process check.

Agent routing also no longer injects a stale notebook into an explicit kernel
request after that notebook was rebound. A selected dormant controller's binding
receipt no longer incorrectly warns that controller selection is pending.

Validation: 68 targeted Node test cases passed, followed by 15 shutdown/restart
cases including one new preflight-cancellation regression (69 distinct cases).
Native cleanup isolation and 100 timer teardowns passed under AddressSanitizer.
The arm64 addon was rebuilt and used in the live tests. Windows/Linux binaries
and platform-specific UI behavior were not tested or released here.

Raw test evidence and the pre-fix addon backup are in
`$TMPDIR/wolfbook-live-w2m9vtz0/`; the reproducible observer is
`out/extension/kernel/tests/live/vscode-driver.cjs`. No test window remains open.

## October 28: MCP Print visibility

A separate development host reproduced lossy notebook Print text: boxed numeric
and symbolic arguments became `[formula]`, and calls lost their line separators.
The direct-expression decoder also split arguments before decoding WSTP's octal
file separator, leaving raw boxes in multi-argument Print output.

Notebook Print/WBPrint now use the shared decoder, retain whitespace and packet
boundaries, and convert box arguments through BTL. If conversion is unavailable,
the box text is retained instead of discarding its value. Existing saved outputs
are unchanged; re-evaluation creates the improved text representation.

Live MCP checks on a disposable notebook verified runCell, getCellOutput,
getNotebookContext and evaluateExpression: `value = 42`, `fraction = \\frac{1}{3}`,
`symbolic = x^2+1`, WBPrint progress, and all 20 separately delivered loop prints.
Focused regressions cover octal separators, Unicode, missing/failed conversion,
argument whitespace and committed-output reads. The test workspace is
`$TMPDIR/wolfbook-live-print-ulh0dh79/`; no research notebook was evaluated.


## October 28: GitHub issue review and language-server follow-up

Reviewed all five currently open extension issues; the WSTP and BTL repositories
had no open issues. No issues were closed and no comments were posted.

| Issue | Assessment and local action |
| --- | --- |
| [#21 Windows latexmk](https://github.com/vanbaalon/wolfbook/issues/21) | The reported `detached:true` path is already corrected to `detached:!_WIN`. Existing compile regressions pass. Keep open pending actual Windows acceptance. |
| [#23 notebook kernel enablement](https://github.com/vanbaalon/wolfbook/issues/23) | Real settings-precedence defect: registered defaults were ignored in favour of call-site fallbacks. Fixed precedence, including explicit language overrides. Explicit Launch Kernel now works even when automatic startup is disabled and LSP is absent. Startup itself remains lazy. |
| [#24 Mathematica desktop interference](https://github.com/vanbaalon/wolfbook/issues/24) | Confirmed hidden `MathematicaServer` processes share the desktop bundle identity. Removed SVG and graphics-options warm-ups: plain evaluation no longer starts a service front end. Added **Wolfram: Open New Desktop Instance (macOS)** using `open -n -a` for the configured kernel's app. This is a mitigation, not a complete repair of Wolfram/LaunchServices routing: real graphics output can still start the service. |
| [#25 MCP response envelopes](https://github.com/vanbaalon/wolfbook/issues/25) | Nested JSON payload preservation is present; the unhelpful `message:"{"` fallback remained. Fixed the parsed-JSON fallback and tested complete nested data in both content and structuredContent. The existing primary server retains its old code until a normal reload. |
| [#26 output rendering](https://github.com/vanbaalon/wolfbook/issues/26) | Reproduced and fixed function/argument splitting, uniform numeric Column row spacing, and ShowContents->False losing layout. Invisible contents now produce a phantom. Raw LaTeX embedded in arbitrary Wolfram box strings is not established supported syntax; no permissive raw-LaTeX injection was added. Nonuniform row-spacing specifications remain outside this patch. |

The recurring language-server notification came from an unconditional 15-second
check, not from the actual initialize promise. Readiness/failure now follows that
promise; a slow response gets an honest log entry and one cancellable timer. Stop
during initialization waits for that attempt and suppresses late readiness work.
Notebook-cell URIs also caused actual `FileNameSplit::fstr` messages in Wolfram's
LSP. They now map to distinct virtual file URIs with reverse mapping; no virtual
files are written to disk.

Final live host 87433 restored two dormant slots with zero Wolfram children.
Explicit agent evaluation started only K3 (87567); the deferred LSP (87757)
initialized in 1.2 seconds, and notebook hover returned a documentation link.
There was no service front end after plain arithmetic. Subsequent graphics
output succeeded and started service 88178 as expected. Live non-graphics output
contained separate `\\[0em]` and `\\[3em]` row gaps and a phantom for the hidden text.
Closing the test window removed its host, WSTP kernel, LSP and service process;
all original research-window process identities remained present.

The desktop command launched separate `WolframNB` PID 87829 and its own kernel
while the original VS Code kernels remained alive. Native UI automation could
not attach to the app sharing the service bundle identity and later timed out
on VS Code too. Consequently, opening a standalone notebook through Finder is
**not certified** by this run. The separately launched desktop was left running;
no user notebook or original service process was forcibly terminated.

Validation: 19 focused extension test cases passed (settings, launch, LSP,
transport, shutdown and compile paths), plus 51 existing native renderer cases
and three new issue-26 regression cases with KaTeX parsing and paginated spacing.
Live rendering and graphics execution succeeded; visual desktop acceptance is
limited as above. Native rebuild is macOS arm64 only.

Eleven verified runtime files were copied atomically to the installed extension,
with SHA-256 verification and backups under
`$TMPDIR/wolfbook-live-w2m9vtz0/issue-installed-backup/manifest.json`.
No research window was reloaded. Installed fixes take effect when its extension
host next starts. Source changes remain uncommitted; no release was published.
