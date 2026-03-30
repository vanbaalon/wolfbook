# @wolfteam Chat Participant — Implementation Plan

## Design Philosophy

Wolfbook already ships a basic `@wolfbook` chat participant — a tool-forwarding agent that follows instructions, calls Wolfbook tools, and returns results. It works well for direct commands ("evaluate this", "insert a cell", "look up Plot options").

**`@wolfteam` is a different thing entirely.** It is a collaborative research partner that:
- Plans calculations with the user before executing
- Asks at conceptual decision points (not mechanical ones)
- Tracks progress with a visible to-do list
- Summarises results and keeps the session alive
- Uses `@wolfbook`'s tools under the hood but adds an interaction layer on top

The two participants coexist. `@wolfbook` is the quick, terse tool operator. `@wolfteam` is the thoughtful collaborator. Users pick whichever fits their current task.

---

## Architecture

```
                      ┌─────────────────────────────────┐
                      │         @wolfteam handler        │
                      │  (system prompt, agentic loop,   │
                      │   follow-ups, buttons, hooks)    │
                      └──────────┬──────────────────────┘
                                 │ delegates to
                      ┌──────────▼──────────────────────┐
                      │    Wolfbook tool layer           │
                      │  (same tools @wolfbook uses:     │
                      │   eval, insert, context, etc.)   │
                      └──────────┬──────────────────────┘
                                 │
                      ┌──────────▼──────────────────────┐
                      │   WSTP kernel bridge / notebook  │
                      └─────────────────────────────────┘
```

`@wolfteam` does NOT wrap `@wolfbook` — it accesses the same underlying tools directly. They are sibling participants sharing the same tool backend.

---

## Stage 0 — Scaffolding & Registration

**Goal:** Separate `@wolfteam` participant registered alongside existing `@wolfbook`, responds to messages, no tools yet.

- [ ] Add second entry in `package.json` under `contributes.chatParticipants`:
  ```json
  {
    "id": "wolfbook.team",
    "name": "wolfteam",
    "fullName": "Wolfteam — Collaborative Research Assistant",
    "description": "Plan and execute calculations together. Thinks out loud, asks at decision points, tracks progress.",
    "isSticky": true,
    "commands": [
      { "name": "plan", "description": "Plan a multi-step calculation" },
      { "name": "check", "description": "Sanity-check the current result" },
      { "name": "summarise", "description": "Summarise the calculation so far" },
      { "name": "clean", "description": "Clean up notebook: remove failed cells, reorder" },
      { "name": "export", "description": "Export successful calculation path as clean cells" },
      { "name": "back", "description": "Go back to a previous step or try alternative approach" }
    ]
  }
  ```
- [ ] Create `src/chat/wolfteam.ts` — new handler, separate from existing `@wolfbook` handler
- [ ] Register in `src/extension.ts` activation alongside the existing `@wolfbook` participant
- [ ] Set distinct icon (differentiate visually from `@wolfbook`)
- [ ] Verify: `@wolfteam hello` streams a response; `@wolfbook hello` still works independently

**Key principle:** `@wolfbook`'s code is untouched. All new code lives under `src/chat/wolfteam/`.

---

## Stage 1 — System Prompt & Conversation Management

**Goal:** The collaborative persona with dynamic prompt tiers and history threading.

- [ ] Create `src/chat/wolfteam/prompts.ts`:
  - `FULL_PROMPT` — complete prompt from `wolfbook-chat-prompt.md`: persona, 5-step workflow, tool reference, WL essentials, pitfalls
  - `COMPACT_PROMPT` — persona + workflow + tool table only (~40% of full)
  - `REFRESH_PROMPT` — persona + workflow + decision-point rules (~60% of full, re-injected periodically)
  - Slash command overlays: e.g. `/check` prepends "Focus on dimensional consistency, symmetry, known limits, unexpected zeros. Report issues clearly."
- [ ] Prompt selection logic in handler:
  ```ts
  const turns = context.history.filter(h => h instanceof vscode.ChatResponseTurn).length;
  const prompt = turns === 0       ? FULL_PROMPT
               : turns % 8 === 0   ? REFRESH_PROMPT
               :                     COMPACT_PROMPT;
  ```
- [ ] Thread conversation history into LLM messages:
  - Filter `context.history` for turns where participant is `wolfbook.team`
  - For `ChatRequestTurn`: include user message
  - For `ChatResponseTurn`: include assistant response + extract metadata from `result`
  - Apply token budget: keep recent turns in full, older turns summarised (plan + result only, drop tool call details)
- [ ] First-turn greeting: stream one line ("I'm Wolfteam — let me take a look at your notebook and we'll figure this out together.") then immediately proceed to address the request
- [ ] Detect slash commands via `request.command`, prepend overlay to system prompt

---

## Stage 2 — Tool Integration (Shared with @wolfbook)

**Goal:** `@wolfteam` can call all `#wolfbook*` tools. No new tools needed — reuse existing registrations.

- [ ] Verify all Wolfbook tools are registered as `languageModelTools` in `package.json` with `canBeReferencedInPrompt: true` (this should already be done for `@wolfbook`)
- [ ] In `@wolfteam` handler, collect tool references and pass to the LLM:
  - Option A (**recommended to start**): use `@vscode/chat-extension-utils` library — `sendChatParticipantRequest` with `tools` array and `responseStreamOptions` for automatic streaming. Handles the agentic loop (LLM calls tool → gets result → decides next action) out of the box.
  - Option B (upgrade later if needed): manual agentic loop for finer control — lets us inject `stream.markdown("Let me check the notebook state...")` before each tool call
- [ ] Pass `request.toolInvocationToken` so tool invocations render inline in chat UI
- [ ] Add `@vscode/chat-extension-utils` as a dependency: `npm install @vscode/chat-extension-utils`
- [ ] Verify: `@wolfteam "what's in my notebook?"` → calls `#wolfbookContext`, summarises contents, asks what the user wants to work on

---

## Stage 3 — Follow-Up Provider (Core Interactivity Engine)

**Goal:** After every response, offer context-aware clickable next steps. This is what makes `@wolfteam` feel collaborative.

- [ ] Define metadata types in `src/chat/wolfteam/metadata.ts`:
  ```ts
  interface WolfteamResultMetadata {
    mode: 'planning' | 'executing' | 'reviewing' | 'waiting_for_choice' | 'idle';
    plan?: { steps: string[]; currentStep: number };
    pendingChoice?: { question: string; options: string[] };
    lastComputation?: { cellNumbers: number[]; summary: string };
    toolsUsed?: string[];
    turnCount?: number;
  }
  ```
- [ ] Instruct LLM (in system prompt) to emit a structured status block at the end of each response:
  ```
  At the very end of your response, emit a single line in this exact format:
  <<STATUS mode="planning" pendingChoice="gauge choice|Lorenz gauge|Coulomb gauge|axial gauge">>
  This line will be hidden from the user and used to generate follow-up suggestions.
  ```
- [ ] In handler: intercept streamed output, strip `<<STATUS ...>>` line, parse into `WolfteamResultMetadata`, return as `ChatResult.metadata`
- [ ] Implement `src/chat/wolfteam/followups.ts`:
  ```ts
  function provideFollowups(result, context, token): vscode.ChatFollowup[] {
    const meta = result.metadata as WolfteamResultMetadata;
    switch (meta?.mode) {
      case 'planning':
        return [
          { prompt: 'Looks good, go ahead', label: '✓ Approve plan' },
          { prompt: 'I\'d like to modify the plan', label: '✏ Modify' },
          { prompt: 'Let\'s try a completely different approach', label: '↻ Different approach' }
        ];
      case 'executing':
        return [
          { prompt: 'Continue to the next step', label: '→ Next step' },
          { prompt: 'Pause, I want to inspect this', label: '⏸ Pause & inspect' },
          { prompt: 'Something looks wrong here', label: '⚠ This looks wrong' }
        ];
      case 'reviewing':
        return [
          { prompt: 'Save these results and move on', label: '💾 Save & continue' },
          { prompt: 'Can you extend this further?', label: '🔄 Extend' },
          { prompt: 'Let\'s start a new calculation', label: '🆕 New task' }
        ];
      case 'waiting_for_choice':
        // Dynamic: generate from the options the LLM proposed
        return (meta.pendingChoice?.options ?? []).map((opt, i) => ({
          prompt: opt,
          label: `${i + 1}. ${opt}`
        }));
      default:
        return [
          { prompt: 'What\'s currently in my notebook?', label: '📓 Show notebook' },
          { prompt: 'Help me with a calculation', label: '🧮 New calculation' }
        ];
    }
  }
  ```
- [ ] Wire up: `participant.followupProvider = { provideFollowups }`
- [ ] Test end-to-end: ask for a multi-step computation → agent presents plan → follow-up "Approve plan" appears → click it → agent executes step 1 → follow-up "Next step" appears → etc.

---

## Stage 4 — Buttons for In-Stream Actions

**Goal:** Clickable action buttons embedded in responses, complementing follow-ups.

- [ ] Register VS Code commands (prefixed `wolfteam.` to avoid collision with `wolfbook.`):
  - `wolfteam.insertResult` — insert a displayed expression as a new notebook cell
  - `wolfteam.simplifyResult` — re-evaluate with `Simplify[]` wrapper, show result
  - `wolfteam.saveCheckpoint` — save notebook to disk
  - `wolfteam.abortKernel` — abort running evaluation
  - `wolfteam.approvePlan` — approve and begin executing the proposed plan
- [ ] Button injection strategy (choose one):
  - **Option A (prompt-driven):** instruct LLM to emit markers like `<<BUTTON:insertResult>>`. Handler strips markers and emits `stream.button(...)`.
  - **Option B (heuristic):** handler detects patterns in streamed markdown (e.g. a fenced Mathematica code block followed by "Result:") and auto-appends relevant buttons.
  - **Recommend Option B** — less fragile, doesn't depend on LLM following marker format reliably.
- [ ] Button placements:
  - After any computation result shown in chat: `[Insert into notebook]` `[Simplify]`
  - After a plan is presented: `[Approve and run]`
  - During long-running evaluation report: `[Abort]` `[Wait longer]`
  - At task completion: `[Save notebook]`

---

## Stage 5 — Agent Hooks

**Goal:** Safety guardrails and quality enforcement when tools are invoked.

- [ ] Create `.vscode/wolfteam-hooks.json` (or add to existing hooks config):
  ```json
  {
    "hooks": {
      "PreToolUse": [{
        "type": "command",
        "command": "node ./scripts/hooks/wolfteam-pre-tool.js",
        "timeout": 10
      }],
      "PostToolUse": [{
        "type": "command",
        "command": "node ./scripts/hooks/wolfteam-post-tool.js"
      }]
    }
  }
  ```
