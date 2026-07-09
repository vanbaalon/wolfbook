# Wolfslide regression corpus

Drop **real `.wslide` decks** into this folder (subfolders OK) to widen regression coverage
beyond the synthetic `fixtures/`. The harness scans `fixtures/` and `corpus/` recursively for
`*.wslide` (it skips any `img/` directory).

After adding a deck, capture its baseline once:

```bash
npm run wslide:golden     # (re)capture render baselines for the whole corpus
npm run wslide:check      # lint + round-trip + render-snapshot diff (the CI gate)
```

Real decks can be large and contain private content, so they are **not committed by default**
(see `.gitignore` in this folder). The synthetic fixtures and their golden baselines *are*
committed and are enough to gate most data-layer changes on their own.

The single in-repo real deck lives at
`Wolfbook Presentations/2026 Porto/2026_CERN/HandOut/slides/wolfbook.wslide` — copy or symlink it
here to include it:

```bash
ln -s "../../../../../Wolfbook Presentations/2026 Porto/2026_CERN/HandOut/slides/wolfbook.wslide" .
npm run wslide:golden
```
