# Oberon / Fairy architectural roadmap — July 2026

Status: active architecture plan  
Scope: `out/extension/oberon/`  
Goal: evolve Oberon from a reliable Wolfram computation agent into an evidence-driven
research system capable of sustained, PhD-level mathematical and computational research.

## 1. Product claim and success criterion

Oberon's current strongest claim is narrower than “autonomous PhD researcher”:

> Given a well-scoped mathematical or physics computation, Oberon can plan work,
> execute an incremental Wolfram Language derivation, preserve intermediate artefacts,
> and deliver a notebook that re-executes in a fresh kernel.

That is valuable, but clean execution proves reproducibility of a computation, not the
scientific correctness, completeness, relevance, or novelty of the result. The target
architecture must distinguish those properties and measure each independently.

The long-term acceptance criterion is not “the agent wrote a report.” It is:

1. the problem and assumptions are scientifically well specified;
2. hypotheses and predictions are recorded before tests;
3. experiments discriminate among plausible alternatives;
4. claims are traceable to executable or bibliographic evidence;
5. important results survive an independent falsification attempt;
6. coverage and numerical uncertainty are explicit;
7. confidence is calibrated against held-out research tasks;
8. a domain expert can audit and resume the work without reconstructing hidden context.

## 2. Current architecture

```text
brief → Planner → Quest → Dispatcher → Charm(s)
                                  ↓
                  Director → Fairy tool loop
                                  ├─ Wolfram kernel
                                  ├─ literature search/read
                                  ├─ SkilXiv recall
                                  └─ steps/facts/checkpoints
                                  ↓
                       clean.wb fresh replay
                                  ↓
                 Scroll → Scribe/Grimoire/report
```

### Existing strengths

- Executable notebooks are first-class artefacts.
- Fresh-kernel replay catches hidden session dependencies.
- Director and Fairy separate programme decisions from execution.
- Programmes are journaled and resumable.
- Partial runs bank utilities and facts instead of discarding all progress.
- Literature discovery combines multiple engines, citation graphs, ranking, and deep reads.
- Assumptions, validation expressions, budgets, and telemetry are explicit.
- Tool execution is guarded by a finite-state machine and persistent work directory.

### Architectural limitations

1. Research is usually a single sequential trajectory rather than a search over rival methods.
2. `delivered`/clean replay is treated too closely to a scientific verdict.
3. Hypotheses, predictions, observations, assumptions, and interpretations are not typed objects.
4. Experimental design is encoded in prose rather than an enforceable protocol.
5. The Grimoire is an append-only document, not a contradiction-aware research world model.
6. Context is accumulated and compacted reactively instead of reconstructed from relevant state.
7. Literature claims and local computations are joined mainly by prose.
8. Evaluation focuses on completion and self-report rather than decomposed scientific competence.
9. Confidence is derived mainly from terminal state and is not empirically calibrated.
10. Expert input occurs mostly after ambiguity or failure, rather than at high-leverage decisions.
11. Numerous prompt rules and gates form a growing bespoke policy engine with unclear ablations.
12. Research integrity threats are not represented separately from ordinary runtime failures.

## 3. Architectural principles

All roadmap work should follow these constraints:

- **Evidence before orchestration.** Add a workflow only when evaluation shows a gain.
- **Typed state before more prompt text.** Stable objects should carry research state.
- **Orthogonality over self-review.** Verification must differ from the producing path.
- **Unknown is a valid value.** Never turn missing evidence into a neutral or passing score.
- **Claims, not documents, are the unit of knowledge.** Documents are views over provenance.
- **Bounded search.** Multiple candidates are useful only with budgets and promotion rules.
- **Human expertise is a resource.** Ask at decision points where it changes expected value.
- **Full trace, minimal context.** Persist everything, but show the model only relevant state.
- **Negative results survive.** Failed methods and refuted hypotheses prevent repeated waste.
- **No novelty without prior-art evidence.** Novelty is a reviewed claim, not model sentiment.

## 4. Roadmap

### Stage 1 — Capability-based evaluation foundation (implemented in this update)