- [ ] `PreToolUse` rules:
  - `wolfbookRestart` → `permissionDecision: "prompt"` (always confirm with user)
  - `wolfbookDelete` with >3 cells → `permissionDecision: "prompt"`
  - `wolfbookEval` containing `DeleteFile`, `DeleteDirectory`, `Run`, `RunProcess` → deny
  - All others → `permissionDecision: "allow"`
- [ ] `PostToolUse` rules:
  - `wolfbookRun` / `wolfbookEval` result contains `⚠ Kernel messages` → inject `systemMessage`: "The last evaluation produced errors. Fix them before proceeding."
  - `wolfbookInsertMany` with >5 cells → inject `systemMessage`: "Many cells inserted. Pause and ask the user to review before continuing."
- [ ] Optional `UserPromptSubmit` hook: if user message references cell numbers or symbol names, auto-inject a fresh `#wolfbookContext` summary into the request context

---

## Stage 6 — State Persistence & Backtracking

**Goal:** "Go back" / "undo last step" / "try the other approach" within a session.

- [ ] Extend `WolfteamResultMetadata` with history stack:
  ```ts
  history?: {
    branches: Array<{
      step: number;
      description: string;
      cellsCreated: number[];
      symbolsModified?: string[];
    }>;
    currentBranch: number;
  };
  ```
- [ ] On each notebook-modifying tool call (insert, edit, delete), record the mutation in metadata passed through `ChatResult`
- [ ] `/back` slash command: reads history from `context.history`, finds the previous metadata, presents branch points as follow-ups
- [ ] Backtracking mechanics:
  - Delete cells created after the target step (`#wolfbookDelete`)
  - Optionally re-evaluate from a clean point (`#wolfbookRunAll` on the surviving cells)
  - LLM resumes from the branch point with the alternative choice
- [ ] Auto-save before major branches: call `#wolfbookSaveNotebook` so there's always a file-level recovery point
- [ ] System prompt instruction: "When the user says 'go back' or 'try the other approach', use `#wolfbookDelete` to remove cells from the abandoned path, then resume from the branch point."

---

## Stage 7 — Participant Detection & Disambiguation

**Goal:** VS Code auto-routes appropriate questions to `@wolfteam` (not `@wolfbook`).

- [ ] Add `disambiguation` to the `@wolfteam` entry in `package.json`:
  ```json
  "disambiguation": [
    {
      "category": "collaborative_calculation",
      "description": "Multi-step calculations that benefit from planning and discussion",
      "examples": [
        "Help me compute the Ricci tensor for this metric",
        "Let's derive the equations of motion",
        "I want to set up a perturbation expansion",
        "Can we work through this integral step by step?"
      ]
    },
    {
      "category": "notebook_review",
      "description": "Reviewing, checking, or reorganising notebook calculations",
      "examples": [
        "Does this result look right?",
        "Summarise what we've computed so far",
        "Clean up the notebook and remove dead ends"
      ]
    }
  ]
  ```
- [ ] Keep `@wolfbook` disambiguation focused on direct tool actions:
  ```json
  "disambiguation": [
    {
      "category": "wolfram_direct",
      "description": "Direct Wolfram Language evaluation, lookup, or cell manipulation",
      "examples": [
        "Evaluate this expression",
        "What does FoldList do?",
        "Run cell 5",
        "Insert this code"
      ]
    }
  ]
  ```
- [ ] Result: "help me compute X" → routes to `@wolfteam`; "evaluate X" → routes to `@wolfbook`

---

## Stage 8 — Telemetry & Feedback

**Goal:** Measure what works, iterate.

- [ ] Wire up `participant.onDidReceiveFeedback`:
  ```ts
  participant.onDidReceiveFeedback((feedback) => {
    logger.logUsage('wolfteam.feedback', {
      helpful: feedback.kind === vscode.ChatResultFeedbackKind.Helpful,
      mode: feedback.result.metadata?.mode,
      turnCount: feedback.result.metadata?.turnCount,
      toolsUsed: feedback.result.metadata?.toolsUsed,
    });
  });
  ```
- [ ] Track:
  - Turns to task completion
  - Follow-up click rate (clicked vs. user typed freely)
  - Which tools error most often
  - Abandonment point (last mode before session ends)
  - Plan approval rate (how often users modify vs. approve as-is)
- [ ] Feedback loop: if follow-up click rate is low for a given mode, those follow-ups need rewording

---

## Implementation Order & Dependencies

```
Stage 0 ──→ Stage 1 ──→ Stage 2 ──→ Stage 3 ──→ Stage 4
(scaffold)   (prompts)   (tools)    (follow-ups)  (buttons)
                                        │
                                        ├──→ Stage 5 (hooks)
                                        ├──→ Stage 6 (backtracking)
                                        ├──→ Stage 7 (disambiguation)
                                        └──→ Stage 8 (telemetry)
```

**Critical path:** Stages 0–3. Ship and test after Stage 3 — that's already a functional collaborative agent.
**High-value polish:** Stage 4 (buttons).
**Parallel/later:** Stages 5–8, any order.

---

## File Structure

All new code under `src/chat/wolfteam/` — completely separate from existing `@wolfbook` code.

```
src/chat/wolfteam/
├── participant.ts       # Handler registration, main request handler, agentic loop
├── prompts.ts           # System prompts: full, compact, refresh, slash command overlays
├── metadata.ts          # WolfteamResultMetadata type, parser for <<STATUS>> blocks
├── followups.ts         # Follow-up provider: mode → suggested next steps
├── buttons.ts           # Command registration for in-stream buttons
└── hooks/
    ├── pre-tool-use.js  # PreToolUse safety checks
    └── post-tool-use.js # PostToolUse error detection & pause triggers
```

Update `package.json` (new participant + commands) and `src/extension.ts` (register second participant).

---

## Relationship Between @wolfbook and @wolfteam

| Aspect | @wolfbook | @wolfteam |
|--------|-----------|-----------|
| Persona | Terse tool operator | Collaborative research partner |
| Initiative | Executes what's asked | Plans, proposes, asks before acting |
| Follow-ups | None (or minimal) | Rich, mode-dependent |
| Decision points | Plows through | Stops and consults user |
| Progress tracking | None | To-do list with ✅ updates |
| Session continuity | One-shot | Keeps session alive, asks "what next?" |
| Best for | "Evaluate X", "Look up Y", "Run cell 5" | "Help me derive the EOM for this action" |
| System prompt | Tool-focused (existing) | Persona + workflow + tools |
| Code location | `src/chat/` (existing) | `src/chat/wolfteam/` (new) |

Both share the same tool backend. A user can even switch mid-conversation: use `@wolfteam` to plan and set things up, then `@wolfbook` for quick follow-up evaluations.

---

## Open Questions

1. **`chat-extension-utils` vs manual agentic loop?** Start with the library (Stage 2). If we need to inject `stream.markdown()` explanations between tool calls (crucial for "think out loud" persona), switch to manual loop. Evaluate after Stage 3.
2. **Model selection:** Respect `request.model` (user's choice). Document that Claude models tend to perform best for WL tasks. Don't override.
3. **Token budget for long sessions:** Physics calculations produce huge history. Strategy: keep plans and final results at high priority, drop intermediate tool call details. The `History` component from `chat-extension-utils` supports priority-based pruning — use it.
4. **`<<STATUS>>` parsing reliability:** The LLM may not always emit the status block perfectly. Implement fallback: if no `<<STATUS>>` found, infer mode heuristically (last message ends with "?" → `waiting_for_choice`; contains "✅" on all steps → `reviewing`; contains "☐" → `executing`; else `idle`).
5. **Future participants:** The `wolfteam` name leaves room for expansion — e.g. `@wolfteam /debug` could become a dedicated debugging persona, `@wolfteam /teach` a tutorial mode. These are slash command extensions, not new participants, keeping the namespace clean.

---
---

# Improvement Round 1 — Continuous Response with In-Loop User Interaction

## Problem

After initial implementation, `@wolfteam` breaks the chat response whenever it needs user input (plan approval, decision points). Each follow-up click starts a **new response turn**, which:
- Resets the visual flow (the user sees a new "assistant" bubble)
- Costs an additional LLM call (re-sends full history + system prompt)
- Loses the "continuous session" feel that the built-in Copilot agent has

The built-in GitHub Copilot agent doesn't have this problem. It runs a `ToolCallingLoop` inside `DefaultIntentRequestHandler` that handles confirmations inline — the loop pauses, the user clicks "Allow", and the loop resumes, all within a single response. But that's **private internal API**, not available to third-party chat participants.

## Root Cause

The public `ChatRequestHandler` contract is: handler is called → handler streams response → handler returns `ChatResult` → response is done. There is no `await userInput()` primitive.

However, **tool confirmations** do work inline. When a tool registered via `vscode.lm.registerTool` uses `prepareInvocation` to request confirmation, the confirmation UI renders inside the chat, the user approves, and the tool calling loop (both the internal one and the one in `@vscode/chat-extension-utils`) continues without ending the response.

## Solution: Model User Interaction Points as Tools with Confirmation

Instead of having the LLM output a plan as text and then relying on follow-ups, register **interaction tools** that the LLM calls when it needs user input. The tool's confirmation mechanism becomes the inline interaction point.

### Instructions for Copilot

**Task:** Refactor `@wolfteam` so that plan approval, decision points, and other user consultations happen via tool confirmations within a single response turn, rather than via follow-ups that start new turns.

#### Step 1 — Create `src/chat/wolfteam/interactionTools.ts`

Register three interaction tools. These are NOT Wolfbook kernel tools — they are pure interaction tools that exist only to create inline confirmation checkpoints.

```ts
import * as vscode from 'vscode';

/**
 * Tool: wolfteam_proposePlan
 *
 * The LLM calls this when it has formulated a multi-step plan and wants
 * user approval before executing. The confirmation UI shows the plan
 * and the user clicks "Allow" to approve or "Deny" to reject.
 *
 * Input schema:
 *   { planSummary: string, steps: string[] }
 *
 * The tool itself does nothing — it exists purely for the confirmation
 * side effect. It returns "Plan approved" or throws on denial.
 */
export class ProposePlanTool implements vscode.LanguageModelTool<{ planSummary: string; steps: string[] }> {

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<{ planSummary: string; steps: string[] }>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { planSummary, steps } = options.input;
        const stepsMarkdown = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
        return {
            invocationMessage: 'Proposing calculation plan...',
            confirmationMessages: {
                title: 'Approve Plan',
                message: new vscode.MarkdownString(
                    `## Proposed Plan\n${planSummary}\n\n### Steps\n${stepsMarkdown}\n\n**Proceed with this plan?**`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<{ planSummary: string; steps: string[] }>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        // If we get here, user approved. Return confirmation to LLM.
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Plan approved by user. ${options.input.steps.length} steps to execute. Proceed with step 1.`
            ),
        ]);
    }
}

/**
 * Tool: wolfteam_askDecision
 *
 * The LLM calls this at conceptual decision points (gauge choice,
 * coordinate system, expansion strategy, etc.). The confirmation UI
 * presents the question and options. The user's choice flows back
 * as the tool result.
 *
 * Input schema:
 *   { question: string, options: string[], context?: string }
 *
 * IMPORTANT: Since the standard confirmation UI is binary (Allow/Deny),
 * we format the options into the confirmation message and instruct
 * the user to type their choice. Alternatively, if VS Code adds
 * richer confirmation UI in the future, adapt this.
 *
 * Current workaround: present options in the confirmation message.
 * The tool always "succeeds" (user clicked Allow), and we instruct
 * the LLM to treat the first option as the default if the user
 * simply approved without modification.
 *
 * BETTER ALTERNATIVE if available: use the tool's input parameter
 * editing feature — VS Code lets users expand tool parameters and
 * edit them before clicking Allow. So we put the default choice in
 * an editable `selectedOption` field. The user can change it.
 */
export class AskDecisionTool implements vscode.LanguageModelTool<{
    question: string;
    options: string[];
    defaultOption: string;
    context?: string;
}> {

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<{
            question: string;
            options: string[];
            defaultOption: string;
            context?: string;
        }>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { question, options: opts, context } = options.input;
        const optionsMarkdown = opts.map((o, i) => `${i + 1}. **${o}**`).join('\n');
        const contextLine = context ? `\n\n_Context: ${context}_` : '';
        return {
            invocationMessage: `Decision point: ${question}`,
            confirmationMessages: {
                title: 'Decision Required',
                message: new vscode.MarkdownString(
                    `### ${question}${contextLine}\n\n${optionsMarkdown}\n\n` +
                    `The default is **${options.input.defaultOption}**. ` +
                    `To choose a different option, expand the tool parameters and edit \`selectedOption\` before clicking Allow.`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<{
            question: string;
            options: string[];
            defaultOption: string;
            context?: string;
        }>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        // The selectedOption field may have been edited by the user via
        // the parameter editing UI. If not, it contains the default.
        const choice = (options.input as any).selectedOption || options.input.defaultOption;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `User chose: "${choice}" for the question "${options.input.question}". Proceed accordingly.`
            ),
        ]);
    }
}

