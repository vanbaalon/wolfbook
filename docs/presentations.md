# Presentations — the `.wslide` Format

→ [Back to README](../README.md)

Since recently, Wolfbook includes a purpose-built presentation format: `.wslide` files are JSON-based slide decks rendered via Reveal.js inside VS Code, with KaTeX math, live Wolfram Language eval blocks, and the same btl math renderer as the notebook. The entire format is designed to be created and edited by AI agents, tool call by tool call.

---

## What makes `.wslide` different

| Feature | Standard PowerPoint / Beamer | Wolfbook `.wslide` |
|---|---|---|
| Format | Binary / LaTeX source | JSON — fully `git diff`-able |
| Math rendering | Manual / compile cycle | LaTeX, live in VS Code |
| Live computation | No | Wolfram Language eval blocks run in the live kernel |
| Math output | Copy-paste from Mathematica | btl renderer: typeset LaTeX inline, no copy-paste |
| AI editing | Chat only | 12 MCP tools for agents to create/edit/inspect |
| Version control | Difficult | Full git support |

---

## Anatomy of a slide

Each slide has:
- A **title** and optional subtitle
- A set of **content blocks**: bullet lists, text, code, math, images, Wolfram eval cells
- Optional **fragment ordering** for step-by-step animation (each bullet can appear on a keypress)
- Optional **two-column layout**

A Wolfram eval block in a slide works exactly like a code cell in a notebook: press evaluate, the result renders as typeset math via the btl pipeline — no image export, no copy-paste from Mathematica.

---

## Agent Tool API (12 tools)

Wolfbook exposes 12 MCP tools for creating and editing `.wslide` files. Any MCP-compatible agent (GitHub Copilot in Agent mode, Claude Code, Codex, etc.) can use them.

### Slide editing

| Tool | What it does |
|---|---|
| `wolfslide_editSlide` | Edit the title, layout, or metadata of an existing slide |
| `wolfslide_block` | Add or modify a content block on a slide |
| `wolfslide_bulkInsert` | Insert multiple blocks at once (more efficient for large edits) |
| `wolfslide_deleteSlide` | Remove a slide |
| `wolfslide_insertSlide` | Insert a new slide at a given position |

### Inspection and assets

| Tool | What it does |
|---|---|
| `wolfslide_getContext` | Read the full presentation — all slides and their blocks |
| `wolfslide_listSlides` | List all slides with titles and block counts |
| `wolfslide_getSlide` | Read a specific slide's full content |
| `wolfslide_advanced` | Advanced operations (batch operations, slide reordering) |
| `wolfslide_imageAsset` | Upload, list, or reference image assets in the presentation |

### Theme and export

| Tool | What it does |
|---|---|
| `wolfslide_setTheme` | Change the Reveal.js theme (dark, light, custom) |
| `wolfslide_exportHtml` | Export the presentation to a standalone HTML file |

---

## Creating a presentation with an agent

### Step 0 — Tool discovery

Before asking the agent to build anything, have it probe its tools:

```
List all the wolfslide tools available to you. Call each one on a trivial example 
so you understand its interface.
```

### Step 1 — Brief the agent

Describe your presentation in a structured prompt:

```
Create a 10-slide presentation on the Quantum Spectral Curve for AdS₃/CFT₂.
The audience is theoretical physicists familiar with integrability.

Slides needed:
1. Title slide
2. Motivation: why AdS₃?
3. The QSC framework — key equations
4. Our main result: full coupling range numerics (plot)
5. Strong coupling limit and comparison to string theory
6–9. Key steps in the derivation
10. Summary and outlook

Use the wolfslide tools to build the presentation. Include KaTeX math throughout.
For slide 4, write a Wolfram eval block that produces the numerical plot.
Use the dark theme.
```

### Step 2 — Iterate

The agent will call tools to build the slides. You can ask for revisions:

```
Add step-by-step animation to slide 3 — each equation should appear on a keypress.
```
```
The plot on slide 4 needs better axis labels. Edit the eval block.
```
```
Add our paper reference to the footer of every slide.
```

### Step 3 — Export

```
Export the presentation to standalone HTML so I can show it without VS Code.
You can also export to PDF, with animation stages on different pages.
```

---

## Math in slides

Use standard KaTeX syntax in text blocks:

- Inline: `$\Delta(S) = 2 + S + \ldots$`
- Display: `$$E - S = f(g) \ln S + \ldots$$`

For Wolfram Language output in slides, use an eval block — the output is typeset via the btl renderer and appears inline on the slide. No screenshotting, no copy-pasting from Mathematica.

---

## Tips

**Verify physics in the slide.** If a slide contains a formula, add an eval block that checks a special case. Audience members with laptops can re-derive results live.

**Keep eval blocks short.** Long computations in slides are distracting. Pre-compute heavy results in a companion `.wb` notebook and display only the output in the slide.

**Use fragment order for derivations.** When walking through a multi-step argument, set `fragmentOrder` so each step appears on a keypress — this controls the audience's attention.

**Version control your `.wslide` file.** It is plain JSON, so `git diff` shows exactly what changed between versions. Commit after each working stage.
