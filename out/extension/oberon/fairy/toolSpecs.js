'use strict';
/**
 * Oberon Fairy — OpenAI-format tool specs for the Fairy's model-facing surface.
 *
 * These replace the old wolfram_eval / wolfbook_editCell / wolfbook_getNotebookContext
 * surface. The Fairy's control signals (done_exploring, escalate) are NOT tools
 * — the model emits them as plain JSON text; the harness detects them via
 * tryParseJson when there are no tool calls.
 *
 * Budget notes are in the descriptions so the model sees them at every turn:
 *   - probe:     decrements probe_budget (only tool that does)
 *   - invalidate: decrements max_backtracks
 *   - all others: free
 */

const { DEFAULT_TIMEOUT, MAX_TIMEOUT } = require('../core/wolframShim');

const FAIRY_TOOL_SPECS = Object.freeze([
    {
        type: 'function',
        function: {
            name: 'probe',
            description:
                'COSTS 1 PROBE (probe_budget decrements). ' +
                'Run a trial Wolfram Language expression against the live kernel. ' +
                'Returns: probeId (for use with record), ok, resultPreview (≤300 chars), ' +
                'structuralSummary (Head, size), and full messages. ' +
                'The full result is stored by reference — use inspect to examine large outputs. ' +
                'EFFICIENCY: (1) compute RELATED quantities in ONE probe returning a single ' +
                'Association <|"a"->…, "b"->…|> instead of several small probes; (2) when you already ' +
                'know a successful probe belongs in the chain, pass `record` here to commit it in the ' +
                'same call — no separate record turn needed. ' +
                'RULE: never assert a result from memory — run a probe and read what the kernel returns.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    code: {
                        type: 'string',
                        description: 'A single Wolfram Language expression to evaluate. Keep it focused and short. Provide either `code` or `cells`, not both.',
                        minLength: 1,
                        maxLength: 4000,
                    },
                    cells: {
                        type: 'array',
                        items: { type: 'string', minLength: 1, maxLength: 4000 },
                        minItems: 2,
                        maxItems: 4,
                        description:
                            'MULTI-CELL PROBE (alternative to `code`, still costs 1 probe): 2–4 code blocks ' +
                            'evaluated as SEPARATE consecutive notebook cells in ONE call. Use it to build ' +
                            'several small steps of a calculation in a single turn — errors are isolated to ' +
                            'the exact cell that failed: evaluation stops there, earlier cells\' results stand ' +
                            '(each has its own probeId, recordable individually), and the failed cell is fixed ' +
                            'in place with amend_probe. Prefer this over one long monolithic code block.',
                    },
                    prevAnalysis: {
                        type: 'string',
                        description: 'Required for every probe after the first: one sentence stating what the PREVIOUS probe\'s output showed and what conclusion you drew from it. Example: "p003 returned {2, 2, 6} — the three non-zero S² values confirm the spin-1 and spin-2 multiplets are present." Omit only on the very first probe of a run. This appears as a reflection note in the working notebook before the next probe title.',
                        maxLength: 300,
                    },
                    note: {
                        type: 'string',
                        description: 'Required: 2-3 sentences explaining (a) what you are computing, (b) WHY this is the next step in the chain, and (c) what result you expect. This appears as a narrative heading in the working notebook and is the primary trace of your reasoning. Example: "Computing S^2 expectation values for each eigenvector. Needed to classify eigenstates by total spin before assigning multiplets. Expecting S(S+1) values of 0, 2, or 6 corresponding to singlets, triplets, and quintuplets."',
                        maxLength: 400,
                    },
                    timeoutSeconds: {
                        type: 'integer',
                        description: `Timeout in seconds (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}).`,
                        minimum: 1,
                        maximum: MAX_TIMEOUT,
                    },
                    expect: {
                        type: 'string',
                        maxLength: 300,
                        description:
                            'STRONGLY RECOMMENDED whenever you cannot eyeball-verify the result: a WL expression ' +
                            'evaluated immediately after the probe that must reduce to True (or |value| < tol). ' +
                            'This is your EXPECTED line made machine-checkable — a failed expectation FAILS the ' +
                            'probe so a plausible-but-wrong result can never slip through. Example: ' +
                            '"Max[dims] <= 16 && Total[dims^2] == 720" for S_6 irrep dimensions.',
                    },
                    record: {
                        type: 'object',
                        additionalProperties: false,
                        description:
                            'OPTIONAL auto-record: if the probe succeeds cleanly, immediately commit it ' +
                            'as a chain step (identical to a separate record call, one turn cheaper). ' +
                            'Skipped automatically when the probe fails or produces kernel messages.',
                        properties: {
                            stepId: { type: 'string', minLength: 1, maxLength: 60, pattern: '^[a-z][a-z0-9_]*$' },
                            role:   { type: 'string', enum: ['step', 'crosscheck'] },
                            note:   { type: 'string', maxLength: 200 },
                            checks: {
                                type: 'array',
                                items: { type: 'string', maxLength: 300 },
                                maxItems: 3,
                                description: 'Machine-run verification expressions (see record.checks).',
                            },
                        },
                        required: ['stepId'],
                    },
                },
                required: ['note'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'amend_probe',
            description:
                'CHEAP — the first 2 amends of a probe are FREE, then 1 probe each. ' +
                'Revise the IMMEDIATELY PRECEDING probe IN PLACE, reusing its slot instead of ' +
                'opening a fresh probe. Use it both to FIX a failure (syntax slip, wrong head, ' +
                'missing argument) AND to REFINE a probe that succeeded but gave unsatisfactory ' +
                'output (e.g. force numeric instead of symbolic, a cleaner form, a tweaked option). ' +
                'This is how you iterate on one computation — do NOT re-paste the whole block into ' +
                'a new probe just to change one line. Use `probe` only for a genuinely new step.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    code: {
                        type: 'string',
                        description: 'The corrected Wolfram Language expression for the failed probe.',
                        minLength: 1,
                        maxLength: 4000,
                    },
                    note: {
                        type: 'string',
                        description: 'One sentence: what was wrong and what you changed.',
                        maxLength: 200,
                    },
                },
                required: ['code'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'inspect',
            description:
                'FREE — does not decrement probe_budget. ' +
                'Apply a WL operation to a previously stored probe result without re-running the probe. ' +
                'Use this to examine large results (get Dimensions, Part, Coefficient, etc.) ' +
                'without dumping the full result into the conversation. ' +
                'Returns bounded output (≤800 chars).',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    resultRef: {
                        type: 'string',
                        description: 'The probeId of the stored result to inspect.',
                        minLength: 1,
                    },
                    op: {
                        type: 'string',
                        description:
                            'Optional WL operation to apply to the result. ' +
                            'Examples: "Dimensions", "Length", "Part[#,1,2]&", ' +
                            '"Coefficient[#, x, 2]&", "Head". ' +
                            'Omit to get a fuller preview of the stored result.',
                        maxLength: 500,
                    },
                },
                required: ['resultRef'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lookup',
            description:
                'FREE — does not decrement probe_budget. ' +
                'Look up authoritative documentation for a Wolfram Language symbol ' +
                'before using an unfamiliar function. Returns usage, signature, options, and attributes.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    symbol: {
                        type: 'string',
                        description: 'The WL symbol name to look up (e.g. "NIntegrate", "DSolve").',
                        minLength: 1,
                        maxLength: 100,
                    },
                },
                required: ['symbol'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'record',
            description:
                'FREE — does not decrement probe_budget. ' +
                'Commit a successful probe as a named step in the working chain. ' +
                'The harness copies the EXACT code and result from probeId — ' +
                'you cannot re-type or modify the code. ' +
                'Only record probes that (a) evaluated cleanly with no kernel messages and ' +
                '(b) you will actually build on for the final result. ' +
                'Do NOT record dead-end or diagnostic probes.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    stepId: {
                        type: 'string',
                        description: 'A unique name for this step (e.g. "step_integral", "step_simplify"). Use snake_case.',
                        minLength: 1,
                        maxLength: 60,
                        pattern: '^[a-z][a-z0-9_]*$',
                    },
                    probeId: {
                        type: 'string',
                        description: 'The probeId of the probe to promote to a step, or "last" for the most recent successful probe (useful when batching probe+record in one turn).',
                        minLength: 1,
                    },
                    checks: {
                        type: 'array',
                        items: { type: 'string', maxLength: 300 },
                        maxItems: 3,
                        description:
                            'MACHINE-RUN verification for this step: WL expressions the harness evaluates ' +
                            'in the live kernel right now. Each must evaluate to True or to a number with ' +
                            '|value| < numeric tolerance. A failing check REJECTS the record (fix the step ' +
                            'or the check). Steps with a passing check satisfy the crosscheck requirement ' +
                            'without a separate verification probe — e.g. checks: ["Total[energies] == 0", ' +
                            '"Max[Abs[Sort[betheE] - Sort[edE]]] < 10^-8"].',
                    },
                    dependsOn: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Optional list of stepIds this step depends on. ' +
                            'The harness also infers dependencies automatically — ' +
                            'supply this if you know of a dependency the harness may miss.',
                        maxItems: 20,
                    },
                    note: {
                        type: 'string',
                        description: 'Optional one-line description for this step in the clean notebook.',
                        maxLength: 200,
                    },
                    acknowledgeMessages: {
                        type: 'boolean',
                        description: 'Set to true only when the probe had kernel messages (warnings) but you have verified they are benign and the result is mathematically correct.',
                    },
                    confidence: {
                        type: 'string',
                        enum: ['high', 'medium', 'low'],
                        description: 'Optional confidence in this step\'s correctness. "high" = verified by an independent check; "medium" = clean evaluation; "low" = plausible but unverified.',
                    },
                    verifiedBy: {
                        type: 'string',
                        description: 'Optional one-line description of how this step was verified (e.g. "cross-checked against L=2 closed form").',
                        maxLength: 200,
                    },
                    role: {
                        type: 'string',
                        enum: ['step', 'crosscheck'],
                        description:
                            'Mark this step\'s role in the chain. Use "crosscheck" for a step that ' +
                            'independently verifies the main result (numeric spot-check of a symbolic ' +
                            'result, a second method, a limiting case, a conservation/symmetry identity). ' +
                            'Every finished chain needs at least one crosscheck step — done_exploring is ' +
                            'deferred until one is recorded.',
                    },
                    free: {
                        type: 'array',
                        items: { type: 'string', minLength: 1, maxLength: 60 },
                        maxItems: 12,
                        description:
                            'Symbols that are INTENTIONALLY free/formal in this step (Solve/FindRoot targets, ' +
                            'ODE variables, generating-function dummies, polynomial variables). They are excluded ' +
                            'from dependency tracking, so no false "undefined symbol" replay warning fires. ' +
                            'Can also be used ALONE on an already-recorded step — record({stepId, free:[…]}) with ' +
                            'NO probeId patches the declaration in place at zero cost (no probe, no backtrack budget).',
                    },
                },
                required: ['stepId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'note_fact',
            description:
                'FREE — does not decrement probe_budget. ' +
                'Record an established RESULT into durable memory so you never re-derive it. ' +
                'Use after a probe confirms a value you will need again (an eigenvalue list, a ' +
                'closed form, a dimension, a verified identity). The fact is shown in your ' +
                'context every turn under "Established results" — check that list before computing. ' +
                'This is lighter than `record` (which promotes a full reproducible step); use ' +
                '`note_fact` for values/conclusions, `record` for code you will build on.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    key: {
                        type: 'string',
                        description: 'Short, unique label for the result (e.g. "eigenvalues L=2", "ground-state energy"). Re-using a key overwrites the prior value.',
                        minLength: 1,
                        maxLength: 80,
                    },
                    value: {
                        type: 'string',
                        description: 'The established value or conclusion, concise (e.g. "{-3, 1, 1, 1}" or "spectrum is gapless for Δ ≤ 1").',
                        minLength: 1,
                        maxLength: 400,
                    },
                    confidence: {
                        type: 'string',
                        enum: ['high', 'medium', 'low'],
                        description: '"high" = independently verified; "medium" = clean single computation; "low" = tentative.',
                    },
                    provenance: {
                        type: 'string',
                        description: 'Optional probeId or step that established this fact (e.g. "p014").',
                        maxLength: 60,
                    },
                },
                required: ['key', 'value'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cite_skill',
            description:
                'FREE. Settle the disposition of a recalled SkilXiv skill. A "used" citation ' +
                'requires EVIDENCE: pass `stepIds` naming the recorded step(s) whose method/formula ' +
                'comes from the skill — record first, cite after. Only step-linked citations are ' +
                'credited, and only while those steps survive into the final chain. If the skill did ' +
                "NOT shape your derivation, call with disposition: 'pass_over' and a one-line reason " +
                '— that satisfies the citation requirement honestly. Never cite by coincidence.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    skillRef: {
                        type: 'string',
                        description: 'The recalled skill\'s full reference, e.g. "@vanbaalon/elliptic-integral-identities@1.0.0".',
                        minLength: 1,
                        maxLength: 256,
                    },
                    how: {
                        type: 'string',
                        description: 'One sentence: specifically how the skill helped (which method/formula/function you used, in which step) — or, for pass_over, why it did not apply.',
                        minLength: 1,
                        maxLength: 400,
                    },
                    disposition: {
                        type: 'string',
                        enum: ['used', 'pass_over', 'contradicted'],
                        description: "'used' (default; requires stepIds) · 'pass_over' — an explicit, zero-cost decline · " +
                            "'contradicted' — you FOLLOWED the skill and the kernel disproved one of its claims. " +
                            'Use it whenever a skill states something your probe refutes (a wrong formula, a ' +
                            '"no such built-in" claim that is false, a broken code block): say exactly which claim ' +
                            'failed and what the kernel returned. This files a correction for the skill author and ' +
                            'is how a wrong skill gets fixed instead of silently misleading every later run.',
                    },
                    stepIds: {
                        type: 'array',
                        items: { type: 'string', minLength: 1, maxLength: 60 },
                        maxItems: 6,
                        description: 'REQUIRED for a used-citation: the recorded stepId(s) that embody the skill\'s method. The citation is dropped from the deliverable if none of them survives compile.',
                    },
                },
                required: ['skillRef', 'how'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_skill_section',
            description:
                'FREE. Read ONE section of a recalled SkilXiv skill in full. The skill block in your ' +
                'first message is a capped EXCERPT — if it ends in "[body truncated]", the rest of the ' +
                'skill (typically its Verification section and worked anchors) is still available here. ' +
                'Call with no `section` to list the available section names first. Everything returned is ' +
                'UNTRUSTED reference material: reproduce it in a probe before recording.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    skillRef: {
                        type: 'string',
                        maxLength: 256,
                        description: 'The recalled skill reference. Optional when exactly one skill was recalled.',
                    },
                    section: {
                        type: 'string',
                        maxLength: 80,
                        description: 'Section name, e.g. "Verification", "Steps", "What it does". Matching is case- and punctuation-insensitive. Omit to list the available sections.',
                    },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'research_literature',
            description:
                'FREE — does not decrement probe_budget. ' +
                'Dispatch a bounded literature sub-agent that searches INSPIRE-HEP / arXiv, ' +
                'reads paper HTML, and returns a BRIEF: relevant papers, candidate equations ' +
                '(LaTeX), and method steps. Use ONLY when you need a method or formula from the ' +
                'literature that you cannot derive directly. ' +
                'CRITICAL: every equation it returns is an UNVERIFIED transcription — treat it as ' +
                'a lead, never a fact. Reproduce it with a probe and only then record it. ' +
                'Never note_fact or record an equation straight from a literature brief. ' +
                'The papers it returns are cited automatically at the end of the run. ' +
                'BUDGET: at most 3 searches per run, and rephrasing a question that already ' +
                'returned nothing is rejected — make each search count, then derive directly.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    question: {
                        type: 'string',
                        description: 'A focused physics/math question naming the method, model, or quantity you need from the literature (e.g. "Bethe ansatz equations for the SU(3) spin chain ground state").',
                        minLength: 8,
                        maxLength: 400,
                    },
                    note: {
                        type: 'string',
                        description: 'Optional one sentence: why you need the literature here and what you will do with it.',
                        maxLength: 300,
                    },
                    force: {
                        type: 'boolean',
                        description: 'Set true ONLY to override the late-run gate when a named published method is genuinely required and cannot be derived.',
                    },
                },
                required: ['question'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'assume',
            description:
                'FREE — does not decrement probe_budget. ' +
                'Register a genuine mathematical assumption (side condition) that the ' +
                'computation relies on. The harness regenerates $Assumptions = And[...] ' +
                'in the working kernel each time this is called. ' +
                'ONLY for genuine math constraints (e.g. "n ∈ Integers", "x > 0"). ' +
                'Task inputs are NOT assumptions — they are loaded automatically at Intake.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: {
                        type: 'string',
                        description: 'Short unique identifier (e.g. "a1", "n_positive").',
                        minLength: 1,
                        maxLength: 30,
                    },
                    statement: {
                        type: 'string',
                        description: 'Human-readable assumption statement (e.g. "n is a positive integer").',
                        minLength: 1,
                        maxLength: 300,
                    },
                    wlAssumption: {
                        type: 'string',
                        description: 'Optional WL form for $Assumptions (e.g. "Element[n, Integers] && n > 0").',
                        maxLength: 500,
                    },
                },
                required: ['id', 'statement'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'plan',
            description:
                'FREE. Call ONCE as your very first tool call before any probe. ' +
                'State the ordered list of sub-problems or steps you intend to work through. ' +
                'This posts a visible roadmap into the working notebook so the user can follow along. ' +
                'You may not call plan more than once per run — commit to your plan and proceed.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    steps: {
                        type: 'array',
                        description: 'Ordered list of sub-tasks or milestones, each ≤120 chars. For a trivial task ONE step is fine. 1–10 items.',
                        items: { type: 'string', maxLength: 120 },
                        minItems: 1,
                        maxItems: 10,
                    },
                    complexity: {
                        type: 'string',
                        enum: ['trivial', 'standard', 'research'],
                        description:
                            'Honest effort class. "trivial" = one or two kernel evaluations settle it ' +
                            '(a known integral, a closed form, a direct diagonalisation) — the harness ' +
                            'streamlines gates and reflection for speed. "standard" = a few dependent ' +
                            'steps. "research" = multi-stage derivation, method uncertainty, or ' +
                            'literature dependence. May be UPGRADED later via revise_plan; never downgraded.',
                    },
                    note: {
                        type: 'string',
                        description: 'Optional one-sentence comment on the overall strategy.',
                        maxLength: 300,
                    },
                },
                required: ['steps', 'complexity'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'define_util',
            description:
                'FREE. Register a verified helper function. It is evaluated into the live kernel ONCE ' +
                'and stays defined for the rest of the run. In every later probe, CALL IT BY NAME — ' +
                'the harness does NOT re-paste its body, and neither should you. The helper is ' +
                're-seeded automatically only if the kernel restarts. ' +
                'Only register after verifying the function works correctly with a probe. ' +
                'Overwrites any prior definition with the same name.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    name: {
                        type: 'string',
                        description: 'The WL symbol name of the function (e.g. "betheEqs"). No spaces.',
                        pattern: '^[a-zA-Z][a-zA-Z0-9]*$',
                        minLength: 1,
                        maxLength: 60,
                    },
                    code: {
                        type: 'string',
                        description: 'Complete WL definition, e.g. "betheEqs[\\u03bb_List] := ...".',
                        minLength: 1,
                        maxLength: 2000,
                    },
                    note: {
                        type: 'string',
                        description: 'One sentence describing what this function computes.',
                        maxLength: 200,
                    },
                },
                required: ['name', 'code', 'note'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'chain',
            description:
                'FREE — does not decrement probe_budget. ' +
                'Read the current working chain state: task inputs, recorded steps, ' +
                'registered assumptions, and utility functions. Use this to orient yourself ' +
                'after a long exploration or to check what is already recorded before probing further.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {},
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'checkpoint',
            description:
                'FREE. Commit completed steps as a named section in clean_in_progress.wb. ' +
                'Call this after finishing a self-contained sub-result to preserve it permanently — ' +
                'checkpointed sections survive even if the run is later aborted or fails. ' +
                'After calling checkpoint, you can use chain to summarise the committed state ' +
                'and then continue to the next sub-problem.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sectionTitle: {
                        type: 'string',
                        description: 'Human-readable title for this section (e.g. "M=2 sector eigenvalues").',
                        minLength: 1,
                        maxLength: 120,
                    },
                    stepIds: {
                        type: 'array',
                        description: 'List of valid recorded step IDs to include in this section.',
                        items: { type: 'string' },
                        minItems: 1,
                        maxItems: 50,
                    },
                    note: {
                        type: 'string',
                        description: 'Optional one-sentence description of what this section proves or computes.',
                        maxLength: 300,
                    },
                },
                required: ['sectionTitle', 'stepIds'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'invalidate',
            description:
                'COSTS 1 BACKTRACK (max_backtracks decrements). ' +
                'Prune a step and all steps that transitively depend on it. ' +
                'Pruned steps are marked stale in the working chain (kept as history) ' +
                'and any draft clean.wb is deleted. ' +
                'Use when a step is genuinely wrong — not just when fresh-kernel verification ' +
                'failed due to a missing dependency (the harness handles that automatically). ' +
                'After calling invalidate, return to Explore and re-probe the affected region.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    fromStepId: {
                        type: 'string',
                        description: 'The stepId of the first genuinely-wrong step. Its dependents are also pruned.',
                        minLength: 1,
                    },
                },
                required: ['fromStepId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_clean',
            description:
                'FREE — does not decrement probe_budget. ' +
                'POLISH PHASE ONLY. Restart the Wolfram kernel, then evaluate every ' +
                'Wolfram code cell in clean.wb in sequence. Returns per-cell errors and ' +
                'warnings. You MUST call this tool and receive allClean: true before ' +
                'emitting the clean_verified control signal. If any cell has errors or ' +
                'warnings, fix them with edit_cell and call run_clean again.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {},
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_cell',
            description:
                'FREE — does not decrement probe_budget. ' +
                'POLISH PHASE ONLY. Replace the Wolfram code in a cell (identified by ' +
                'its index among code cells, 0-based) in either clean.wb or working.wb. ' +
                'Use this to fix errors or warnings reported by run_clean. After editing, ' +
                'always call run_clean again to verify the fix did not introduce new issues.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    notebook: {
                        type: 'string',
                        enum: ['clean', 'working'],
                        description: '"clean" to edit clean.wb (the final notebook), "working" to edit working.wb.',
                    },
                    cellIndex: {
                        type: 'integer',
                        description: 'Zero-based index of the code cell to replace (among code cells only, ignoring markup cells). Use the cellIndex from the run_clean failure report.',
                        minimum: 0,
                    },
                    newCode: {
                        type: 'string',
                        description: 'Complete replacement Wolfram Language code for this cell. Must be correct and complete — no placeholder comments.',
                        minLength: 1,
                        maxLength: 8000,
                    },
                },
                required: ['notebook', 'cellIndex', 'newCode'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ask_specialist',
            description:
                'FREE. Ask the human specialist (user) a specific question when you are ' +
                'genuinely stuck or need clarifying information that cannot be obtained by probing. ' +
                'Use it when: (a) the TASK STATEMENT is ambiguous or underspecified (which ' +
                'representation? which convention/normalization? which boundary conditions?) — ask ' +
                'EARLY, before building on a guess; (b) literature search is exhausted and a known ' +
                'published method is essential — ask the user for a concrete reference (author, ' +
                'title, or arXiv id), then lit_read it. Use sparingly for everything else. ' +
                'The user may reply or dismiss; if dismissed, proceed with your best judgment.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    question: {
                        type: 'string',
                        description: 'A specific, focused question for the user. State clearly what information you need and why you cannot resolve it by probing.',
                        minLength: 10,
                        maxLength: 600,
                    },
                    context: {
                        type: 'string',
                        description: 'Optional: 1-2 sentences explaining what you have already tried and why you are stuck.',
                        maxLength: 400,
                    },
                },
                required: ['question'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'note_skill_gap',
            description:
                'FREE (max 2 per run). Flag a MISSING skill: you solved (or struggled through) a ' +
                'sub-problem where a reusable SkilXiv skill would have helped, but none was recalled ' +
                'or the recalled one did not apply. Records a skill request so the gap gets filled. ' +
                'Does not affect the current run — continue working after calling it.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    topic: {
                        type: 'string',
                        description: 'What the missing skill should cover (e.g. "nested Bethe ansatz solver for su(3) fundamental chains").',
                        minLength: 8,
                        maxLength: 200,
                    },
                    why: {
                        type: 'string',
                        description: 'One sentence on the gap you observed (what you had to derive from scratch, or why the recalled skill did not fit).',
                        minLength: 10,
                        maxLength: 400,
                    },
                },
                required: ['topic', 'why'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'revise_plan',
            description:
                'FREE (max 2 per run). Replace your plan when the EVIDENCE has genuinely invalidated it — ' +
                'state what changed and why, referencing a probe result. Do not silently drift from the ' +
                'plan; do not use this for cosmetic reordering.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    changes: {
                        type: 'string',
                        description: 'One sentence referencing the evidence that invalidated the plan (e.g. "p014 showed the nested-BAE route diverges; switching to the QQ-system").',
                        minLength: 15,
                        maxLength: 400,
                    },
                    steps: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'The revised ordered sub-task list (1–10 items).',
                        minItems: 1,
                        maxItems: 10,
                    },
                    complexity: {
                        type: 'string',
                        enum: ['trivial', 'standard', 'research'],
                        description: 'Optionally UPGRADE the effort class (trivial→standard→research) when the task proved harder than planned. Downgrades are ignored.',
                    },
                },
                required: ['changes', 'steps'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lit_read',
            description:
                'FREE — does not count against the 3-search literature budget (own cap: 6 reads/run). ' +
                'Deep-read ONE specific paper that research_literature already surfaced: ask a focused ' +
                'question ("what normalisation does the QQ-relation use?", "give the full form of eq (3.12) ' +
                'and the definitions around it") and get back relevant excerpts, equations WITH numbers, ' +
                'and a direct answer mined from the cached full text. Use this to mine a found paper ' +
                'progressively — do NOT re-run research_literature for details of a paper you already have. ' +
                'Everything returned is an UNVERIFIED transcription: reproduce in the kernel before recording.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    arxivId: {
                        type: 'string',
                        description: 'The arXiv id of a paper returned by research_literature this run (e.g. "1608.06504").',
                        minLength: 5,
                        maxLength: 40,
                    },
                    question: {
                        type: 'string',
                        description: 'A focused question about THIS paper — the specific relation, convention, definition, or derivation detail you need.',
                        minLength: 8,
                        maxLength: 400,
                    },
                },
                required: ['arxivId', 'question'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'finalize',
            description:
                '⚠️ DANGER: Terminate this Fairy run with status "failed" or "escalate". ' +
                'ONLY call this when computation is genuinely impossible — not when you ' +
                'have a correct result. If your chain is complete and correct, emit the ' +
                '`done_exploring` control signal as plain JSON — do NOT call finalize. ' +
                'Common mistake: calling finalize(failed) after seeing a redefinition ' +
                'conflict in `chain` output. Redefinition conflicts are resolved automatically ' +
                'by the harness — emit `done_exploring` and let the harness handle it. ' +
                'Call finalize(failed) ONLY when: computation errored with no fix, or ' +
                'the task is mathematically infeasible with the current approach. ' +
                'Call finalize(escalate) ONLY when the task is fundamentally out of scope.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    status: {
                        type: 'string',
                        enum: ['failed', 'escalate'],
                        description: '"failed" = no usable result; "escalate" = task out of scope.',
                    },
                    summary: {
                        type: 'string',
                        description: 'One-paragraph summary of what was attempted and what blocked completion.',
                        minLength: 1,
                        maxLength: 1000,
                    },
                    reason: {
                        type: 'string',
                        description: 'One-sentence specific reason for failure or escalation.',
                        minLength: 1,
                        maxLength: 400,
                    },
                },
                required: ['status', 'summary', 'reason'],
            },
        },
    },
]);

