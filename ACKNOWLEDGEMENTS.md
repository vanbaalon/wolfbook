# Acknowledgements

This file credits the open-source projects WPaper's LaTeX mode builds on or
took inspiration from. Other parts of Wolfbook list theirs in their own
documentation.

## WPaper's LaTeX mode

- **pdf.js** — Mozilla and the pdf.js contributors (Apache-2.0),
  <https://mozilla.github.io/pdf.js/>. Renders the paper's PDF in the viewer
  (`out/client/pdfjs`).
- **WLaTeX** and, through it, **Tectonic** (Peter K. G. Williams and
  contributors, MIT), **XeTeX** (Jonathan Kew, Khaled Hosny and others) and
  **dvipdfmx** (Mark A. Wicks, Jin-Hwan Cho, Shunsaku Hirata, Matthias Franz and
  others, GPL-2.0-or-later): the live typesetting engine behind the preview.
  See WLaTeX's own `ACKNOWLEDGEMENTS.md`.
- **TeX Live** and **latexmk** (John Collins) for the conventional build.

## The TikZ picture editor

It writes source for:

- **PGF/TikZ** — Till Tantau, Christian Feuersänger, Henri Menke and the PGF
  developers (GPL-2.0 or LPPL 1.3c).
- **tikz-feynman** — Joshua Ellis (LPPL 1.3 or later): Feynman vertices and
  edges (`\vertex`, `\diagram*`).
- **tikz-cd** — Augusto Stoffel (the commutative-diagram template).
- **dynkin-diagrams** — Benjamin McKay (LPPL 1.3c or later), whose root marks
  for Lie superalgebras informed the editor's super Dynkin styles (the styles
  are WPaper's own TikZ).

Colour palettes in its Style section (colour values only):

- **Tailwind CSS colours** — Tailwind Labs (MIT), for the "Modern" set.
- **Okabe–Ito palette** — Masataka Okabe and Kei Ito, *Color Universal
  Design* (2002/2008), for the colour-blind-safe set.
- **Nord** — Arctic Ice Studio and Sven Greb (MIT), for the cool "Nord" set.

Inspiration, with no code or data taken:

- **KtikZ** — Florian Hackenberger, Glad Deschrijver, João Carreira and
  contributors (GPL-2.0-or-later), <https://github.com/fhackenberger/ktikz>:
  the Insert catalogue and its sections, the coordinate readout and the
  templates.
- **Inkscape** — the Inkscape project: the Align & Distribute modes, via
  wslide's Arrange panel, whose geometry the picture editor shares.
- Super Dynkin conventions: V. G. Kac (1977); L. Frappat, A. Sciarrino,
  P. Sorba, *Dictionary on Lie Algebras and Superalgebras* (2000).

## Prepare for arXiv

- **arxiv_latex_cleaner** — Google Research (Apache 2.0): the approach to
  cleaning a source for arXiv (comments removed but a line-ending `%` kept,
  `comment` environments and `\iffalse` blocks dropped, unused files left
  out). No code taken; `arxivPack.js` is written from arXiv's own rules
  (info.arxiv.org/help/submit_tex.html and 00README.html).