/**
 * Tool: wolfteam_checkpoint
 *
 * Lightweight "pause and show progress" tool. The LLM calls this
 * after completing a significant step to show intermediate results
 * and get a quick go/no-go. Lower friction than askDecision.
 *
 * Input schema:
 *   { stepCompleted: string, result: string, nextStep: string }
 */
export class CheckpointTool implements vscode.LanguageModelTool<{
    stepCompleted: string;
    result: string;
    nextStep: string;
}> {

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<{
            stepCompleted: string;
            result: string;
            nextStep: string;
        }>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { stepCompleted, result, nextStep } = options.input;
        return {
            invocationMessage: `✅ ${stepCompleted}`,
            confirmationMessages: {
                title: 'Continue?',
                message: new vscode.MarkdownString(
                    `### ✅ ${stepCompleted}\n\n**Result:**\n${result}\n\n` +
                    `**Next:** ${nextStep}\n\nClick **Allow** to continue, or **Deny** to pause and inspect.`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<{
            stepCompleted: string;
            result: string;
            nextStep: string;
        }>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `User confirmed. Step "${options.input.stepCompleted}" complete. Proceed with: ${options.input.nextStep}`
            ),
        ]);
    }
}
```

#### Step 2 — Register the tools in `package.json`

Add to `contributes.languageModelTools`:

```json
[
  {
    "name": "wolfteam_proposePlan",
    "displayName": "Propose Calculation Plan",
    "modelDescription": "Call this tool when you have formulated a multi-step calculation plan and need the user to approve it before you begin executing. Pass the plan summary and list of steps. The user will see the plan and confirm. Do NOT execute any steps until this tool returns successfully.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "planSummary": { "type": "string", "description": "One-paragraph summary of what the plan will accomplish" },
        "steps": { "type": "array", "items": { "type": "string" }, "description": "Ordered list of steps to execute" }
      },
      "required": ["planSummary", "steps"]
    },
    "tags": ["wolfteam"],
    "canBeReferencedInPrompt": false
  },
  {
    "name": "wolfteam_askDecision",
    "displayName": "Ask User Decision",
    "modelDescription": "Call this tool when you reach a conceptual decision point — a choice of gauge, coordinate system, ansatz, expansion strategy, or any fork where the user's physics expertise should guide the direction. Present the question, the available options, and a default. The user will confirm or change the choice. Do NOT guess — always call this tool at decision points.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "question": { "type": "string", "description": "The decision question" },
        "options": { "type": "array", "items": { "type": "string" }, "description": "Available choices (2-5 options)" },
        "defaultOption": { "type": "string", "description": "Your recommended default choice" },
        "selectedOption": { "type": "string", "description": "The user's selected option (editable by user before approval)" },
        "context": { "type": "string", "description": "Brief context for why this decision matters" }
      },
      "required": ["question", "options", "defaultOption"]
    },
    "tags": ["wolfteam"],
    "canBeReferencedInPrompt": false
  },
  {
    "name": "wolfteam_checkpoint",
    "displayName": "Progress Checkpoint",
    "modelDescription": "Call this tool after completing a significant calculation step to show the user the intermediate result and what comes next. The user confirms to continue or denies to pause. Use this between major steps, not after every trivial evaluation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "stepCompleted": { "type": "string", "description": "What was just completed" },
        "result": { "type": "string", "description": "The key result or output (keep concise)" },
        "nextStep": { "type": "string", "description": "What will be done next if user approves" }
      },
      "required": ["stepCompleted", "result", "nextStep"]
    },
    "tags": ["wolfteam"],
    "canBeReferencedInPrompt": false
  }
]
```

#### Step 3 — Register tool handlers in extension activation

In `src/extension.ts` (or `src/chat/wolfteam/participant.ts` activation):

```ts
import { ProposePlanTool, AskDecisionTool, CheckpointTool } from './wolfteam/interactionTools';

// Register interaction tools
context.subscriptions.push(
    vscode.lm.registerTool('wolfteam_proposePlan', new ProposePlanTool()),
    vscode.lm.registerTool('wolfteam_askDecision', new AskDecisionTool()),
    vscode.lm.registerTool('wolfteam_checkpoint', new CheckpointTool()),
);
```

#### Step 4 — Include interaction tools in the tool set passed to `sendChatParticipantRequest`

In `src/chat/wolfteam/participant.ts`, when building the tools array:

```ts
const wolfbookTools = vscode.lm.tools.filter(t => t.tags.includes('wolfbook'));
const wolfteamTools = vscode.lm.tools.filter(t => t.tags.includes('wolfteam'));
const allTools = [...wolfbookTools, ...wolfteamTools];

const libResult = chatUtils.sendChatParticipantRequest(
    request,
    chatContext,
    {
        prompt: systemPrompt,
        responseStreamOptions: { stream, references: true, responseText: true },
        tools: allTools,
    },
    token
);
```

#### Step 5 — Update the system prompt

Add this section to the system prompt in `src/chat/wolfteam/prompts.ts` (insert into the WORKFLOW section, replacing the old "present follow-ups" approach for plan approval and decisions):

```
## INTERACTION TOOLS — How to Consult the User Without Breaking the Session

You have three special tools for user interaction. These are NOT Wolfbook kernel tools.
They create inline confirmation checkpoints that the user approves/denies without
starting a new chat turn.

### `wolfteam_proposePlan`
Call BEFORE executing any multi-step plan. Pass your plan summary and step list.
The user sees the plan in a confirmation dialog and clicks Allow to approve.
Do NOT start executing steps until this tool returns "Plan approved".
If the user denies, ask what they'd like to change.

### `wolfteam_askDecision`
Call at conceptual decision points: gauge choice, coordinate system, ansatz,
expansion strategy, which terms to keep symbolic, etc.
Pass the question, options (2-5), and your recommended default.
The user can edit the `selectedOption` parameter before clicking Allow.
The tool returns the user's actual choice — proceed accordingly.

### `wolfteam_checkpoint`
Call after completing a major step to show the result and get go/no-go.
Not every step — only significant milestones where the user should verify.
The user clicks Allow to continue or Deny to pause and inspect.

### When to use these vs. just proceeding:
- Simple evaluation the user asked for → just do it, no checkpoint needed
- Looking up syntax → just do it
- Multi-step plan → ALWAYS use wolfteam_proposePlan first
- Choice of gauge/coords/ansatz → ALWAYS use wolfteam_askDecision
- Unexpected result (zero, divergence, wrong symmetry) → use wolfteam_askDecision
  with options like "1. This is correct (Ricci-flat)", "2. Sign error, let me check",
  "3. Something else"
