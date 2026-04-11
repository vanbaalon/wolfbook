# Wolfbook Slides

Create and present slide decks directly inside VS Code. Open or create a `.wslide` file and you get a visual editor with drag-and-drop, animations, live preview, and AI assistance — no PowerPoint needed.

---

## Getting Started

1. **Create a deck** — File → New File, save with a `.wslide` extension. The editor opens automatically.
2. **Open an existing deck** — File → Open any `.wslide` file.
3. The editor handles everything from there: the toolbar has **Save**, **Save As…**, **Export HTML**, and **▶ Present**.

---

## Editor Layout

| Area | What it does |
|------|-------------|
| **Toolbar** (top) | Save, export, present, zoom controls, structure overlay, keyboard help (**?** button) |
| **Slide panel** (left) | Thumbnail list of all slides. Drag to reorder. Shows a count badge like *(18, 2 hidden)*. Click **+ Add** to insert a new slide from a template. |
| **Canvas** (center) | The main editing area — a 1920×1080 slide scaled to fit. Click blocks to select, double-click or press Enter to edit text inline. |
| **Props panel** (bottom) | Properties of the selected block: position, size, font, color, layout. Also has the **Add Block** buttons, slide background, transition, speaker notes. |
| **Animation panel** (right) | Drag to reorder animation steps. Cmd+Click any block to add/remove it from the animation sequence. |

---

## Creating Slides

Click **+ Add** in the slide panel to insert a new slide. A template picker appears:

| Template | What you get |
|----------|-------------|
| **Blank** | Empty slide |
| **Title** | Large centered heading |
| **Content** | Heading + body text |
| **Two Column** | Heading + side-by-side columns |
| **Figure + Caption** | Image placeholder + caption text |
| **Code** | Heading + code block |

After inserting, add blocks from the **Add Block** bar at the bottom: Text, Heading, Image, List, H-Split, V-Split, Raw HTML, Code, Arrow.

---

## Editing Blocks

- **Click** a block to select it. A blue outline and resize handles appear.
- **Enter** or double-click to edit text inline — a rich-text toolbar appears with bold, italic, font size, color, math insertion.
- **Drag** resize handles to change size. Use **arrow keys** to nudge position (hold Shift for 10px steps).
- **Cmd+D** duplicates the selected block.
- Use **W/S** keys to navigate between siblings, **D** to enter a container, **A** to go up to the parent.

### Images

- **Paste** (Cmd+V) an image from the clipboard — it's saved automatically.
- **Drag and drop** image files from Finder onto the canvas.
- Click **+ Image…** in the Add Block bar to pick a file.
- Images are stored in an `img/` folder next to your `.wslide` file and cleaned up automatically when no longer used.
- **Save As…** copies images to the new location and rewrites all paths.

### Text & Math

Text blocks support inline HTML and LaTeX math. Write `$E=mc^2$` for inline math or `$$\int_0^\infty$$` for display math — rendered live by KaTeX in the editor and MathJax in exported HTML.

### Containers & Layout

Use **H-Split** and **V-Split** to create multi-column layouts. Containers can be nested: a row container with two column containers is the standard two-column slide. Adjust gap, layout direction, and flex proportions in the Props panel.

---

## Animation

Add reveal animations to make blocks appear step-by-step during presentation:

1. **Cmd+Click** a block to assign it the next animation step.
2. Blocks with step 1 appear on the first click, step 2 on the second click, etc.
3. Blocks without a step are always visible.
4. Multiple blocks can share the same step — they appear together.
5. Use the **Animation panel** (right side) to drag-reorder steps or clear them.
6. **Shift+Click** multiple blocks, then **Cmd+A** to group them into the same animation step.

---

## Presenting

Press **F5** or click **▶ Present** to start:

- VS Code enters **true fullscreen** — all UI (sidebar, tabs, status bar, OS dock) is hidden, just like PowerPoint or watching a movie.
- **Click**, **→**, or **Space** to advance. **←** to go back.
- **Esc** to exit — VS Code's normal interface is restored.
- Hidden slides are automatically skipped.
- A subtle HUD at the bottom shows slide number and step count (fades after 2 seconds).

---

## Speaker Notes

Expand the **Speaker Notes** section at the bottom of the Props panel to add notes for each slide. Notes are:
- Visible only in the editor (not on the canvas).
- Exported as Reveal.js speaker notes (`<aside class="notes">`).
- Available to Copilot for context when editing.

---

## Slide Properties

Each slide has settings in the Props panel:

- **Background** — click to set any CSS color.
- **Transition** — per-slide transition effect (fade, slide, convex, concave, zoom) used in export.
- **Hide Slide** — hides from presentation and export. A ✕ overlay appears on the thumbnail. The toolbar badge shows how many are hidden.

---

## Exporting