Create a versioned research-quality rubric and deterministic telemetry assessor.

Capabilities:

1. problem formulation;
2. literature grounding;
3. hypothesis quality;
4. experimental design;
5. implementation correctness;
6. numerical validity;
7. coverage/completeness;
8. interpretation;
9. reproducibility;
10. uncertainty calibration;
11. novelty assessment.

Required properties:

- `pass`, `partial`, `fail`, and `unassessed` are distinct;
- each judgement carries evidence and grader provenance;
- deterministic signals never claim semantic correctness;
- aggregate score reports assessment coverage;
- results are machine-readable and comparable between builds;
- regressions can be detected per capability, not only by final verdict.

Delivered files:

- `tests/researchEval.js` — rubric, telemetry assessment, aggregation, comparison.
- `tests/researchEval.test.js` — offline regression tests.
- `tests/research-eval-cli.js` — evaluate any telemetry JSONL into JSON/Markdown.

Exit criterion: every production research run can produce a capability report, and no clean
replay is automatically labelled scientifically correct.

### Stage 2 — Frozen research challenge packs

Replace bare prompt fixtures with versioned challenge directories containing:

- public task and hidden reference solution;
- canonical papers and exact source locations;
- required intermediate invariants;
- common conceptual traps;
- deterministic graders and expert rubric;
- perturbation variants and contamination metadata;
- cost/time limits and repeat count.

Run at least three trials per configuration. Store model/provider/build/prompt hashes.

Exit criterion: changes can be accepted or rejected using confidence intervals and per-capability
regressions on held-out problems.

### Stage 3 — Ablation and shadow evaluation

Make major subsystems independently switchable: Director, literature, recall, record gates,
candidate search, independent verifier, and context reconstruction. Support shadow graders that
observe a run but cannot affect it.

Exit criterion: every expensive architectural component has measured marginal value.

### Stage 4 — Typed research ledger

Introduce persistent, versioned entities:

```text
Claim, Hypothesis, Assumption, Prediction, Observation, Derivation,
Method, Experiment, Citation, Contradiction, OpenQuestion, Decision
```

Each entity has a stable ID, status, dependencies, producing artefacts, supporting and opposing
evidence, confidence dimensions, and supersession links. Grimoire/Scroll/report become generated
views rather than canonical state.

Exit criterion: any report sentence can be traced to source cells/papers and contradictions are
queryable rather than buried in old Markdown.

### Stage 5 — First-class hypothesis lifecycle

Record hypotheses before execution with motivation, rival hypotheses, falsifiable predictions,
and discriminating tests. Enforce immutable hypothesis versions after testing begins. Preserve
refutations and null results.

Exit criterion: the system can answer “what did we predict before observing this output?”

### Stage 6 — Typed experimental protocols

Require an approved `ExperimentPlan` for non-trivial stages:

- target hypothesis and method rationale;
- independent/dependent variables;
- controls and baselines;
- parameter ranges and precision;
- expected outcomes under rivals;
- stopping, convergence, acceptance, and rejection rules;
- resource estimate and artefacts to retain.

Exit criterion: Fairy executes an explicit protocol instead of inventing experimental design
incrementally inside the same trajectory that interprets the result.

### Stage 7 — Candidate-method generation and selection

Before an expensive stage, generate 3–5 materially different candidate methods. Deduplicate and
rank by plausibility, information gain, falsifiability, cost, and dependence on unverified claims.
Run cheap pilots before promoting branches.

Exit criterion: difficult tasks explore alternatives without multiplying full-run cost blindly.

### Stage 8 — Bounded progressive research tree

Represent branches, observations, failures, and promotion decisions explicitly. Allocate budget
progressively; prune dominated or repeatedly failing branches; retain negative findings. Parallel
execution is permitted only for independent branches with isolated kernels and artefacts.

Exit criterion: the Director acts as an evidence-based experiment manager rather than a sequential
task scheduler.

### Stage 9 — Independent proposer/evaluator/allocator roles