- Completed a major calculation block → use wolfteam_checkpoint
```

#### Step 6 — Reduce follow-up provider scope

Follow-ups are now only for **post-completion** suggestions, not for mid-task interaction. Update `src/chat/wolfteam/followups.ts`:

- Remove `'planning'` and `'waiting_for_choice'` modes — these are now handled by tool confirmations inline
- Keep `'reviewing'` mode follow-ups (task is done, suggest next steps)
- Keep `'idle'` mode follow-ups (session start suggestions)
- Keep `'executing'` mode but only for the case where the response actually ended mid-execution (e.g. timeout, error) — not for normal checkpoints

```ts
function provideFollowups(result, context, token): vscode.ChatFollowup[] {
    const meta = result.metadata as WolfteamResultMetadata;
    switch (meta?.mode) {
        case 'reviewing':
            return [
                { prompt: 'Save these results and move on', label: '💾 Save & continue' },
                { prompt: 'Can you extend this further?', label: '🔄 Extend' },
                { prompt: 'Let\'s start a new calculation', label: '🆕 New task' },
            ];
        case 'error':
            return [
                { prompt: 'Try a different approach', label: '↻ Different approach' },
                { prompt: 'Debug this step', label: '🔍 Debug' },
            ];
        default:
            return [
                { prompt: 'What\'s currently in my notebook?', label: '📓 Show notebook' },
                { prompt: 'Help me with a calculation', label: '🧮 New calculation' },
            ];
    }
}
```

#### Step 7 — Remove `<<STATUS>>` parsing for interaction modes

The `<<STATUS>>` block parsing from Stage 3 is no longer needed for `planning` and `waiting_for_choice` modes since those interactions happen inline via tools. Simplify `metadata.ts`:

- The handler only needs to detect `reviewing` (all steps done), `error` (something failed), or `idle` (default)
- This can be inferred from the tool call history in the result metadata rather than parsing LLM output

#### Step 8 — Test the full flow

Verify this end-to-end scenario works as a **single continuous response**:

1. User: "Help me compute the Ricci tensor for the Schwarzschild metric"
2. LLM calls `wolfbookContext` → reads notebook
3. LLM streams: "I see an empty notebook. Let me set up a plan..."
4. LLM calls `wolfteam_proposePlan` with steps → **confirmation UI appears inline**
5. User clicks Allow
6. LLM calls `wolfbookInsertMany` to create metric definition cell
7. LLM calls `wolfbookRun` on that cell
8. LLM calls `wolfteam_checkpoint` with result → **confirmation UI appears inline**
9. User clicks Allow
10. LLM continues with Christoffel symbols...
11. LLM calls `wolfteam_askDecision` because result is unexpectedly simple → **decision UI appears inline**
12. User selects an option
13. LLM continues to completion
14. LLM streams summary
15. Handler returns with `mode: 'reviewing'` → follow-ups offer "Save & continue" / "Extend" / "New task"

All of steps 2–14 happen in a **single chat response bubble**. Only step 15 (the post-completion follow-ups) starts a new turn if clicked.

### Important Caveat

The tool confirmation UI is somewhat limited — it's essentially Allow/Deny with an optional parameter editing panel. For richer decision UIs (e.g. a proper multi-choice selector), this is a known VS Code API limitation. The `selectedOption` editable parameter is a workaround. If VS Code adds richer tool confirmation UI in the future, these tools should be updated to use it.

If the Allow/Deny + parameter editing pattern proves too clunky for decision points, fall back to the follow-up approach for `wolfteam_askDecision` only, keeping `wolfteam_proposePlan` and `wolfteam_checkpoint` as inline tools. This is a UX judgement call after testing.

### Files Changed

| File | Change |
|------|--------|
| `src/chat/wolfteam/interactionTools.ts` | **NEW** — ProposePlanTool, AskDecisionTool, CheckpointTool classes |
| `package.json` | Add 3 entries to `contributes.languageModelTools` |
| `src/extension.ts` | Register 3 interaction tool handlers |
| `src/chat/wolfteam/participant.ts` | Include `wolfteam`-tagged tools in tool set |
| `src/chat/wolfteam/prompts.ts` | Add "Interaction Tools" section to system prompt, remove old follow-up-based interaction instructions |
| `src/chat/wolfteam/followups.ts` | Simplify: remove `planning` and `waiting_for_choice` modes |
| `src/chat/wolfteam/metadata.ts` | Simplify: remove `<<STATUS>>` parsing for interaction modes |

---
---

# Improvement Round 2 — Fix Two Bugs: Status Tag Leaking + LLM Ending Response Prematurely

## Observed Problems

Screenshot shows two distinct bugs after Round 1 implementation:

### Bug A: `<<STATUS mode="reviewing">>` is visible to the user

The LLM is emitting the status tag as instructed, but the handler is **not stripping it** from the streamed output before it reaches the chat UI. The user sees raw `<<STATUS mode="reviewing">>` text in the response.

### Bug B: The LLM still finishes the response instead of keeping the session alive

After completing a task, the LLM writes "Everything is saved. What's the next step?" and then **stops** (emits the status tag, handler returns). The follow-ups appear ("Show notebook", "New calculation"), but clicking them starts a **new turn** — which costs tokens and breaks the visual flow.

The root cause: the LLM treats "What's the next step?" as a closing statement, not as a tool call that would keep the loop running. The interaction tools from Round 1 solve the mid-task problem (plan approval, decisions), but they don't address the **end-of-task continuation** problem.

## Instructions for Copilot

### Fix A — Strip `<<STATUS>>` from streamed output

**The `<<STATUS>>` mechanism is being removed entirely.** It was a fragile approach — the LLM doesn't reliably emit it, and stripping it from a streaming response (where it might arrive across chunk boundaries) is error-prone. Replace it with metadata inferred from the tool call history.

#### A1. Remove all `<<STATUS>>` instructions from the system prompt

In `src/chat/wolfteam/prompts.ts`, delete any instruction telling the LLM to emit `<<STATUS ...>>` tags. Search for all occurrences of `<<STATUS` and remove the surrounding instruction blocks. The LLM should never emit these tags.

#### A2. Infer mode from tool call history in the result

In `src/chat/wolfteam/participant.ts` (or `metadata.ts`), after `sendChatParticipantRequest` returns, determine the mode from what actually happened:

```ts
function inferMode(result: vscode.ChatResult): WolfteamResultMetadata['mode'] {
    const toolCalls = result.metadata?.toolCallRounds ?? [];
    const allToolNames = toolCalls.flatMap(
        (round: any) => round.map((call: any) => call.toolName ?? call.name)
    );

    // If the last tool called was a wolfbook tool that modifies the notebook,
    // we're likely done with execution → reviewing mode
    const modifyingTools = [
        'wolfbookInsert', 'wolfbookInsertMany', 'wolfbookEdit',
        'wolfbookRun', 'wolfbookRunAll', 'wolfbookEvalInsert',
    ];
    const lastTool = allToolNames[allToolNames.length - 1];

    if (allToolNames.length === 0) {
        return 'idle';
    }

    // If any tool call failed / had errors, error mode
    // (check result.metadata for error indicators)
    if (result.metadata?.errorDetails) {
        return 'error';
    }

    // If the LLM used checkpoint or proposePlan as the last tool,
    // it was interrupted mid-flow (user denied) → error/paused mode
    if (lastTool === 'wolfteam_checkpoint' || lastTool === 'wolfteam_proposePlan') {
        return 'error'; // user denied, so the flow stopped
    }

    // Default: if wolfbook tools were used, we completed something
    if (allToolNames.some(t => modifyingTools.includes(t))) {
        return 'reviewing';
    }

    return 'idle';
}
```

Wire this into the handler:

```ts
const libResult = chatUtils.sendChatParticipantRequest(request, chatContext, options, token);
const chatResult = await libResult.result;

// Attach inferred mode to metadata
return {
    ...chatResult,
    metadata: {
        ...chatResult.metadata,
        mode: inferMode(chatResult),
    },
};
```

#### A3. Clean up metadata.ts

Remove the `<<STATUS>>` regex parser and any associated types. The `WolfteamResultMetadata.mode` is now set by `inferMode()`, not by parsing LLM output.

---

### Fix B — Keep the session alive after task completion

The core problem is that after the LLM finishes a task and says "What's the next step?", the handler returns, the response ends, and the session is effectively dead until the user types again (or clicks a follow-up, which starts a new turn).

**There is no way to keep a `ChatRequestHandler` alive indefinitely waiting for user input** — the handler must return. This is a fundamental API limitation.

However, we can make the **transition between turns feel seamless** and **minimise the cost**:

#### B1. Update system prompt: don't ask open questions at the end

In `src/chat/wolfteam/prompts.ts`, add this to the response style section:

```
## END OF TASK — How to Finish a Response

When you have completed the user's task:
1. Give a brief summary of what was accomplished and the key result.
2. If there are obvious next steps, mention them briefly: "Natural next steps
   would be to check the Kretschmer scalar or extend to the rotating case."
3. Do NOT ask open-ended questions like "What's the next step?" or "What would
   you like to do now?" — the follow-up buttons handle this automatically.
4. Do NOT emit any status tags or metadata markers.
5. Simply end your response after the summary. The system will show appropriate
   follow-up suggestions to the user.

BAD ending:  "Everything is saved. What's the next step? <<STATUS mode="reviewing">>"
GOOD ending: "The Ricci tensor is computed and saved in cells 8-12. All components
             vanish as expected for the Schwarzschild vacuum solution. The Kretschmer
             scalar would be a natural consistency check."
```

#### B2. Make follow-ups feel like continuation, not a restart

In `src/chat/wolfteam/followups.ts`, update the `reviewing` follow-ups so the prompts carry context forward. Instead of generic labels, make them contextual using the result metadata:

```ts
case 'reviewing':
    const summary = meta.lastComputation?.summary ?? '';
    return [
        {
            prompt: `Continue: ${meta.suggestedNextStep ?? 'extend this calculation'}`,
            label: `→ ${meta.suggestedNextStep ?? 'Continue'}`,
        },
        {
            prompt: 'Check the result for consistency — dimensional analysis, known limits, symmetries',
            label: '🔍 Sanity check',
            command: 'check',
        },
        {
            prompt: 'Clean up the notebook and summarise what we computed',
            label: '🧹 Clean up & summarise',
            command: 'summarise',
        },
    ];
```

#### B3. On follow-up turn, inject history summary to reduce token cost

When a follow-up starts a new turn, the handler can detect it's a continuation (not a fresh request) by checking `context.history`. If the previous turn was a `reviewing` mode response, inject a compact summary instead of replaying the full history:

In `src/chat/wolfteam/participant.ts`:

```ts
const previousTurns = context.history.filter(
    h => h instanceof vscode.ChatResponseTurn && h.participant === 'wolfbook.team'
);
const lastTurn = previousTurns[previousTurns.length - 1];
const isFollowUp = lastTurn?.result?.metadata?.mode === 'reviewing';

