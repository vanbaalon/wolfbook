# WPaper comments

The WPaper toolbar's **Comments** control shows a slim annotation rail beside
the printed page. Existing comments appear as filled speech bubbles; moving the
pointer over an uncommented line reveals a quiet `+` bubble. Only the selected
conversation expands, in a compact card aligned with its paragraph. The card
floats over the margin instead of turning the paper into a narrow column.

Drag the card's left edge to resize it; double-click the edge to restore the
320 px default. WPaper remembers the annotation visibility and card width per
paper. **Fit** reserves the small marker rail but not the floating card, so the
page stays the primary surface.

## Adding and using comments

1. Turn on **Comments**.
2. Move over a paragraph, equation, figure, or other semantic block and click
   its `+` bubble. The `+` button in an open conversation offers a keyboard- and
   touch-friendly alternative: choose it, then click the target on the page.
3. Write the comment and choose **Post** (or press Cmd/Ctrl+Enter).

Multiple comments on one source cell form one bubble with a count. Selecting a
bubble softly highlights its current printed anchor. The source icon reveals
the current source line. The card describes the anchor as a paragraph,
equation, figure, and so on, with its current human-readable line range. A
compact quotation is shown once above the conversation; mathematical source is
rendered with the bundled offline KaTeX rather than exposed as raw TeX. Stable
cell IDs remain in the shared data, but are not shown in the everyday card or
copied comment report. Editing saves after a short pause. The
conversation's options menu can copy all comments as prompt-ready Markdown
(with current file/line locations and excerpts) or delete all after confirmation.
Copied reports begin with a short instruction for the agent: use verified,
guarded WPaper edits, respect the mini-editor, and start listening for further
comments using its native wake-up plan until you say stop. Each comment includes
its full source path. Paste the report directly into Codex or Claude Code; the
same instructions handle **Copy and delete all** without recreating removed
comments. The instruction is added only to the copy, leaving stored comments
and their quoted passages intact.

Comments added with **Accept + comment…** during revision review enter this same
annotation stream and retain their revision provenance.

## Working with an agent through comments

Ask the model: **“Start listening for comments on `/absolute/path/paper.tex`,
handle them with verified WPaper edits, and keep listening until I say stop.”**
The `paper_listenComments` tool works with MCP agents and VS Code language-model
tools. It listens to one source file's comment sidecar; an included source file
can have its own listener.

The model starts a listener, repeatedly waits for comments, and receives the
comment text, current source lines, and a guarded editable
source span with its SHA-256 and buffer version. Exact text anchors remain
usable when the semantic object detaches; ambiguous or missing quotes remain
explicit conflicts. Default deliveries are compact: the quotation appears once
in the guarded span; object source, surrounding context, labels, authors and
timestamps are available on request. Each span's `context_handle` fetches
additional source in chunks. Check `truncated` or `text_truncated` before using
an incomplete quotation or request. `projection:"full"` restores the detailed
delivery. `include_existing:true` also delivers already
posted comments; otherwise only new or subsequently updated comments arrive.

For a small correction the model can apply directly, without a preview or
manual object search:

```json
{
  "file": "/absolute/path/paper.tex",
  "delivery_id": "paper_delivery_...",
  "patches": [{
    "comment_id": "comment_...",
    "expected_old_text": "exact passage inside the delivered span",
    "replacement": "corrected passage",
    "expected_span_hash": "SHA-256 from anchor.editable_span.source_hash"
  }],
  "verify": true,
  "save": true,
  "acknowledge": true
}
```

`paper_applyEdit` checks the live buffer and applies only uniquely matched text
inside the delivered quote. Unrelated typing can move the quote without
invalidating the guard. Actual changed ranges determine mini-editor conflicts.
The combined receipt reports separate edit and acknowledgment outcomes; it
consumes only patched, unchanged comments after successful LaTeX verification.
Comments changed or deleted during verification stay changed or deleted.
Without `delivery_id`, a copied report can use `patches` with the SHA-256 of
`expected_old_text`; the passage must be unique in the current source, and no
comment is recreated. Patches default to LaTeX verification.

A separate preview remains available for larger semantic edits. Apply with
`verify:true`, then acknowledge using its successful `operation_id`. New comments and comments edited
while the model works remain intact. Failed verification, stale source,
ambiguous/missing text anchors, cancellation, or an agent disconnect never silently
discard instructions. A delivery can be released for retry. Starting again with
`include_existing:true` recovers pending comments after a window/agent restart.

MCP apply responses wait up to 10 seconds by default, accommodating common
verification builds without a second status call. `wait_seconds` changes this
response wait (0–45); longer builds retain their asynchronous operation handles
and client timeout caps. This wait changes no compiler or source lock.