// Frozen copy delivered to each run — specs never mutate
const FROZEN_FAIRY_TOOLS = Object.freeze(JSON.parse(JSON.stringify(FAIRY_TOOL_SPECS)));

// Polish-phase tool set: run_clean, edit_cell, probe (for testing fixes),
// chain (to review the step list), finalize (to give up).
const POLISH_TOOL_NAMES = new Set(['run_clean', 'edit_cell', 'probe', 'chain', 'finalize']);
const FROZEN_POLISH_TOOLS = Object.freeze(
    JSON.parse(JSON.stringify(FAIRY_TOOL_SPECS.filter(t => POLISH_TOOL_NAMES.has(t.function.name))))
);

// ── Explore-phase tool spec (condensed descriptions, no run_clean / edit_cell) ──
//
// Same schemas as FAIRY_TOOL_SPECS but descriptions cut to 1–2 sentences.
// run_clean and edit_cell are omitted — they are never called during explore.
// Saves ~1,500 tokens per turn vs the full spec.

const EXPLORE_DESCRIPTIONS = {
    plan:        'FREE. Call ONCE as your very first tool call. List the ordered sub-tasks (ONE step is fine for a trivial task) and declare `complexity` honestly: trivial | standard | research — trivial streamlines gates and reflection.',
    revise_plan: 'FREE (max 2/run). Replace the plan when evidence invalidated it — state what changed, referencing a probe result. May UPGRADE complexity. Never silently drift from the plan.',
    probe:       'COSTS 1 PROBE. Run a WL expression in the live kernel. Returns probeId, resultPreview (≤400 chars), structuralSummary. EFFICIENCY: `cells:[c1,c2,…]` (2–4 blocks) runs several SEPARATE cells in one call for one probe — errors isolate to the failing cell, earlier cells stand; or bundle related quantities into ONE probe returning an Association; pass `record:{stepId,…}` to commit a clean result in the same call (no separate record turn).',
    amend_probe: 'CHEAP (first 2 free). Revise the immediately-preceding probe IN PLACE — to fix a failure OR refine unsatisfactory output (numeric vs symbolic, cleaner form). Iterate here instead of re-pasting the block into a new probe.',
    inspect:     'FREE. Apply a WL op to a stored probe result by probeId without re-running the kernel. Use for large outputs.',
    lookup:      'FREE. Return authoritative WL symbol documentation (usage, options, attributes).',
    record:      'FREE. Commit a successful, warning-free probe as a named step. Supply stepId and probeId ("last" = most recent ok probe). `checks`: machine-run WL verification expressions (True or |value|<tol) — a passing check satisfies the crosscheck requirement with no extra probe; a failing check rejects the record.',
    note_fact:   'FREE. Save an established RESULT (value/conclusion) to durable memory so you never re-derive it. Shown every turn under "Established results".',
    read_skill_section: 'FREE. Read one section of a recalled skill in full (the injected skill block is a capped excerpt — the tail lives here). Omit `section` to list section names.',
    cite_skill:  'FREE. Settle a recalled skill\'s disposition: "used" requires `stepIds` naming the recorded step(s) that embody it (record first, cite after; credit survives only with those steps); or disposition:"pass_over" + one-line reason if it did not help. Never cite by coincidence.',
    note_skill_gap: 'FREE (max 2/run). Flag a MISSING skill: a reusable method you had to derive from scratch because no (fitting) skill was recalled. Records a registry request; continue working after.',
    research_literature: 'FREE. Dispatch a bounded sub-agent to search papers (arXiv/INSPIRE) and return candidate equations + methods. Every equation is UNVERIFIED — reproduce with a probe before recording. Papers auto-cited at run end. Max 3 searches/run; rephrasing an empty query is rejected.',
    lit_read:    'FREE (own cap: 6/run). Deep-read ONE paper research_literature already found: focused question in, excerpts + numbered equations + direct answer out (cached full text). Mine a found paper here instead of re-searching. Also accepts up to 2 ids per run from OUTSIDE the search results (a reference the user gave via ask_specialist, or a canonical paper you know). All output is UNVERIFIED — reproduce in the kernel.',
    define_util: 'FREE. Register a verified helper used in 2+ later probes. Evaluated into the live kernel ONCE — call it BY NAME afterward; never re-paste its body.',
    assume:      'FREE. Register a mathematical side-condition (e.g. "n ∈ Integers"). Rebuilds $Assumptions in the kernel.',
    chain:       'FREE. Read current chain state: inputs, recorded steps, assumptions, and registered utilities.',
    checkpoint:  'FREE. Commit a set of valid recorded steps as a named section in clean_in_progress.wb. Call after each completed sub-result.',
    invalidate:     'COSTS 1 BACKTRACK. Mark a step and all dependents as stale. Use when a step is genuinely wrong.',
    finalize:       'Terminate this run with status "failed" or "escalate". Only call when computation is genuinely impossible.',
    ask_specialist: 'FREE. Ask the human specialist (user) when: the task statement is ambiguous (which rep/convention/boundary conditions? — ask EARLY, not after building on a guess); or literature failed and you need a concrete reference (author/title/arXiv id → lit_read it). Waits for user reply; proceed with best judgment if dismissed.',
};

