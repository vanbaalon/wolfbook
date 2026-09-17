# Reading bookmarks

Shift-click bare paper to add a personal bookmark. Existing buttons, PDF links,
label badges and section controls keep their own actions; plain dragging still
selects text. A nearby existing bookmark is reused rather than duplicated.

An amber ribbon appears in the left page margin. Hover/focus reveals its remove
button. Bookmarks outside the visible band gather in compact, horizontally
scrollable top/bottom rails, with an arrow and count. Hover or keyboard focus
shows a thumbnail, section and page; click returns to the passage. The × removes
the bookmark, including from its saved state. The guided tour includes this flow.

Blue automatic links show the nearest heading above and below the actual visible
band, considering chapters, sections, subsections and subsubsections together.
These are transient navigation links: they have no delete button and are never
saved as personal bookmarks. Visible, unmapped and lower-level paragraph headings
are excluded. Amber personal chips use ≈ for approximate saved positions; the
full explanation remains in the tooltip and accessible label.

Rails sit flush against the viewer's top/bottom and left edges. Light-green
chips additionally expose off-screen pending revisions with current render
coordinates. Their thumbnail navigation opens the existing review target; it
does not accept a change or create a bookmark. Unmapped/stale revisions remain
in the review list rather than receiving a guessed edge position.

Bookmarks are per-paper workspace reading state, not TeX edits. Source-object
anchors are retained when available and resolved against subsequent renders.
If an anchor cannot be recovered, the previous PDF position is retained and
labelled “saved position”; a removed page reports that navigation is unavailable.
The UI supports up to 200 bookmarks per paper and explicitly reports the limit.