MCP preview/apply receipts retain transaction and operation IDs, undo token,
save status, verification outcome and bounded warning/reference deltas. Their
`details_handle` retrieves the original result through `wolfbook_getResult`;
use `format:"structured"` and a JSON `path` to retrieve a typed node. A partial
node is labeled `json-chunk` and has `next_offset`. Modern MCP clients receive
one typed payload plus a short text summary; older clients retain JSON text.
`projection:"full"` on preview/apply explicitly requests the original details.

Read related objects in one call with `paper_getObject(selectors:[...])`
(1–10 keys). Its batch `max_chars` caps total returned source. Fetch multiple
comment contexts with `action:"context", comment_ids:[...]`; `limit` is their
total quoted-source budget. Both read the current buffer without focusing the
editor or compiling.

The reader's open mini-editor takes priority. The model defers changes that
overlap it and can work on other fragments. Disjoint model edits and rollbacks
use separate ranges in one undoable editor operation, retaining intervening
mini-editor text and its caret. Verification has its own compile directory and
does not take the viewer's compile gate or replace its PDF. Listening itself
does not compile, focus an editor, reload the viewer, or reserve a kernel.
Unrelated reader typing can continue during verification and acknowledgement;
completion requires the verified model edit still to be identifiable intact.

The start receipt includes a file-bound `wakeup` plan. MCP client names select
the plan automatically; set `agent:"claude-code"` or `agent:"codex"` when the
host does not supply its identity. The model must perform the native setup:
receiving a plan does not itself install a scheduler.

- **Claude Code:** when `CronCreate` is available, the agent installs the
  returned one-minute recurring prompt and retains its job ID. Each wake-up
  calls `next(wait_seconds:0)`, processes a delivery, then ends its check.
  The session must remain running; tasks run when idle and may have jitter.
  Stopping also calls `CronDelete` for only this listener's job. A wake-up for
  an expired/stopped listener cancels the job rather than resurrecting it.
  See [Claude Code scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks).
- **Codex:** the agent uses native wait/sleep tools or bounded `next` waits in
  an active listening task. A user-authorized active Goal can continue between
  turns. Creating a Goal requires an explicit user request for a Goal; a normal
  listen request does not create one automatically. See
  [Codex Goals](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).
- **Other clients or unavailable native scheduling:** keep an active `next`
  loop. A passive MCP listener alone cannot start a finished conversation.

For Codex continuation through a Goal, ask explicitly: **“Create a Goal to
listen for comments on `/absolute/path/paper.tex`, handle them with verified
WPaper edits, and keep collaborating until I say stop.”** The goal remains
scoped to that Codex conversation; the normal comment-listen request still
works as an active waiting task without creating a Goal.

Listening never guesses a conversation ID or starts a separate model process.
Waits are cancellable, default to 45 seconds, and can run up to 300 seconds.
Use longer waits only when the client supports them or follows the returned
asynchronous operation handle; inline waits still respect client timeout caps.
Idle replies contain only `state:"waiting"` and `listener_id`. `waiting`
does not finish collaboration. Unused listeners expire after 15 minutes and
deliveries after 10 minutes, leaving the actual comments available. After a
VS Code reload or listener expiry, explicitly start again and replace the old
native job with the new receipt; an old scheduled prompt must not auto-restart.
`status` returns the outstanding delivery ID, comment IDs and lease expiry;
`projection:"full"` also returns the wake-up plan. Retrying start in the same
owning MCP session recovers its listener without replacing the delivery.
Another session cannot obtain that capability by starting on the same file.
Successful acknowledgments can be retried for ten minutes with the same
listener, delivery and operation IDs; a replay reports `replayed:true` and
does not remove any new comment. Cancel, release and stop preserve comments.

```json
{"action":"start","file":"/absolute/path/paper.tex","agent":"claude-code","include_existing":true}
{"action":"next","listener_id":"<returned listener_id>","wait_seconds":20}
{"action":"ack","listener_id":"<listener_id>","delivery_id":"<delivery_id>","operation_id":"<verified edit operation_id>"}
{"action":"stop","listener_id":"<listener_id>"}
```

`status` reports the listener and reader ranges; `release` preserves a delivery
for another attempt. If user typing invalidates a preview, re-read the target
and make a fresh guarded edit; do not remove the hash guard to force it through.

## Shared sidecar and identity

Comments on `paper.tex` are stored as formatted JSON in
`paper.timeline.comments`, next to the source. Split papers use one sidecar per
annotated `.tex` file, so the files can be committed and shared with the paper.

A comment points to a persistent `cellId`, not to a line number. The sidecar's
cell record keeps the object's label, stable key, source hash, source
snapshot, section path, and last known lines. WPaper reconciles that record in
this order:

1. matching LaTeX label and kind;
2. matching stable key;
3. identical source and kind;
4. source similarity of at least 0.6 in the same section.

The binding and displayed line number are refreshed after a match. If a source
unit was deleted, split, merged, or rewritten too heavily to identify safely,
the conversation remains available as a warning-coloured unplaced bubble at the
top of the rail. It is never silently attached to a nearby paragraph. A
malformed sidecar is likewise reported without being overwritten.
