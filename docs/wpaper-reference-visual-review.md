# Frozen reference PDF visual review

Reviewed 2026-09-21. This is a comparison of existing artifacts, not a rebuild of
the current engine or acceptance of WPaper's physical UI interactions.

## Inputs and method

Both PDFs are under WLaTeX's
`artifacts/wpaper-reference-_1gz_7zt/`, named
`J2SoVWavefunctionsAndCharges.pdf`:

| Directory | SHA-256 verified against the actual PDF |
| --- | --- |
| `authoritative/` | `6d0f1e3d6b110a77e87f145fbd438e7a08b5616f45789327532719f85d590f0f` |
| `native-mapping-preserved/` | `1a185b6c9f7ddfeb62f1a51b44b221530ae98f6a751081379be2bc30b1763f22` |

These match `artifacts/wpaper-reference-verification.json`. Each has 15 A4
pages. Poppler 26.07.0 rendered every page at 96 DPI; all 15 side-by-side
comparisons were visually inspected, authoritative on the left, native on the
right. ImageMagick 7.1.2-29 composed the pairs. Scratch renders are in
`/tmp/wpaper-reference-visual/`; they are reproducible, not committed fixtures.

To reproduce from the frozen artifact directory:

```sh
mkdir -p /tmp/wpaper-reference-visual
pdftoppm -r 96 -png authoritative/J2SoVWavefunctionsAndCharges.pdf /tmp/wpaper-reference-visual/authoritative
pdftoppm -r 96 -png native-mapping-preserved/J2SoVWavefunctionsAndCharges.pdf /tmp/wpaper-reference-visual/native-mapping-preserved
```

For each two-digit page number NN, compare the two full-page images. Optional
ImageMagick diagnostics use `magick compare -fuzz 5% -metric AE A.png B.png null:`.
Pixel differences are diagnostic only; no acceptance threshold is assigned.

## Findings

- All 15 pages contain the corresponding sections, displayed equations and
  page numbers at this review resolution. Figures 1-4 retain their visible
  colored elements. No gross missing figure, blank replacement page or clipped
  main text was observed.
- Layout is not identical. Page 2 wraps the paragraph beginning "The full
  two-variable pole grid" differently. Page 7 has different vertical spacing
  around equations 29-34 and different hyphenation in the analytic-continuation
  paragraph. Page 11's inversion-pairing paragraph wraps differently before
  equation 64. Pages 12-14 also show line-break/hyphenation differences.
- Page 12 visibly contains both lines of equation 72 in both PDFs. This review
  does not reproduce the historical endpoint extractor's apparent missing
  mathematical token as a gross visual omission. It does not certify every
  subscript or glyph as equal.
- Page 14 contains unresolved `(??)` references in both PDFs. The authoritative
  fixture itself therefore needs a reference-resolution check before it can
  serve as a clean publication-quality baseline. This is not isolated to the
  native output.

## Acceptance boundary

The coarse full-document visual inspection is complete. Exact glyph/ink parity,
high-resolution mathematical detail, an agreed layout tolerance, current-engine
regeneration and WPaper screenshot/gesture acceptance remain unverified.

Source-provenance plan Amendment 2 explicitly separates its P6 page-count and
text-endpoint gate from visual equality. These observations do not reinstate
the superseded all-page math-endpoint gate or change the amendment's acceptance
criteria. They identify concrete work for the rendered-fidelity gate: resolve
the baseline's references, decide allowable cross-engine layout differences,
and compare regenerated output at that agreed scope.

Amendment 4 separately requires per-page glyph-count parity. Existing engine
reports were inspected alongside this review: `reference-lua-glyph-parity.json`
passes the incumbent control, but `reference-native-glyph-parity.json` fails on
pages 7, 12, 13 and 14 (native minus authoritative counts: +1, +2, +1, +2).
`reference-glyph-cause-audit.json` binds the native comparison to the PDF hash
above and finds equal counts against stock XeLaTeX. Its comparisons identify
hyphen/ligature differences, consistent with the visible reflow. Its
`font_expansion_causality_verified` flag is false, so this review does not claim
font expansion as a proven cause. The amended P6 count gate remains failing;
coarse visual inspection cannot waive it.
