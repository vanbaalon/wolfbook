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
                'After every probe: either record it (if it succeeded and you will build on it) ' +
                'or discard it (just run the next probe). ' +
                'RULE: never assert a result from memory — run a probe and read what the kernel returns.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    code: {
                        type: 'string',
                        description: 'A single Wolfram Language expression to evaluate. Keep it focused and short.',
                        minLength: 1,
                        maxLength: 4000,
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
                },
                required: ['code', 'note'],
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
                        description: 'The probeId of the probe to promote to a step.',
                        minLength: 1,
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
                },
                required: ['stepId', 'probeId'],
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
                'FREE. Call this ONLY when a SkilXiv skill that was recalled into your context ' +
                'genuinely helped — i.e. you used its METHOD, a formula it states, or a function ' +
                'it defines. State exactly HOW it helped. This is the ONLY way a skill is credited ' +
                'as "used"; do NOT cite a skill just because it appeared in context or shares a ' +
                'word with your code. If no recalled skill actually applied to this task, do NOT ' +
                'call this — the run will instead be banked as new work.',
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
                        description: 'One sentence: specifically how the skill helped (which method/formula/function you used from it).',
                        minLength: 1,
                        maxLength: 400,
                    },
                },
                required: ['skillRef', 'how'],
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
                        description: 'Ordered list of sub-tasks or milestones, each ≤120 chars. 2–10 items.',
                        items: { type: 'string', maxLength: 120 },
                        minItems: 2,
                        maxItems: 10,
                    },
                    note: {
                        type: 'string',
                        description: 'Optional one-sentence comment on the overall strategy.',
                        maxLength: 300,
                    },
                },
                required: ['steps'],
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
                'Use sparingly — only when a blocking ambiguity prevents you from proceeding. ' +
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
    plan:        'FREE. Call ONCE as your very first tool call. List the ordered sub-tasks you plan to work through. Posts a roadmap into the working notebook.',
    probe:       'COSTS 1 PROBE. Run a WL expression in the live kernel. Returns probeId, resultPreview (≤400 chars), structuralSummary. Full result available via inspect.',
    amend_probe: 'CHEAP (first 2 free). Revise the immediately-preceding probe IN PLACE — to fix a failure OR refine unsatisfactory output (numeric vs symbolic, cleaner form). Iterate here instead of re-pasting the block into a new probe.',
    inspect:     'FREE. Apply a WL op to a stored probe result by probeId without re-running the kernel. Use for large outputs.',
    lookup:      'FREE. Return authoritative WL symbol documentation (usage, options, attributes).',
    record:      'FREE. Commit a successful, warning-free probe as a named step in the working chain. Supply stepId and probeId.',
    note_fact:   'FREE. Save an established RESULT (value/conclusion) to durable memory so you never re-derive it. Shown every turn under "Established results".',
    cite_skill:  'FREE. Cite a recalled SkilXiv skill ONLY if its method/formula genuinely helped (state how). The only way a skill is credited as "used". Do not cite by coincidence.',
    research_literature: 'FREE. Dispatch a bounded sub-agent to search papers (arXiv/INSPIRE) and return candidate equations + methods. Every equation is UNVERIFIED — reproduce with a probe before recording. Papers auto-cited at run end. Max 3 searches/run; rephrasing an empty query is rejected.',
    define_util: 'FREE. Register a verified helper used in 2+ later probes. Evaluated into the live kernel ONCE — call it BY NAME afterward; never re-paste its body.',
    assume:      'FREE. Register a mathematical side-condition (e.g. "n ∈ Integers"). Rebuilds $Assumptions in the kernel.',
    chain:       'FREE. Read current chain state: inputs, recorded steps, assumptions, and registered utilities.',
    checkpoint:  'FREE. Commit a set of valid recorded steps as a named section in clean_in_progress.wb. Call after each completed sub-result.',
    invalidate:     'COSTS 1 BACKTRACK. Mark a step and all dependents as stale. Use when a step is genuinely wrong.',
    finalize:       'Terminate this run with status "failed" or "escalate". Only call when computation is genuinely impossible.',
    ask_specialist: 'FREE. Ask the human specialist a specific question when genuinely stuck on a blocking ambiguity. Waits for user reply; proceed with best judgment if dismissed.',
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