if (isFollowUp) {
    // Inject a compact continuation context instead of full replay
    const prevSummary = lastTurn.result.metadata.lastComputation?.summary ?? '';
    const continuationContext = `[Continuing from previous task. Summary: ${prevSummary}. The user wants to continue with: "${request.prompt}"]`;

    // Prepend to messages, skip replaying detailed tool call history
    // from previous turn — just keep the summary
}
```

#### B4. Extract `suggestedNextStep` from the LLM's final output

To make contextual follow-ups work (B2), we need to capture what the LLM naturally mentions as next steps. Instead of asking the LLM to emit structured tags (which failed — see Bug A), parse the final markdown output heuristically:

```ts
function extractSuggestedNextStep(responseText: string): string | undefined {
    // Look for patterns like "next step would be...", "you could also...",
    // "natural follow-up...", etc. in the last paragraph
    const lastParagraph = responseText.trim().split('\n\n').pop() ?? '';
    const patterns = [
        /next step[s]? (?:would be|could be|:)\s*(.+?)(?:\.|$)/i,
        /natural (?:next step|follow-up|continuation)[s]?\s*(?:would be|:)\s*(.+?)(?:\.|$)/i,
        /you (?:could|might|may)(?: also| want to)?\s+(.+?)(?:\.|$)/i,
    ];
    for (const pattern of patterns) {
        const match = lastParagraph.match(pattern);
        if (match) return match[1].trim();
    }
    return undefined;
}
```

Attach to metadata before returning:

```ts
return {
    ...chatResult,
    metadata: {
        ...chatResult.metadata,
        mode: inferMode(chatResult),
        suggestedNextStep: extractSuggestedNextStep(collectedResponseText),
    },
};
```

This requires collecting the full response text during streaming. If using `sendChatParticipantRequest` with `responseStreamOptions.responseText: true`, the library streams it for you, but you may need to also accumulate it yourself for post-processing. Wrap the stream:

```ts
let collectedText = '';
const wrappedStream = {
    ...stream,
    markdown(value: string | vscode.MarkdownString) {
        const text = typeof value === 'string' ? value : value.value;
        collectedText += text;
        stream.markdown(value);
    },
};
```

### Summary of Changes

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| `<<STATUS>>` visible in chat | LLM emits tag, handler doesn't strip it | **Remove the mechanism entirely.** Infer mode from tool call history, not LLM output. |
| Session ends after task | LLM stops generating, handler returns | **Can't prevent handler from returning** (API limitation). Instead: (1) stop LLM from asking open questions, (2) make follow-ups contextual so continuation feels seamless, (3) inject summary on continuation turn to reduce token cost. |

### Files Changed

| File | Change |
|------|--------|
| `src/chat/wolfteam/prompts.ts` | Remove all `<<STATUS>>` instructions. Add "End of Task" section forbidding open questions and status tags. |
| `src/chat/wolfteam/metadata.ts` | Delete `<<STATUS>>` regex parser. Add `inferMode()` function that reads tool call rounds from result metadata. Add `extractSuggestedNextStep()` heuristic parser. |
| `src/chat/wolfteam/participant.ts` | After `sendChatParticipantRequest`, call `inferMode()` and `extractSuggestedNextStep()`. Wrap stream to collect response text. On follow-up turns, inject compact continuation summary instead of replaying full history. |
| `src/chat/wolfteam/followups.ts` | Make `reviewing` follow-ups contextual using `suggestedNextStep` from metadata. |

### Testing Checklist

- [ ] `<<STATUS>>` never appears in any chat response under any circumstances
- [ ] After task completion, response ends with a clean summary (no open questions, no tags)
- [ ] Follow-up buttons show contextual labels (e.g. "→ Check the Kretschmer scalar" not generic "New calculation")
- [ ] Clicking a follow-up starts a new turn but the LLM picks up context smoothly without repeating work
- [ ] Mid-task interaction tools (from Round 1) still work: plan approval, decision points, checkpoints all happen inline within one response

---
---

# Improvement Round 2 — LLM Finishes Response Instead of Continuing; STATUS Tag Leaks

## Observed Problems

After Round 1, two visible issues remain (see screenshot):

1. **`<<STATUS mode="reviewing">>` leaks into the chat as visible text.** The LLM emits it, but nothing strips it before it reaches the user. The agent renders it raw.

2. **The agent still ends its response with "What's the next step?" instead of continuing within the session.** The interaction tools (`wolfteam_proposePlan`, etc.) are registered but the LLM is not calling them — it falls back to outputting text and finishing. The follow-ups ("Show notebook", "New calculation") appear below, confirming the handler returned and the response ended.

These are two separate bugs with different fixes.

## Bug 1: `<<STATUS>>` Tag Leaking into Visible Output

### Root Cause

The `<<STATUS ...>>` mechanism from Stage 3 assumed we'd intercept streamed markdown and strip the tag before it reached the user. But `sendChatParticipantRequest` with `responseStreamOptions: { responseText: true }` streams text directly to VS Code's chat UI — there's no middleware layer where we can intercept and strip.

### Fix

**Remove `<<STATUS>>` entirely.** It was a workaround for detecting the LLM's end-state, but with the interaction tools from Round 1, we no longer need the LLM to self-report its mode. Instead, infer the mode from what actually happened.

#### Instructions for Copilot

**Step 1 — Remove all `<<STATUS>>` instructions from the system prompt.**

In `src/chat/wolfteam/prompts.ts`:
- Search for any mention of `<<STATUS`, `STATUS mode=`, or "emit a single line in this exact format"
- Delete those instructions completely
- Do NOT replace them with any other self-reporting mechanism — we will detect mode from tool call metadata instead

**Step 2 — Infer mode from tool call results in the handler.**

In `src/chat/wolfteam/participant.ts` (or `metadata.ts`), after `sendChatParticipantRequest` completes, determine the mode by inspecting what happened:

```ts
function inferMode(result: vscode.ChatResult): WolfteamResultMetadata['mode'] {
    const toolCalls = result.metadata?.toolCallRounds ?? [];
    const allToolNames = toolCalls.flatMap(
        (round: any) => round.map((call: any) => call.toolName ?? call.name)
    );

    // If the last interaction tool called was a checkpoint or plan that was denied,
    // the LLM likely stopped — that's an interruption
    const lastInteractionTool = [...allToolNames]
        .reverse()
        .find(n => n?.startsWith('wolfteam_'));

    // If any wolfbook tools were called AND no errors, we completed work
    const didWork = allToolNames.some(n => n?.startsWith('wolfbook'));
    const hasErrors = result.metadata?.hasErrors === true;

    if (hasErrors) return 'error';
    if (didWork) return 'reviewing';
    return 'idle';
}
```

This is more robust than parsing LLM output — it looks at what actually happened.

**Step 3 — Verify the `<<STATUS>>` text no longer appears in chat output.**

Test by asking `@wolfteam` to do something simple (e.g. "what's in my notebook?") and confirm no `<<STATUS...>>` text is visible in the response.

---

## Bug 2: LLM Ends Response Instead of Calling Interaction Tools

### Root Cause

This is the critical issue. The LLM is choosing to output "What's the next step?" as text and finish, rather than calling `wolfteam_checkpoint` or continuing to work. There are several possible causes, in order of likelihood:

**A) The interaction tools are not in the tools array passed to the LLM.** If the `wolfteam`-tagged tools aren't included, the LLM can't call them — it has no choice but to output text and stop.

**B) The tools are passed but `sendChatParticipantRequest` is not running an agentic loop.** If the library doesn't iterate (LLM → tool call → result → LLM → tool call → ...), the LLM only gets one shot and then the handler returns.

**C) The system prompt doesn't strongly enough instruct the LLM to use the tools.** The LLM may "know" about the tools but still prefer to output text because it's the path of least resistance.

**D) The `chat-extension-utils` library's tool loop has a maximum iteration limit** and the agent hit it.

### Fix — Address All Four Causes

#### Instructions for Copilot

**Step 1 — Verify tools are actually passed to the LLM.**

Add diagnostic logging to `src/chat/wolfteam/participant.ts`:

```ts
const wolfbookTools = vscode.lm.tools.filter(t => t.tags.includes('wolfbook'));
const wolfteamTools = vscode.lm.tools.filter(t => t.tags.includes('wolfteam'));
const allTools = [...wolfbookTools, ...wolfteamTools];

// DIAGNOSTIC: log tool names to output channel
console.log(`[wolfteam] Tools passed to LLM: ${allTools.map(t => t.name).join(', ')}`);
console.log(`[wolfteam] Wolfteam interaction tools: ${wolfteamTools.map(t => t.name).join(', ')}`);

// Verify the 3 interaction tools are present
const expectedTools = ['wolfteam_proposePlan', 'wolfteam_askDecision', 'wolfteam_checkpoint'];
for (const name of expectedTools) {
    if (!allTools.find(t => t.name === name)) {
        console.error(`[wolfteam] MISSING interaction tool: ${name}`);
    }
}
```

Check the Copilot output channel after invoking `@wolfteam`. If any interaction tools are missing, the registration in `package.json` or `extension.ts` is wrong — fix that first.

**Step 2 — Check that `sendChatParticipantRequest` is actually iterating.**

The library should handle the agentic loop, but verify it's configured correctly. The key is that `tools` must be passed as a parameter:

```ts
const libResult = chatUtils.sendChatParticipantRequest(
    request,
    chatContext,
    {
        prompt: systemPrompt,
        tools: allTools,                    // ← MUST be here, not empty
        responseStreamOptions: {
            stream,
            references: true,
            responseText: true,
        },
    },
    token
);
return await libResult.result;
```

If `tools` is empty or undefined, the library sends a single non-tool-calling request and returns immediately. **This is the most likely cause of the bug.**

**Step 3 — If `chat-extension-utils` doesn't support iteration, switch to manual agentic loop.**

If the library only does one LLM call (no iteration), we need to implement the loop ourselves. Create `src/chat/wolfteam/agentLoop.ts`:

```ts
import * as vscode from 'vscode';

/**
 * Manual agentic tool-calling loop.
 *
 * Repeatedly calls the LLM. If the LLM returns tool_use blocks,
 * executes the tools, feeds results back, and calls the LLM again.
 * Continues until the LLM returns a text-only response (no tool calls)
 * or we hit maxIterations.
 */
export async function runAgentLoop(options: {
    model: vscode.LanguageModelChat;
    messages: vscode.LanguageModelChatMessage[];
    tools: vscode.LanguageModelChatTool[];
    stream: vscode.ChatResponseStream;
    toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
    token: vscode.CancellationToken;
    maxIterations?: number;
}): Promise<{ toolCallRounds: any[] }> {
    const { model, messages, tools, stream, toolInvocationToken, token } = options;
    const maxIter = options.maxIterations ?? 30;
    const toolCallRounds: any[] = [];

    for (let i = 0; i < maxIter; i++) {
        // Call LLM
        const response = await model.sendRequest(messages, { tools }, token);

        // Accumulate text and tool calls from the response
        let responseText = '';
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];

        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                responseText += part.value;
                stream.markdown(part.value);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
            }
        }

        // If no tool calls, LLM is done — return
        if (toolCalls.length === 0) {
            break;
        }

        // Execute each tool call
        const toolResults: vscode.LanguageModelToolResultPart[] = [];
        for (const call of toolCalls) {
            try {
                const result = await vscode.lm.invokeTool(call.name, {
                    input: call.input,
                    toolInvocationToken,
                }, token);

                toolResults.push(
                    new vscode.LanguageModelToolResultPart(call.callId, result)
                );
            } catch (err: any) {
                toolResults.push(
                    new vscode.LanguageModelToolResultPart(call.callId, [
                        new vscode.LanguageModelTextPart(`Tool error: ${err.message}`)
                    ])
                );
            }
        }

        toolCallRounds.push(toolCalls.map(c => ({ name: c.name, input: c.input })));

        // Add assistant message (text + tool calls) and tool results to history
        messages.push(
            vscode.LanguageModelChatMessage.Assistant(
                [new vscode.LanguageModelTextPart(responseText), ...toolCalls]
            )
        );
        messages.push(
            vscode.LanguageModelChatMessage.User(toolResults)
        );

        // Loop continues — LLM gets tool results and decides next action
    }

    return { toolCallRounds };
}
```

Then in `participant.ts`, replace the `sendChatParticipantRequest` call:

```ts
import { runAgentLoop } from './agentLoop';