Click **Export HTML** to generate a standalone Reveal.js presentation file. It includes all slide content, theme CSS, animations, speaker notes, and transitions. Hidden slides are excluded. Open the exported `.html` in any browser to present.

---

## Find & Replace

- **Cmd+F** opens a search bar to find text across all slides. Use **↑/↓** buttons or **Enter/Shift+Enter** to jump between matches.
- **Cmd+H** extends the search bar with a replace field. Replace one match at a time or all at once.

---

## Zoom

- **Cmd+=** / **Cmd+-** to zoom the canvas in and out.
- **Cmd+0** to reset to auto-fit.
- Or use the **−/+** buttons and percentage indicator in the toolbar. Click the percentage to reset.

---

## Working with Copilot

When a `.wslide` editor is open, Copilot has access to specialized slide tools. You can ask it things like:

- *"List all slides in this deck"*
- *"Get slide 4 and describe its layout"*
- *"Search for 'perturbative expansion' across all slides"*
- *"Add a new blank slide after slide 3"*
- *"Duplicate slide 2"*
- *"Change the background of slide 5 to light blue"*
- *"Move slide 8 to position 2"*
- *"On slide 3, add alt text to the image"*
- *"Export to HTML"*
- *"Rewrite the text on slide 6 to be more concise"*
- *"Check all slides for the word 'preliminary' and tell me where it appears"*

When Copilot edits a slide, the editor automatically navigates to the changed slide and briefly flashes the affected blocks so you can see what changed. A small toast notification confirms the edit.

> **Tip:** you can use Copilot on both a `.wb` Wolfbook notebook and a `.wslide` deck in the same session. Ask it to pull a result from your notebook and insert it as a new slide automatically.

### Available tools

| Tool | Purpose |
|------|---------|
| `wolfslide_getContext` | See all open decks |
| `wolfslide_listSlides` | Overview of every slide |
| `wolfslide_getSlide` | Full details for one slide (by index or ID) |
| `wolfslide_insertSlide` | Add a new slide |
| `wolfslide_editSlide` | Modify a slide's content or properties |
| `wolfslide_duplicateSlide` | Copy a slide with fresh block IDs |
| `wolfslide_deleteSlide` | Remove a slide |
| `wolfslide_moveSlide` | Reorder slides |
| `wolfslide_searchSlides` | Find text across the deck |
| `wolfslide_saveFile` | Save to disk |
| `wolfslide_exportHtml` | Export as Reveal.js HTML |

---

## Keyboard Shortcuts

Press **?** or click the **?** button in the toolbar to see all shortcuts inside the editor.

### General

| Key | Action |
|-----|--------|
| **Cmd+S** | Save |
| **Cmd+Z** / **Cmd+Y** | Undo / Redo |
| **F5** | Present (fullscreen) |
| **Cmd+F** | Find in deck |
| **Cmd+H** | Find & Replace |
| **Cmd+=** / **Cmd+-** / **Cmd+0** | Zoom in / out / reset |
| **?** | Keyboard shortcuts help |

### Block editing

| Key | Action |
|-----|--------|
| **Cmd+C** / **Cmd+X** / **Cmd+V** | Copy / Cut / Paste |
| **Cmd+D** | Duplicate block |
| **Delete** | Delete selected block(s) |
| **Enter** | Edit text inline |
| **Escape** | Deselect / go to parent |
| **+** / **-** | Scale text size or image (Shift = faster) |
| **Arrows** | Nudge position (Shift = 10px, Cmd = resize) |

### Navigation

| Key | Action |
|-----|--------|
| **W** / **S** | Previous / next sibling |
| **D** | Enter child container |
| **A** | Go to parent |
| **Cmd+Click** | Toggle animation step |
| **Shift+Click** | Multi-select blocks |
| **Cmd+A** | Add text block / group-animate selection |

### Presentation

| Key | Action |
|-----|--------|
| **→** / **Space** / **Click** | Next |
| **←** | Previous |
| **Escape** | Exit |

---

## Paste Priority

When you press **Cmd+V**, the editor checks in this order:

1. **Image in clipboard** — always wins. Saved to `img/` and inserted as an image block, even inside an active text edit.
2. **Copied block** (from Cmd+C inside the editor) — inserted as a deep copy with new IDs.
3. **Plain text** — inserted as a new text block.

You can also **drag and drop** images from Finder directly onto the canvas.

---

## Tips

- **Structure overlay** — click the **Structure** button in the toolbar to see dotted outlines around all containers with layout labels. Helpful for debugging nested layouts.
- **Font size warnings** — blocks with font size below 24px show a small ⚠ icon. Text that small is hard to read in a lecture hall.
- The slide count badge in the slide panel header shows total slides and how many are hidden, e.g. *(18, 2 hidden)*.
- Every block can have a **name** (set in the Props panel) for easier identification in the Animation panel and by Copilot.
- LaTeX math uses `$...$` for inline and `$$...$$` for display mode.