const EXPLORE_TOOL_NAMES = new Set(Object.keys(EXPLORE_DESCRIPTIONS));

const EXPLORE_FAIRY_TOOL_SPECS = Object.freeze(
    JSON.parse(JSON.stringify(
        FAIRY_TOOL_SPECS
            .filter(t => EXPLORE_TOOL_NAMES.has(t.function.name))
            .map(t => ({
                ...t,
                function: {
                    ...t.function,
                    description: EXPLORE_DESCRIPTIONS[t.function.name],
                },
            }))
    ))
);

// ── Failed-probe tool set (probe + lookup only) ───────────────────────────────
// Restricted tool set after a failed probe: only probe (retry with fix) and lookup.
// Prevents the agent from recording, chaining, or finalizing while an error is unresolved.
// R7: after a failed probe, the model should FIX it (amend_probe) or look up docs,
// not open a fresh probe. probe is kept available for a genuinely new approach.
const FAILED_PROBE_TOOL_NAMES = new Set(['amend_probe', 'probe', 'lookup']);
const FROZEN_FAILED_PROBE_TOOLS = Object.freeze(
    JSON.parse(JSON.stringify(FAIRY_TOOL_SPECS.filter(t => FAILED_PROBE_TOOL_NAMES.has(t.function.name))))
);