const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
    const messages = buildMessages(systemPrompt, context, request);
    const tools = buildToolList(); // wolfbook + wolfteam tools

    const result = await runAgentLoop({
        model: request.model,
        messages,
        tools: tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
        stream,
        toolInvocationToken: request.toolInvocationToken,
        token,
        maxIterations: 30,
    });

    return {
        metadata: {
            mode: inferMode(result),
            toolCallRounds: result.toolCallRounds,
        },
    };
};
```

**The critical difference:** this loop keeps calling the LLM until it produces a response with zero tool calls. If the LLM calls `wolfteam_checkpoint`, the tool's confirmation UI appears (via `vscode.lm.invokeTool` + `toolInvocationToken`), the user clicks Allow, the result feeds back to the LLM, and the loop continues. The handler doesn't return until the LLM is truly done.

**Step 4 — Strengthen the system prompt to enforce tool usage.**

In `src/chat/wolfteam/prompts.ts`, add this near the top of the prompt (in the CRITICAL RULES section, before tool descriptions):

```
## CRITICAL: Never End Your Response to Ask the User a Question

You are running inside a tool-calling loop. You have interaction tools
(`wolfteam_proposePlan`, `wolfteam_askDecision`, `wolfteam_checkpoint`)
that let you consult the user WITHOUT ending your response.

WRONG — ending the response with a question:
  "Here's my plan: ... What do you think? Should I proceed?"
  ← This ends the chat turn. The user has to type a new message.
     The session breaks. Do NOT do this.

RIGHT — calling an interaction tool:
  1. Stream "Here's my proposed plan:" and describe it briefly
  2. Call wolfteam_proposePlan with the plan details
  3. Wait for tool result (user approved/denied)
  4. Continue executing based on the result
  ← This stays in the same response. The user sees an inline
     confirmation. No session break.

NEVER output a question and stop. ALWAYS call the appropriate
interaction tool instead. If you're about to write "What do you
think?" or "Should I proceed?" — STOP and call a tool instead.

The same applies at the end of a task:
WRONG: "Everything is done. What's the next step?"
RIGHT: Call wolfteam_checkpoint with a summary, then if the user
       approves, ask if there's more to do via wolfteam_askDecision.
       Only finish your response (return to the user) when there is
       genuinely nothing more to do in this turn.
```

**Step 5 — Handle denial gracefully.**

When a user clicks "Deny" on a tool confirmation, `vscode.lm.invokeTool` throws an error. The agent loop must catch this and feed it back to the LLM as a "user declined" message, not crash:

In the `runAgentLoop` catch block (or in the tool's `invoke` method), ensure the LLM gets a clear signal:

```ts
} catch (err: any) {
    const isDenial = err.message?.includes('denied') ||
                     err.message?.includes('cancelled') ||
                     err.code === 'Cancelled';
    const errorMessage = isDenial
        ? `User declined this action. Ask what they'd like to change or try a different approach.`
        : `Tool error: ${err.message}`;

    toolResults.push(
        new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(errorMessage)
        ])
    );
}
```

This way, if the user denies a plan, the LLM doesn't crash — it gets "User declined" and can ask what to change, still within the same response.

**Step 6 — Verify the fix.**

Test the same scenario:
1. Ask `@wolfteam` to save the notebook
2. Expected: agent calls `wolfbookSaveNotebook`, then calls `wolfteam_checkpoint` with summary, user clicks Allow, agent calls `wolfteam_askDecision` with "What would you like to do next?", all within ONE response
3. Verify: no `<<STATUS>>` text visible, no premature response ending

Test a multi-step scenario:
1. Ask `@wolfteam` "Help me compute Christoffel symbols for Schwarzschild"
2. Expected: plan proposed inline → user approves → cells inserted → checkpoint shown → user approves → continues → final summary → follow-ups appear
3. All within one response bubble until the very end

---

### Decision: `chat-extension-utils` vs Manual Loop

After this round, evaluate which approach works:

- If `sendChatParticipantRequest` **does** iterate with tools and confirmations work inline → keep it, it's simpler
- If it **doesn't** iterate (most likely cause of the current bug) → use the manual `runAgentLoop` from Step 3

The manual loop gives us full control and is the safer bet. The trade-off is we lose `chat-extension-utils`'s automatic history management and prompt-tsx integration, but we can add those back incrementally.

### Files Changed

| File | Change |
|------|--------|
| `src/chat/wolfteam/prompts.ts` | Remove all `<<STATUS>>` instructions; add "NEVER end response with a question" rule |
| `src/chat/wolfteam/metadata.ts` | Remove `<<STATUS>>` parser; replace with `inferMode()` from tool call metadata |
| `src/chat/wolfteam/participant.ts` | Add diagnostic logging for tools; potentially replace `sendChatParticipantRequest` with manual loop |
| `src/chat/wolfteam/agentLoop.ts` | **NEW** — Manual agentic tool-calling loop (if `chat-extension-utils` doesn't iterate) |

---
---

# Improvement Round 3 — Checkpoint UX Refinement

## Status After Round 2

The core architecture is working: the agent loop runs, interaction tools fire inline, confirmations appear without breaking the session. The screenshot shows a `wolfteam_checkpoint` confirmation rendering correctly inside the chat. Three remaining UX issues to address:

## Issue A: JSON Input Leaks into the Confirmation Dialog

### What Happens

The confirmation dialog shows the raw JSON input parameters at the bottom:
```json
{ "nextStep": "Finalize the notebook and remove redundant scratch cells (34-41).",
  "result": "Synthesized Amit's result into final...",
  "stepCompleted": "Inserted final derivation section..." }
