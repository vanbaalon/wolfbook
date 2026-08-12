# Oberon — the experimental research agent

→ [Back to README](../README.md)

> **Experimental.** Oberon is a research preview. It spends money on LLM API
> calls, writes files into your workspace, and its interface will change between
> releases. Everything below is opt-in: with no API key configured, Oberon never
> runs and never sends anything anywhere.

Every other AI feature in Wolfbook is a *tool surface* — you (or Copilot, or
Claude Code) drive, and the extension executes. Oberon is different: you hand it
a task, and it plans, computes, checks its own work against the Wolfram kernel,
and hands back a clean notebook.

The design principle is **generate cheap, verify hard**. A language model is
allowed to be wrong; the kernel is not. Every result Oberon reports has been
executed, and the deliverable is re-run from scratch in a fresh kernel before it
is handed to you.

---

## What it actually does

You give it a brief — *"compute the two-magnon spectrum of the L=8 XXX chain and
verify it against exact diagonalisation"*. Oberon then:

1. **Plans** the calculation into ordered steps.
2. **Probes** the live kernel — small trial computations, each one appearing as a
   cell in a live `working.wb` notebook you can watch as it runs.
3. **Records** the probes that worked as steps of a chain, optionally attaching
   *machine checks* — WL booleans the kernel adjudicates immediately.
4. **Compiles** the surviving steps into a clean, self-contained `clean.wb`.
5. **Verifies** by restarting the kernel and re-running that notebook end to end.
   A clean replay *is* the verification — there is no LLM judging its own work.

You get two notebooks: `working.wb` (the whole messy trail, including failures)
and `clean.wb` (the deliverable). Both live under `quests/` in your workspace.

### Two modes

| Mode | Command | Use it for |
|---|---|---|
| **Quick compute** | *Oberon: Start Research…* | One self-contained calculation |
| **Director** | *Oberon: Director Research (multi-stage)…* | A multi-stage programme that plans, runs several dependent stages, banks verified key results, and writes a LaTeX report |

Useful companions: *Oberon: Open Run Inspector*, *Oberon: Abort Active Run*,
*Oberon: Configure Providers & Pricing*, and *Oberon: Resume Director Programme…*
(a programme is journaled after every step, so it survives a reload).

---

## Configuration

### 1. Provide an API key

Oberon needs a third-party LLM. Nothing runs until you configure one — set an
API key in Settings under `wolfbook.oberon.providers`, or via environment
variable:

| Provider | Setting | Environment variable |
|---|---|---|
| DeepSeek | `wolfbook.oberon.providers.deepseek.apiKey` | `DEEPSEEK_API_KEY` |
| Anthropic | `wolfbook.oberon.providers.anthropic.apiKey` | `ANTHROPIC_API_KEY` |
| OpenAI | `wolfbook.oberon.providers.openai.apiKey` | `OPENAI_API_KEY` |

DeepSeek is the default and by far the cheapest: a typical verified calculation
costs a few cents. The agent is designed around that economics — cheap model,
hard verification.

### 2. Roles (optional)

Different jobs bind to different models, so you can put a stronger model where
judgment matters and a cheap one where execution does:

```jsonc
// each role is its own setting
"wolfbook.oberon.roles.oberon":   { "provider": "deepseek", "model": "deepseek-v4-pro"   },  // planning, judgment
"wolfbook.oberon.roles.fairy":    { "provider": "deepseek", "model": "deepseek-v4-flash" },  // the execution loop
"wolfbook.oberon.roles.director": { "provider": "deepseek", "model": "deepseek-v4-pro"   }   // multi-stage programmes
```

A role with no explicit binding falls back sensibly (`director` → `oberon`,
`literature` → `fairy`), so you can configure one key and ignore this section.

### 3. Budgets

Runs are bounded in both money and effort — the agent stops rather than
surprising you:

| Setting | Meaning | Default |
|---|---|---|
| `wolfbook.oberon.budgets.run` | `{ runUSD, runLlmCalls }` — hard ceilings for one run | `{ 15, 200 }` |
| `wolfbook.oberon.budgets.fairyFsm` | Probe/turn budgets inside a run | see settings |
| `wolfbook.oberon.director.maxUSD` | Ceiling for a whole Director programme | 15 |

### 4. Useful toggles

| Setting | What it does |
|---|---|
| `wolfbook.oberon.fairy.selfPostmortem` | After each run the agent writes a structured self-assessment — what worked, where it struggled, what it would change. Genuinely worth reading. Default on. |
| `wolfbook.oberon.fairy.askSpecialistEnabled` | Lets the agent ask *you* a question when a task is ambiguous. Default on; disable for unattended runs. |
| `wolfbook.oberon.fairy.reasoning` | When the model is allowed to think deliberately (phase entry, cadence, after failures) rather than on every turn. |
| `wolfbook.oberon.recall.enabled` | SkilXiv skill recall — see below. |

---

## SkilXiv integration

[SkilXiv.org](https://skilxiv.org) is a public registry of *skills*: versioned,
citeable, executable know-how documents. Oberon uses it in both directions.

**Reading.** At the start of a run, Oberon searches the registry for a skill
matching the task and injects the best match into its context. The effect is
large: on a hard integrability benchmark, a run that took 126 model calls without
a matching skill took 28 with one — the skill supplied the method, the singular
cases, and the sign conventions the model would otherwise have rediscovered by
trial and error.

Skills are treated as **untrusted reference material**: anything Oberon takes
from one must still be reproduced in the kernel before it is recorded. If a
skill's claim turns out to be wrong, the agent files a correction against it
rather than silently working around it.

**Writing.** When a run establishes something genuinely novel, Oberon can draft a
candidate skill from the verified notebook. Nothing is ever published
automatically: candidates land in a local review panel (*Oberon: Review SkilXiv
Contributions*), where you read the draft, and its code must execute cleanly in a
fresh kernel before it can be submitted — as a **private draft** on your account,
which only you can publish.

Relevant settings: `wolfbook.oberon.recall.enabled` (default on),
`wolfbook.oberon.recall.skilxiv.baseUrl`, and
`wolfbook.oberon.director.autoSubmitSkill` (default **off**).

---

## Data and privacy

With Oberon disabled or unconfigured, **nothing leaves your machine**.

When you run it:

- **Your task text and code excerpts go to the LLM provider you configured**
  (DeepSeek, Anthropic, or OpenAI) under that provider's terms.
- **SkilXiv receives** a search query derived from your task when recall is
  enabled, and — only if you explicitly approve a contribution — the skill draft
  you reviewed. Anonymous usage outcomes (whether a recalled skill helped) are
  reported so the registry can rank skills; the task text is not included.
- **Everything else stays local**: notebooks, telemetry (`.oberon/telemetry/`),
  postmortems, and the run ledger are files in your workspace.

Two switches control this: `wolfbook.oberon.recall.enabled` (`false` stops all
SkilXiv lookups) and `wolfbook.oberon.recall.usageTelemetry` (`false` stops the
anonymous outcome reports). Charms marked confidential never report usage at all.

---

## Watching a run

- **Control Room** (sidebar) — live phase, budget, cost, and the current probe.
- **`working.wb`** — opens automatically; cells appear as the agent computes.
  Failed probes stay visible with their errors: the trail is honest.
- **Run Inspector** — per-run telemetry, the plan, and the tool-call transcript.
- **Self-postmortem** — a cell at the end of `working.wb` where the agent reports
  its own account of the run.

---

## Honest limitations

- It is **experimental**. Interfaces, settings, and file layouts change.
- It is **good at bounded, verifiable computation** and much weaker at open-ended
  research judgment. A well-posed task with a checkable answer plays to its
  strengths.
- **It costs money**, and a hard task can cost more than an easy one by an order
  of magnitude. The budget ceilings are there for a reason.
- **Read the `clean.wb`.** It is verified in the sense that it runs and satisfies
  the checks that were stated — that is not the same as being the calculation you
  meant.
