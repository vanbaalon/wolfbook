# Fairy/Oberon telemetry improvements — 2026-07-10

Evidence reviewed: the latest incomplete run (`run_2026-07-04T11-45-18-334Z`) and
the seven latest completed postmortems. Recent difficult runs used 119–153 LLM calls,
left as many as 31 clean probes unrecorded, emitted the same cap event up to five
times, and sometimes reported negative remaining turns or record rates above 1.

Implemented priorities:

1. Reserve eight run-level calls for orchestration/review when assessing a plan.
2. Expose that overhead and the actual charm pool in `budget.plan` telemetry.
3. Clamp all remaining-budget counters at zero for truthful UI/model context.
4. Emit at most one Fairy-loop cap event per charm attempt.
5. Count a cap hit once, preventing inflated run metrics.
6. Lower the unrecorded-result consolidation threshold from six to four.
7. Deduplicate pending records by probe or symbol, so amended work is not double-counted.
8. Refresh the pending-record age after a successful replacement/amendment.
9. Prompt for a durable checkpoint after six uncheckpointed probes, then every three.
10. Clamp record rate to `[0,1]` and report `unrecordedSuccesses` explicitly.

These changes preserve the existing tool protocol and notebook format.
