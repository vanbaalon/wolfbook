# Vendored pdf.js

Version pinned in `VERSION` (5.7.284), fetched by
`Experiments/wolfbook-tex/c-pdfjs/vendor.sh`. Flat files, checked in — the same
arrangement as `out/client/three.module.min.js` and `out/client/katex.mjs`:
no npm dependency, no bundler, loaded as native ES modules from the webview.

`pdf.min.mjs` needs `pdf.worker.min.mjs` beside it, exactly as three.js needs
`three.core.min.js`.

## Why `standard_fonts/` is here and `cmaps/` is not

MEASURED by Stage 0 Spike C over 86 real PDFs (17 corpus builds + 69 hep-th
preprints): **164 non-embedded base-14 font references across 69 files** —
Times, Helvetica, Courier, Symbol. Every offender is an arXiv preprint, whose
stamp and older toolchains reference those faces without embedding them.
Without the pack pdf.js substitutes a system face and every glyph box moves.
That contradicts the "TeX embeds its fonts" assumption, so it is written down.

`cmaps/` (1.14 MB) is genuinely unnecessary: encodings across all 86 PDFs were
only Custom / Builtin / WinAnsi / Standard / Identity-H / MacRoman / Symbol —
no predefined CMap anywhere.
