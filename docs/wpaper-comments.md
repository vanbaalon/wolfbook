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

Comments added with **Accept + comment…** during revision review enter this same
annotation stream and retain their revision provenance.

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