```

This is the default VS Code behavior — it shows tool input parameters as an expandable JSON block. It's fine for developer-facing tools (file edits, terminal commands) but ugly for user-facing interaction tools.

### Fix

The JSON appears because `prepareInvocation` returns `confirmationMessages` but the parameters are still visible in the "Input" section. We need to make the parameters less prominent or restructure the tool so the visible parameters are minimal.

#### Instructions for Copilot

**Step 1 — Move all human-readable content into the confirmation message, not the input parameters.**

Restructure the checkpoint tool so the `confirmationMessages.message` contains ALL the information the user needs to see, and the input parameters are minimal implementation details.

In `src/chat/wolfteam/interactionTools.ts`, update `CheckpointTool.prepareInvocation`:

```ts
async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{
        stepCompleted: string;
        result: string;
        nextStep: string;
    }>,
    _token: vscode.CancellationToken
): Promise<vscode.PreparedToolInvocation> {
    const { stepCompleted, result, nextStep } = options.input;
    return {
        invocationMessage: `✅ ${stepCompleted}`,
        confirmationMessages: {
            title: `✅ ${stepCompleted}`,
            message: new vscode.MarkdownString(
                `${result}\n\n` +
                `**Next →** ${nextStep}`
            ),
        },
    };
}
```

Key changes:
- Title is now the step completed (concise, informative) instead of generic "Continue?"
- Message body is just the result + next step in clean markdown, no "Click Allow to continue" boilerplate (the buttons already say that)
- Remove the instruction text "Click **Allow** to continue, or **Deny** to pause and inspect" — the UI buttons already convey this, repeating it is clutter

**Step 2 — Apply the same cleanup to `ProposePlanTool` and `AskDecisionTool`.**

For `ProposePlanTool.prepareInvocation`:
```ts
return {
    invocationMessage: 'Proposed calculation plan',
    confirmationMessages: {
        title: 'Calculation Plan',
        message: new vscode.MarkdownString(
            `${planSummary}\n\n` +
            steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
        ),
    },
};
```

For `AskDecisionTool.prepareInvocation`:
```ts
return {
    invocationMessage: `Decision: ${question}`,
    confirmationMessages: {
        title: question,
        message: new vscode.MarkdownString(
            (context ? `_${context}_\n\n` : '') +
            opts.map((o, i) => `${i + 1}. **${o}**`).join('\n') +
            `\n\nDefault: **${defaultOption}**`
        ),
    },
};
```

**Step 3 — Investigate whether the JSON input block can be suppressed.**

The "Input" / "See more" section showing the raw JSON is VS Code's default rendering for tool confirmations. Check if there's a way to suppress it:

- Check whether returning an empty or minimal `inputSchema` hides the input section
- Check whether `prepareInvocation` can return a flag to hide parameters
- If neither works, this is a VS Code limitation we live with — but at least the JSON won't contain the redundant information since the message already shows it

If the input block cannot be hidden, restructure the input schema for interaction tools to use a single opaque field instead of human-readable field names:

```json
{
    "inputSchema": {
        "type": "object",
        "properties": {
            "_context": {
                "type": "string",
                "description": "Internal context for the interaction (not user-facing)"
            }
        },
        "required": ["_context"]
    }
}
```

Then in the LLM prompt, instruct it to pass a single JSON-encoded string in `_context`, and the tool's `prepareInvocation` parses it internally. This way the "Input" section shows just `{ "_context": "..." }` — less visual noise than three descriptive fields.

**However**, only do this if the JSON input truly cannot be hidden. The three descriptive fields are better for the LLM's tool calling (it understands the schema better). Try cleaner solutions first.

---

## Issue B: No Way to Enter Additional Directions

### What Happens

The confirmation dialog has only "Allow in this Session" and "Skip" buttons. The user has no way to type additional guidance like "yes, but also add a section header" or "proceed but use Rationalize instead of Simplify."

### Root Cause

This is a fundamental limitation of VS Code's tool confirmation UI. It's designed for binary Allow/Deny decisions, not for free-text input. The built-in Copilot agent has the same limitation — tool confirmations are binary, with the only additional input being parameter editing.

### Workarounds

#### Instructions for Copilot

**Step 1 — Use the editable parameter mechanism for user input.**

VS Code allows users to expand the tool confirmation and **edit the input parameters** before clicking Allow. We can exploit this by adding an explicit `userNote` field to the interaction tools that the user can fill in:

Update the input schemas in `package.json` for all three interaction tools. Add a `userNote` field:

For `wolfteam_checkpoint`:
```json
{
    "type": "object",
    "properties": {
        "stepCompleted": { "type": "string", "description": "What was just completed" },
        "result": { "type": "string", "description": "The key result" },
        "nextStep": { "type": "string", "description": "What will be done next" },
        "userNote": { "type": "string", "description": "Optional: User can add directions or modifications here before clicking Allow", "default": "" }
    },
    "required": ["stepCompleted", "result", "nextStep"]
}
```

For `wolfteam_proposePlan`:
```json
"userNote": { "type": "string", "description": "Optional: User can modify the plan or add constraints here before clicking Allow", "default": "" }
```

For `wolfteam_askDecision`:
```json
"userNote": { "type": "string", "description": "Optional: User can explain their choice or add context here", "default": "" }
```

**Step 2 — Read `userNote` in the tool's `invoke` method and pass it to the LLM.**

In each tool's `invoke`:
```ts
async invoke(options, _token) {
    const userNote = (options.input as any).userNote;
    const noteText = userNote ? ` User added: "${userNote}"` : '';
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
            `User approved.${noteText} Proceed with: ${options.input.nextStep}`
        ),
    ]);
}
```

**Step 3 — Add instruction in the confirmation message telling the user about this.**

In `prepareInvocation`, add a hint at the bottom of the message:

```ts
message: new vscode.MarkdownString(
    `${result}\n\n` +
    `**Next →** ${nextStep}\n\n` +
    `_To add directions, expand the parameters below and edit the \`userNote\` field before clicking Allow._`
),
```

**Step 4 — Tell the LLM to always pass an empty `userNote` field.**

In the system prompt:
```
When calling wolfteam_checkpoint, wolfteam_proposePlan, or wolfteam_askDecision,
always include a `userNote` field set to empty string "". The user may edit this
field before approving to add extra directions. If the tool result mentions
"User added:", incorporate those directions into your next action.
```

### Limitations

This is clunky — the user has to expand "See more", find the `userNote` field, edit it, and then click Allow. It works but it's not elegant. A better long-term solution would be a VS Code API for richer confirmation UIs (multi-choice, text input), but that doesn't exist yet.

For the common case where the user just wants to approve and continue, they simply click Allow without expanding anything — the empty `userNote` is ignored.

---

## Issue C: "Allow in this Session" Should Default to "Allow Once"

### What Happens

The confirmation button shows "Allow in this Session" by default, with a dropdown for other options. For interaction tools (which present different content each time), "Allow in this Session" doesn't make sense — each checkpoint/decision is unique. Auto-approving all future checkpoints defeats the purpose.

### Root Cause

VS Code's confirmation UI defaults to "Allow in this Session" as the primary action. This is correct for repetitive tool calls (e.g. always allow file reads) but wrong for tools where each invocation has unique content the user should review.

### Fix

#### Instructions for Copilot

**Step 1 — Check if `prepareInvocation` has a way to control the default confirmation level.**

Search the VS Code API / `vscode.d.ts` proposed APIs for any property on `PreparedToolInvocation` or `ToolConfirmationMessages` that controls confirmation scope. Look for:
- `confirmationScope`
- `defaultApprovalLevel`
- `singleUse`
- or similar

If such a property exists, set it to single-use / allow-once for all three interaction tools.

**Step 2 — If no API exists, add a warning in the confirmation message.**

In `prepareInvocation`, add to the message:

```ts
message: new vscode.MarkdownString(
    `${result}\n\n` +
    `**Next →** ${nextStep}\n\n` +
    `_Tip: Use **Allow** (not "Allow in this Session") — each checkpoint is unique._`
),
```

**Step 3 — If "Allow in this Session" is clicked, make the tool still show meaningful content.**

Even if auto-approved, the `invocationMessage` still appears briefly in the chat stream. Make sure it's informative:

```ts
invocationMessage: `✅ ${stepCompleted} → Next: ${nextStep}`,
```

This way, even if auto-approved, the user sees a one-line summary flash by in the chat as progress indication.

**Step 4 — Consider making checkpoints auto-approvable but decisions not.**

Actually, think about whether "Allow in this Session" is sometimes desirable:
- `wolfteam_checkpoint` — the user may WANT to auto-approve all checkpoints if they trust the plan and just want to see progress. This is fine. The `invocationMessage` acts as a progress log.
- `wolfteam_proposePlan` — should NOT be auto-approved. Each plan is unique.
- `wolfteam_askDecision` — should NOT be auto-approved. Each decision is unique.

So the fix is actually:
- For `wolfteam_checkpoint`: "Allow in this Session" is acceptable — add a clear `invocationMessage` that logs progress
- For `wolfteam_proposePlan` and `wolfteam_askDecision`: investigate if there's a way to force "Allow once" as default. If not, add the warning message.

---

## Summary of Round 3 Changes

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| JSON input leaks into dialog | VS Code shows tool params by default | Move all content to `confirmationMessages.message`; clean up titles; investigate hiding input section |
| No way to add user directions | Confirmation UI is binary Allow/Deny | Add `userNote` editable parameter; instruct user to expand and edit; LLM reads it from tool result |
| "Allow in this Session" default | VS Code default confirmation scope | Differentiate: checkpoints can be session-approved (with good `invocationMessage`); plans/decisions should be allow-once (add tip text if no API control) |

### Files Changed

| File | Change |
|------|--------|
| `src/chat/wolfteam/interactionTools.ts` | Rewrite all three `prepareInvocation` methods: cleaner titles, no boilerplate, read `userNote` in `invoke` |
| `package.json` | Add `userNote` field (optional, default `""`) to all three interaction tool input schemas |
| `src/chat/wolfteam/prompts.ts` | Add instruction to always pass empty `userNote`; add instruction to read user notes from tool results |

### Testing Checklist

- [ ] Checkpoint confirmation shows clean markdown: step name in title, result + next step in body, no "Click Allow" boilerplate
- [ ] JSON input section is either hidden or shows minimal non-redundant data
- [ ] User can expand parameters, edit `userNote`, and click Allow — the LLM reads and acts on the note
- [ ] If user clicks Allow without editing `userNote`, the LLM proceeds normally (empty note is ignored)
- [ ] `wolfteam_checkpoint` works sensibly with "Allow in this Session" — progress is visible via `invocationMessage`
- [ ] `wolfteam_askDecision` warns user to use "Allow" not "Allow in this Session"

---

## Issue D: Follow-Ups Appear as Disconnected Post-Chat Menu

### What Happens (see screenshot)

After the agent completes its work (checkpoints approved, cells modified), the response ends and three follow-up buttons appear below the response:

> 💾 Save & continue
> 🔄 Extend
> 🆕 New task

These appear as a standard post-response menu — visually separated from the conversation, clearly "after" the response, not "part of" it. The agent also stopped mid-action ("Using #wolfbookdeleteCell...") suggesting the loop terminated before fully finishing, then the follow-ups appeared as a fallback.

The problem: these should either (a) not be needed because the agent asked "what next?" via `wolfteam_askDecision` *inside* the response, or (b) if they do appear, they should be contextual to what just happened (e.g. "Clean up scratch cells 34-41" was the stated next step).

### Root Cause

Two overlapping issues:

1. **The agent loop exited prematurely.** The response ended with "Using #wolfbookdeleteCell..." which means the LLM emitted text about what it was about to do, then the loop terminated (possibly the LLM stopped generating, or it hit the iteration limit, or the tool call failed). The follow-ups then appeared as the post-response fallback.

2. **Follow-ups are generic, not contextual.** The follow-up provider returns the same three options regardless of what the agent just did. It should reflect the actual next step from the last checkpoint.

### Fix

#### Instructions for Copilot

**Step 1 — Ensure the agent loop doesn't exit while the LLM is still working.**

In `src/chat/wolfteam/agentLoop.ts` (or wherever the loop runs), add logging to understand why the loop exits:

```ts
for (let i = 0; i < maxIter; i++) {
    console.log(`[wolfteam] Agent loop iteration ${i + 1}/${maxIter}`);

    const response = await model.sendRequest(messages, { tools }, token);

    // ... process response ...

    if (toolCalls.length === 0) {
        console.log(`[wolfteam] Loop exiting: no tool calls in iteration ${i + 1}`);
        console.log(`[wolfteam] Final text: ${responseText.slice(-200)}`);
        break;
    }

    console.log(`[wolfteam] Tool calls in iteration ${i + 1}: ${toolCalls.map(c => c.name).join(', ')}`);
}

if (i >= maxIter) {
    console.warn(`[wolfteam] Loop exiting: hit max iterations (${maxIter})`);
}
```

Check the output channel after a session. The most likely finding:
- The LLM called `wolfteam_checkpoint`, user approved, then the LLM emitted text + one more tool call, but the loop hit the iteration limit before the tool could execute
- OR: the LLM stopped generating (no more tool calls, no more text) because it treated the task as complete after the checkpoint approval

If the iteration limit is the issue, increase `maxIterations` to 50 or higher. Wolfbook tasks with multiple cells, evaluations, and checkpoints can easily consume 20+ iterations.

**Step 2 — Instruct the LLM to finish cleanly, not mid-action.**

In the system prompt, add to the "End of Task" section:

```
## CRITICAL: Never Stop Mid-Action

If you are about to call a tool (e.g. you just wrote "Using #wolfbookdeleteCell..."),
you MUST actually call the tool. Do NOT emit text describing what you're about to do
and then stop. Either:
  a) Call the tool immediately (preferred), OR
  b) If you're done, don't mention the next tool at all — summarise what was accomplished

Stopping after "I'll now do X..." without doing X is confusing — it looks like
something broke. Either do X or don't mention it.
```

**Step 3 — Make follow-ups contextual using the last checkpoint's `nextStep`.**

In `src/chat/wolfteam/followups.ts`, read the last checkpoint result from metadata:

```ts
function provideFollowups(result, context, token): vscode.ChatFollowup[] {
    const meta = result.metadata as WolfteamResultMetadata;

    // Extract the last stated next step from tool call history
    const lastCheckpoint = findLastToolCall(meta?.toolCallRounds, 'wolfteam_checkpoint');
    const suggestedNext = lastCheckpoint?.input?.nextStep;

    // Extract a natural continuation from the last computation
    const lastComputation = meta?.lastComputation?.summary;

    switch (meta?.mode) {
        case 'reviewing': {
            const followups: vscode.ChatFollowup[] = [];

            // First follow-up: the specific next step from the last checkpoint
            if (suggestedNext) {
                followups.push({
                    prompt: suggestedNext,
                    label: `→ ${truncate(suggestedNext, 60)}`,
                });
            }

            // Generic but still useful
            followups.push(
                { prompt: 'Save the notebook and summarise what we did', label: '💾 Save & summarise' },
                { prompt: 'I want to work on something else', label: '🆕 New task' },
            );

            return followups;
        }

        case 'error':
            return [
                { prompt: 'Try a different approach', label: '↻ Different approach' },
                { prompt: 'Debug this step', label: '🔍 Debug' },
            ];

        default:
            return [
                { prompt: 'What\'s currently in my notebook?', label: '📓 Show notebook' },
                { prompt: 'Help me with a calculation', label: '🧮 New calculation' },
            ];
    }
}