Separate method generation, adversarial evaluation, and resource allocation. Communicate only via
typed artefacts; do not share private conversational histories. Evaluators must identify concrete
falsification tests, not merely express scepticism.

Exit criterion: review changes the selected experiments and improves held-out scores in ablation.

### Stage 10 — Orthogonal verification service

Select verification by claim class:

- symbolic claim → numeric samples and an alternate derivation;
- numerical spectrum → invariants, sectors, and alternate solver;
- asymptotic claim → scale/precision convergence and competing fits;
- exhaustive enumeration → independent total/count certificate;
- literature reproduction → source table/equation comparison;
- algorithmic claim → isolated implementation or second kernel.

Verifier context contains claims, assumptions, and artefacts—not the producer's persuasive narrative.

Exit criterion: “verified” requires an independent falsification attempt, not only clean replay.

### Stage 11 — Coverage and completeness certificates

Add domain-aware certificates: degeneracy sums, Hilbert dimensions, representation totals, root
multiplicities, sector closure, parameter-grid coverage, and precision/truncation sweeps.

Exit criterion: correct examples and complete solutions have distinct machine-checkable statuses.

### Stage 12 — Decomposed uncertainty and calibration

Replace scalar confidence with execution, numerical, specification, coverage, literature,
interpretation, and novelty confidence. Fit calibration curves from held-out challenges and report
expected calibration error/Brier score.

Exit criterion: an 0.8 confidence bucket is correct approximately 80% of the time for its claim class.

### Stage 13 — Provenance-linked literature ingestion

Represent paper version, page/equation/section, extracted claim, applicability assumptions,
extraction confidence, and local reproduction. Treat retrieved content and skills as untrusted data.

Exit criterion: the system can distinguish “relevant paper” from “paper supports this exact claim.”

### Stage 14 — State-reconstructed context

Construct each model turn from the active objective, protocol, hypotheses, relevant ledger slice,
kernel symbols, last observation, unresolved failure, and budget. Keep full history in telemetry but
remove it from default working context.

Exit criterion: long runs retain or improve quality while reducing prompt size and history dependence.

### Stage 15 — Scientific governance and integrity

Add checkpoints for problem framing, method shortlist, expensive execution, surprising-result
interpretation, novelty, and external contribution. Detect selective reporting, post-hoc hypothesis
changes, unsupported novelty, hidden failed experiments, and prompt injection from retrieved text.

Exit criterion: a domain expert receives alternatives, evidence, uncertainty, and cost at each
decision—not a generic approval prompt.

## 5. Recommended sequencing

```text
Evaluation (1–3)
    ↓
Research state (4–6)
    ↓
Search and allocation (7–9)
    ↓
Independent verification (10–12)
    ↓
Knowledge/context/governance (13–15)
```

Do not begin multi-agent tree search before Stages 1–6. Without evaluation and typed state, adding
agents increases cost and persuasive output faster than it increases trustworthy science.

## 6. Near-term milestones

### Milestone A — Evaluation baseline

- Generate capability reports for the latest 20 completed runs.
- Expert-label at least five runs.
- Record where deterministic evidence and expert judgement disagree.
- Freeze the first three challenge packs.

### Milestone B — Scientific state prototype

- Implement Claim/Hypothesis/Experiment objects for Director mode only.
- Generate the final report exclusively from accepted Claim objects.
- Retain existing Scroll/Grimoire formats as compatibility views.

### Milestone C — One bounded branch experiment

- Select one historically difficult QQ-system task.
- Compare linear Director against three candidate methods plus pilot selection.
- Measure correctness, coverage, cost, and expert intervention.

## 7. Non-goals

- Claiming autonomous publication readiness from notebook replay.
- Adding a large swarm of agents without ablation evidence.
- Replacing deterministic Wolfram verification with another LLM verdict.
- Treating model-written confidence as calibrated probability.
- Automatically publishing novelty claims or skills without human review.

## 8. Architectural decision for July

The first implementation is the evaluation foundation because it changes how every subsequent
decision is made. Oberon will improve fastest when failures are localized to scientific capabilities
rather than patched one telemetry incident at a time.

