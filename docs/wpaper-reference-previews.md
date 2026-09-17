# WPaper reference previews

Printed reference links now resolve through their PDF annotation destination.
PDF.js may extract a whole paragraph line as one text item; text segmentation,
repeated printed numbers, and the margin-badge layout do not establish identity.

The compiled AUX destination is joined to the project model independently of
badge placement. Named equation, figure, table, section and appendix targets can
use semantic bounds. Heading previews show a bounded opening excerpt. Multipage
objects show the first destination page and say so.

Explicit coordinate destinations, missing semantic bounds, ambiguous aliases,
or stale source mappings use a labelled destination-page excerpt instead. A
rendering failure leaves navigation available and states that the preview is
unavailable. No inferred nearby number is substituted for the actual destination.

Previews have a short dwell delay, keyboard-focus activation, Escape dismissal,
viewport-bounded positioning and an Open target button. Rendering requests are
deduplicated in a bounded cache tied to PDF identity, generation and label data.
Results from superseded PDFs are discarded; a stationary pointer is rechecked
against replacement link annotations after rendering. An image timeout does not
disable navigation.

Regression coverage: `tex-destination-hover.test.js` executes the destination
resolver and actual labels-message wiring, including aliases, stale generations,
multiline/multipage targets, explicit destinations and in-flight recompilation.
`tex-comments.test.js` and `tex-panel.test.js` check the client integration.