// P2: the FIRST turn after a failure offers only the fix path — amend the broken probe
// or look up docs. A fresh `probe` returns on the next turn (for a genuine new approach).
const FAILED_PROBE_FIX_NAMES = new Set(['amend_probe', 'lookup']);
const FROZEN_FAILED_PROBE_FIX_TOOLS = Object.freeze(
    JSON.parse(JSON.stringify(FAIRY_TOOL_SPECS.filter(t => FAILED_PROBE_FIX_NAMES.has(t.function.name))))
);

// R10: record-rate soft gate. When too many clean symbol-defining probes pile up
// unrecorded, force a consolidation turn: only record / note_fact / chain / invalidate
// are offered (no fresh probe), so the agent commits results into the chain instead of
// exploring forever and delivering partial. Mirrors the failed-probe gate.
const RECORD_GATE_NAMES = new Set(['record', 'note_fact', 'chain', 'invalidate']);
const FROZEN_RECORD_GATE_TOOLS = Object.freeze(
    JSON.parse(JSON.stringify(FAIRY_TOOL_SPECS.filter(t => RECORD_GATE_NAMES.has(t.function.name))))
);

// Partial-report phase: agent writes a structured summary after budget exhaustion.
// Tools: chain (review recorded state) + write_partial_report (emit the notebook).
const WRITE_PARTIAL_REPORT_SPEC = Object.freeze({
    type: 'function',
    function: {
        name: 'write_partial_report',
        description:
            'Write clean_partial.wb — a structured partial-results report that Oberon ' +
            'can use to refactor or re-scope this task. Call chain first to review what ' +
            'was recorded, then call this tool exactly once. ' +
            'Include: what partial steps were completed, what failed and why, any open ' +
            'questions that remain unresolved, assumptions made during the run, and ' +
            'concrete recommendations for how to retry the task with a narrower scope.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                summary: {
                    type: 'string',
                    description: 'One paragraph: what the task was, how far you got, and why budget was exhausted.',
                    minLength: 1,
                    maxLength: 800,
                },
                failedAttempts: {
                    type: 'array',
                    description: 'List of things that were attempted but did not work, with the error or reason.',
                    items: { type: 'string', maxLength: 300 },
                    maxItems: 20,
                },
                openQuestions: {
                    type: 'array',
                    description: 'Questions that remain unresolved and would need to be answered for the task to complete.',
                    items: { type: 'string', maxLength: 300 },
                    maxItems: 10,
                },
                recommendations: {
                    type: 'string',
                    description: 'Concrete suggestions for Oberon: how to decompose, narrow, or re-scope the task for a successful retry.',
                    minLength: 1,
                    maxLength: 800,
                },
            },
            required: ['summary', 'recommendations'],
        },
    },
});

const PARTIAL_REPORT_TOOL_SPECS = Object.freeze([
    FAIRY_TOOL_SPECS.find(t => t.function.name === 'chain'),
    WRITE_PARTIAL_REPORT_SPEC,
]);

module.exports = {
    FAIRY_TOOL_SPECS:              FROZEN_FAIRY_TOOLS,
    EXPLORE_FAIRY_TOOL_SPECS,
    POLISH_FAIRY_TOOL_SPECS:       FROZEN_POLISH_TOOLS,
    FAILED_PROBE_TOOL_SPECS:       FROZEN_FAILED_PROBE_TOOLS,
    FAILED_PROBE_FIX_TOOL_SPECS:   FROZEN_FAILED_PROBE_FIX_TOOLS,
    RECORD_GATE_TOOL_SPECS:        FROZEN_RECORD_GATE_TOOLS,
    PARTIAL_REPORT_TOOL_SPECS,
    WRITE_PARTIAL_REPORT_SPEC,
};
