# WPaper tool source-safety audit — 7 October 2026

The read tools shown in the report (`paper_getOutline`, `paper_getObject`, and
`paper_search`) do not write LaTeX source. Confirmed defects in the shared
projection and edit pipeline could nevertheless give an agent incomplete source,
apply an unsafe change, or misreport verification. The findings below were fixed.

## Complete tool inventory

| Tool or action | Source effects | Audit coverage |
| --- | --- | --- |
| `paper_getOutline` | None | Summary/tree/object modes, project discovery, exact file routing |
| `paper_getObject` | None; optional editor reveal | Complete source hashes, explicit excerpt truncation, literal source |
| `paper_getSection` | None | Section boundaries, document terminator, truncated response metadata |
| `paper_findReferences` | None | Labels, multi-target/starred references, aliases, unsaved include graph |
| `paper_search` | None | Batched/literal/regex queries; regex execution isolated and bounded |
| `paper_mathematicaBlocks` | None; no kernel evaluation | Managed-block reads and unchanged buffer/disk checks |
| `paper_previewEdit` | Stores an in-memory proposal only | All nine operations, stale hashes, overlaps, label guards, unchanged source |
| `paper_applyEdit` | One editor edit, optional verified save; history is read-only | Apply/undo/history, serialization, verification, guarded rollback and receipts |
| `wolfbook_latex(action:save)` | Writes the requested complete file | Literal content, corrupt-control refusal, dirty-buffer refusal |
| `wolfbook_latex(action:compile)` | Builds artifacts; no source transformation | Failed builds cannot claim success from an existing PDF |
| `wolfbook_latex(action:errors)` | None | Reads compiler log without changing source |
| `wolfbook_latex(action:build)` | Save followed by compile/log read | Failed save stops the build; shares the action checks above |

The MCP dispatcher passes paper source strings through without decoding or
normalizing their backslashes. Transaction routing uses the owning window and
retains the document/hash checks in that window. LaTeX verification uses the
compiler's private overlay rather than saving a dirty buffer to compile it.

## Confirmed defects and fixes

| Finding | Result after the fix |
| --- | --- |
| An absolute or relative path could select another open file with the same basename. | Explicit paths are resolved exactly. Ambiguous workspace matches are refused. |
| Scanner objects were silently capped at 4,000 characters while edit ranges covered the full object. | Objects and hashes cover complete source. Long-object guarded edits round-trip correctly. |
| A truncated object response embedded `… (N more chars)` inside its source. | Returned `text` is an exact prefix; `textTruncated`, `sourceChars`, and `returnedChars` carry presentation metadata separately. |
| A section response contains body text while its editable object identity covers only the heading. | The response and tool contract explicitly distinguish `heading-and-body` text from the `heading-only` identity. Body edits target contained objects. |
| `verify:true` was advertised but neither compiled nor enabled rollback. | Boolean verification is supported in implementation and schemas. `true` performs parse, reference, and LaTeX checks with rollback. |
| Verification always chose pdfLaTeX by default. | The paper's engine declaration/font requirements and configured engine select the compiler; an explicit verification engine takes precedence. |
| Structural/reference verification could fail while the edit remained applied by default. | Cheap parse/reference verification rolls failures back by default; compilation remains explicit through `verify:true` or `verify.latex:true`. |
| Compiler exceptions bypassed rollback. | Exceptions become failed verification and follow the guarded rollback path. |
| Rollback could replace user edits made while compilation ran. | Rollback requires the buffer still to match the exact applied snapshot. Newer edits are preserved and the receipt reports a conflict. |
| Concurrent apply calls could interleave verification and rollback. | Applies serialize per file and re-read the buffer before checking transaction hashes. |
| Agent-writing attribution stayed active throughout compilation. | Attribution brackets only each actual editor mutation; user typing during verification remains user typing. Rejected edits always close attribution. |
| Failed verification could still save; rejected saves could be reported as successful. | Saving requires successful verification, unchanged buffer/disk snapshots, and an actual successful editor save. |
| A last-section append could land after `\end{document}`. | Section ranges end before the active document terminator. Semantic insert/move operations preserve text boundaries. |
| Inline verbatim and escaped command tails could be parsed as real labels or document terminators. | Literal `\verb`/`\Verb` text and escaped control-sequence tails are inert. |
| Renames missed starred/page/cleveref references and multi-target reference aliases. | Recognized declarations/references are updated together, preserving comments and verbatim text. Unsafe label keys are refused. |
| Deleting/replacing a multi-row equation protected only one of its labels. | Every removed declaration is checked for remaining local and project references. |
| Project reference checks discovered includes from disk rather than dirty buffers. | Project traversal uses current open-buffer overlays. Cross-file renames needing other-file edits remain explicitly refused. |
| Warning line shifts could look like newly introduced parse errors. | Warning deltas compare messages rather than locations and count repeated diagnostics. Reference deltas count uses by target/command. |
| An already duplicated label could acquire additional declarations without verification detecting the increase. | Verification compares declaration counts, refusing increased duplication while permitting repairs. |
| Corrupt JSON control bytes could be written as LaTeX. | Edit payloads and legacy save refuse corrupt controls before writing; ordinary literal TeX is preserved. |
| A regex search could monopolize the extension host. | Regex execution uses a disposable worker with a one-second budget and bounded pattern/worker memory. |
| Legacy compilation reported success whenever an old PDF existed. | Success requires a successful compiler exit and output PDF; a stale PDF is identified explicitly. |

## Validation and limits

`out/extension/kernel/tests/tex-tools-audit.test.js` exercises all eight paper
tools, all four legacy LaTeX actions, all nine semantic edit operations, the
failure paths above, CRLF/Unicode/JSON fidelity, stale transactions, and guarded
undo. Each semantic operation was compiled with real pdfLaTeX on an isolated
fixture. Before/after regression evidence, source/runtime backups, and detailed
logs are in `/Users/k0959535/WPaper Experiments/2026-10-07-tools-audit/`.

The full headless test runner passed 154/154 suites. All 23 audit regressions also
passed against the installed runtime. Eight focused regressions failed against
the original implementation and passed with the fixes. No original paper was
edited, and no live kernel or VS Code window was restarted. Runtime fixes and
tool contracts were selectively installed; they activate on the next VS Code
window reload.

Parsing/reference checks are not a proof that arbitrary TeX compiles. Final
agent edits should use `verify:true` or `{latex:true}` to run the actual compiler.
`verify:false` deliberately permits an unverified draft. A guarded undo restores
the exact earlier draft by default, including its pre-existing warnings; explicit
verification can also be requested for undo. Project references are a static
include/macro projection, not general TeX execution, and cross-file transactions
are not supported.
