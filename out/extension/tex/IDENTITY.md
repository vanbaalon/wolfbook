# Object identity in Wolfbook TeX

A Stage 1 deliverable, because every later stage rests on it. A hash-guarded
edit, a render map, a stale-output badge and an AI editing session all assume
that "the equation I looked at" and "the equation I am about to change" are the
same thing. This file says exactly what that means and where it stops being
true.

Implemented in `texModel.js` (`buildModel`, `reconcile`), asserted in
`kernel/tests/tex-model.test.js`.

---

## The two names an object has

**`objectId`** — session-local, opaque, unique. Cheap to compare, meaningless
across a restart. Never persist it or write it into a file.

**`stableKey`** — human-readable and content-addressed:

```
<sectionSlug>/<kind>/<label ?? hash8(normalizedSource)>/<ordinal>
strong-coupling/display-equation/L:eq:dispersion/0
numerics/figure/3f9a1c22/1
```

A labelled object keys on its **label**, which is the strongest identity a TeX
document offers: it is the name the author already chose, and TeX itself treats
it as the object's identity. Unlabelled objects fall back to a hash of their
*normalized* source — whitespace collapsed, comments stripped — so reformatting
does not create a new object. The trailing ordinal disambiguates genuine
duplicates (the same one-line equation written twice in one section).

`normalizedSource` deliberately keeps `\%`. An escaped percent is content, not
a comment, and treating it as one merges objects that differ.

## Reconciliation: four rules, tried in order

`reconcile(prev, next)` carries `objectId`s across a re-scan. Each rule runs to
exhaustion before the next, so a weaker rule can never steal a match a stronger
one wants. The rule that matched is recorded on `identityRule`.

**1. `stableKey` + overlapping range.** The common case: nothing moved, nothing
was renamed. Requiring the range to overlap stops two identical unlabelled
equations in one section from swapping ids when one is deleted.

**2. Same `\label`, same kind.** Survives moving an object to a different
section or a different *file*. This is why the project graph is Stage 1 work and
not deferred: a per-file model cannot see that `eq:dispersion` left
`section3.tex` and arrived in `section4.tex`, and would report a delete plus an
unrelated insert.

**3. Identical `sourceHash` and kind.** Content unchanged, position moved —
someone inserted a paragraph above. This is what makes "typing earlier in the
document" a non-event for everything below it.

**4. Normalized similarity ≥ 0.6, same kind, same section.** Dice coefficient
over character bigrams. This is the rule that makes *typing inside an object*
safe: an equation is still itself after you change one term. The section
constraint stops a short paragraph in section 2 from claiming a similar short
paragraph in section 9.

Anything unmatched afterwards is genuinely new or genuinely gone, and is
reported as `added` / `removed` — never renumbered quietly.

## Splits and merges are reported, not guessed

Splitting one paragraph into two, or merging two into one, has no correct
single answer for which half keeps the id. Rather than pick and hide it,
`reconcile` returns `split` and `merged` alongside the matches. A caller that
cannot see a split cannot warn about one, and Stage 7's render diff needs
exactly this to say "this paragraph became two" instead of "one paragraph
changed and another appeared".

## Where identity legitimately breaks

Stated so that callers flag it rather than trusting through it:

- **A restart.** `objectId`s are regenerated. Address by `stableKey` or label
  across sessions; the `paper_*` tools accept all three.
- **Renaming a `\label`.** Rule 2 cannot fire, and rules 3–4 only save it if
  the body is otherwise unchanged or similar. A rename is close to a new
  object, which is honest: every `\ref` in the paper just broke too.
- **Rewriting an unlabelled object beyond 0.6 similarity.** By construction.
  If the text is more than 40% different, calling it the same object would be
  the lie.
- **Two identical unlabelled objects swapping places.** Rules 1 and 3 match on
  content, so the ids may exchange. Harmless for editing (the content is
  identical) but not something to build a render diff on.

## The contract this gives an agent

1. `paper_getObject` returns `objectId`, `stableKey` and a full `sourceHash`.
2. Pass that `sourceHash` back as `expected_source_hash` on `paper_applyEdit`.
3. If anything changed underneath, the edit is **rejected** with a structured
   conflict carrying the *current* hash and first line — enough to re-read and
   retry, rather than a bare failure or, worse, a silent overwrite.

The same shape as the notebook guard at `tools/index.js:104`
(`mutationConflict`), deliberately: an agent that has learned one already knows
the other.