function findLastToolCall(rounds: any[] | undefined, toolName: string): any | undefined {
    if (!rounds) return undefined;
    for (let i = rounds.length - 1; i >= 0; i--) {
        const call = rounds[i].find((c: any) => c.name === toolName);
        if (call) return call;
    }
    return undefined;
}

function truncate(s: string, maxLen: number): string {
    return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}
```

Now instead of generic "Extend", the first follow-up is the actual next step — e.g. **"→ Clean up scratch cells 34-41"** — which the user can click to continue naturally.

**Step 4 — Store the full response text and tool call history in result metadata.**

Make sure the handler captures enough data for contextual follow-ups:

```ts
return {
    metadata: {
        mode: inferMode(loopResult),
        toolCallRounds: loopResult.toolCallRounds,
        lastComputation: {
            summary: collectedResponseText.slice(-500), // last 500 chars as summary
        },
    },
};
```

The `toolCallRounds` must include each tool call's `name` and `input` (not just the name) so `findLastToolCall` can extract `nextStep`.

### Updated Files

| File | Change |
|------|--------|
| `src/chat/wolfteam/agentLoop.ts` | Add loop exit logging; increase `maxIterations` default to 50 |
| `src/chat/wolfteam/prompts.ts` | Add "Never stop mid-action" instruction |
| `src/chat/wolfteam/followups.ts` | Rewrite: contextual first follow-up from last checkpoint's `nextStep`; `findLastToolCall` helper |
| `src/chat/wolfteam/participant.ts` | Ensure `toolCallRounds` in metadata includes full `input` objects, not just names |

### Testing Checklist

- [ ] Agent never stops mid-sentence with "Using #wolfbook..." — either calls the tool or doesn't mention it
- [ ] After a completed task, first follow-up button shows the actual next step (e.g. "→ Clean up scratch cells 34-41")
- [ ] Clicking the contextual follow-up continues the work naturally
- [ ] If no checkpoint was used (simple task), follow-ups fall back to generic options
- [ ] Agent loop doesn't exit prematurely — check logs for unexpected early termination

---

## Issue E: Tool Invocations Should Be Visible with Intent Descriptions

### What the User Wants

When the agent calls a Wolfbook tool, the user should see a short line in the chat explaining **what** is being done and **why** — not just the raw tool name. Currently the chat shows things like:

> Using #wolfbookdeleteCell...

This is the bare `invocationMessage` (or VS Code's default if none is set). It tells the user nothing about intent. It should say something like:

> 🔧 Deleting scratch cells 34–41 — cleaning up failed attempts from the exploration phase

This is important for the collaborative feel: the user sees the agent's reasoning, not just its actions.

### How It Works

Every tool call that goes through `vscode.lm.invokeTool` with a `toolInvocationToken` renders an `invocationMessage` in the chat. This is set in the tool's `prepareInvocation` method. For Wolfbook tools, these messages are currently either missing or generic.

There are two layers to fix:

1. **Wolfbook tools** (the kernel tools like `wolfbookEval`, `wolfbookInsert`, etc.) — their `prepareInvocation` should return a descriptive `invocationMessage`
2. **The system prompt** — the LLM should explain its intent in streamed text *before* calling a tool, so even if the `invocationMessage` is brief, there's context

### Fix

#### Instructions for Copilot

**Step 1 — Add meaningful `invocationMessage` to all Wolfbook tool handlers.**

In each tool's `prepareInvocation`, construct a message from the input parameters. The message should say *what* is being done in human terms, not repeat the tool name.

In whichever file implements the Wolfbook tool handlers (likely `src/tools/` or similar), update `prepareInvocation` for each tool:

```ts
// wolfbookEval
prepareInvocation(options) {
    const expr = options.input.expression;
    const preview = expr.length > 80 ? expr.slice(0, 77) + '...' : expr;
    return {
        invocationMessage: `Evaluating: ${preview}`,
    };
}

// wolfbookInsert
prepareInvocation(options) {
    const kind = options.input.kind ?? 'code';
    const preview = (options.input.source ?? '').slice(0, 60);
    return {
        invocationMessage: `Inserting ${kind} cell: ${preview}...`,
    };
}

// wolfbookInsertMany
prepareInvocation(options) {
    const count = options.input.cells?.length ?? 0;
    return {
        invocationMessage: `Inserting ${count} cells`,
    };
}

// wolfbookRun
prepareInvocation(options) {
    const cell = options.input.cellNumber;
    return {
        invocationMessage: `Running cell ${cell}`,
    };
}

// wolfbookRunAll
prepareInvocation(options) {
    const from = options.input.fromCell;
    const to = options.input.toCell;
    return {
        invocationMessage: `Running cells ${from}–${to}`,
    };
}

// wolfbookEdit
prepareInvocation(options) {
    const cell = options.input.cellNumber;
    const willRun = options.input.evaluate ? ' and evaluating' : '';
    return {
        invocationMessage: `Editing cell ${cell}${willRun}`,
    };
}

// wolfbookDelete
prepareInvocation(options) {
    const cells = options.input.cellNumbers;
    const label = Array.isArray(cells)
        ? cells.length > 3
            ? `${cells.length} cells (${cells[0]}–${cells[cells.length - 1]})`
            : `cells ${cells.join(', ')}`
        : `cell ${cells}`;
    return {
        invocationMessage: `Deleting ${label}`,
    };
}

// wolfbookContext
prepareInvocation() {
    return {
        invocationMessage: 'Reading notebook state',
    };
}

// wolfbookState
prepareInvocation() {
    return {
        invocationMessage: 'Checking defined symbols',
    };
}

// wolfbookLookup
prepareInvocation(options) {
    return {
        invocationMessage: `Looking up: ${options.input.symbol}`,
    };
}

// wolfbookSearch
prepareInvocation(options) {
    return {
        invocationMessage: `Searching notebook for: ${options.input.pattern}`,
    };
}

// wolfbookSaveNotebook
prepareInvocation() {
    return {
        invocationMessage: '💾 Saving notebook',
    };
}

// wolfbookRestart
prepareInvocation() {
    return {
        invocationMessage: '⚠️ Restarting kernel — all definitions will be cleared',
        confirmationMessages: {
            title: 'Restart Kernel',
            message: new vscode.MarkdownString(
                'This will **clear all definitions** and reset the kernel state.\n\n' +
                'Make sure any important results are saved to cells.'
            ),
        },
    };
}

// wolfbookAbort
prepareInvocation() {
    return {
        invocationMessage: '⛔ Aborting running evaluation',
    };
}

// wolfbookDebug
prepareInvocation(options) {
    const action = options.input.action ?? 'analyze';
    return {
        invocationMessage: `Debugger: ${action}`,
    };
}

// wolfbookFindPkg
prepareInvocation(options) {
    return {
        invocationMessage: `Searching for package: ${options.input.query}`,
    };
}

// wolfbookWebHelp
prepareInvocation(options) {
    return {
        invocationMessage: `Fetching docs for: ${options.input.symbol}`,
    };
}
```

The pattern: each message is a short human-readable description of the action, using the input parameters to be specific. No tool names, no JSON, no code syntax — just plain English.

**Step 2 — Instruct the LLM to explain intent before calling tools.**

In `src/chat/wolfteam/prompts.ts`, add to the "Think Out Loud" section:

```
## Explain Before Acting

Before each tool call, write a SHORT sentence (one line) explaining your intent.
This helps the user follow your reasoning.

Examples:
  "Let me check what's currently defined in the kernel."
  → calls wolfbookState

  "I'll insert the metric definition as a new cell so you can inspect it."
  → calls wolfbookInsert

  "Let me evaluate this to verify the tensor symmetry."
  → calls wolfbookEval

  "Cleaning up the scratch cells from our earlier exploration."
  → calls wolfbookDelete

Keep it to ONE sentence. Do not write paragraphs before every tool call.
For rapid sequences of related calls (e.g. inserting 3 cells in a row),
one explanation before the batch is enough — you don't need to narrate each one.
```

**Step 3 — For the interaction tools, make `invocationMessage` more informative.**

The interaction tools already have `invocationMessage` from Round 1, but improve them:

```ts
// wolfteam_proposePlan
invocationMessage: `📋 Proposing plan: ${options.input.planSummary.slice(0, 80)}...`,

// wolfteam_askDecision
invocationMessage: `❓ ${options.input.question}`,

// wolfteam_checkpoint
invocationMessage: `✅ ${options.input.stepCompleted} → Next: ${options.input.nextStep.slice(0, 60)}`,
```

These one-liners show intent even if the user has auto-approved the tool ("Allow in this Session") — they serve as a visible progress log.

### What the User Sees After This Fix

A typical interaction would look like:

> Let me check what's currently in the notebook.
>
> 🔧 Reading notebook state
>
> I see the metric defined in cell 3. I'll compute the Christoffel symbols.
>
> 📋 Proposing plan: Compute Christoffel symbols from metric in cell 3...
> *(confirmation dialog appears)*
>
> 🔧 Inserting code cell: christoffel = ...
>
> 🔧 Running cell 8
>
> ✅ Christoffel symbols computed → Next: Contract to get Ricci tensor
> *(checkpoint confirmation)*
>
> 🔧 Inserting code cell: ricci = ...

Each tool invocation has a visible one-liner. The LLM's intent sentences appear as regular markdown between them. The user can follow the agent's reasoning step by step.

### Files Changed

| File | Change |
|------|--------|
| `src/tools/*.ts` (or wherever Wolfbook tool handlers live) | Add `prepareInvocation` with descriptive `invocationMessage` to every tool handler |
| `src/chat/wolfteam/interactionTools.ts` | Improve `invocationMessage` for all three interaction tools |
| `src/chat/wolfteam/prompts.ts` | Add "Explain Before Acting" section with examples |

### Testing Checklist

- [ ] Every tool invocation shows a human-readable message in chat (not "Using #wolfbookEval...")
- [ ] Messages include specific details from tool parameters (cell numbers, expression previews, symbol names)
- [ ] The LLM writes a brief intent sentence before most tool calls (not a paragraph, not nothing)
- [ ] For rapid tool sequences (e.g. inserting multiple cells), intent is explained once before the batch
- [ ] `wolfbookRestart` shows a confirmation dialog (since it's destructive)
- [ ] Interaction tool messages are informative even when auto-approved