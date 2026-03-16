# Wolfbook: Fix Notebook Cell Execution Scrolling

## Problem

When the user presses Shift+Enter to execute a cell, VSCode's built-in `notebook.cell.executeAndSelectBelow` command scrolls the viewport to the next cell, losing the user's position. We need to override this command so that execution happens but the viewport stays anchored to the current position.

## Background (from VSCode source analysis)

There are three independent scroll mechanisms inside VSCode notebooks:

1. **`handleAutoReveal`** — fires once at command dispatch time; positions the viewport so the executing cell is visible. Uses `setScrollTop` with 20px top / 60px bottom padding.
2. **Scroll anchoring in `NotebookCellList`** — fires when cell heights change (output growth). Adjusts `scrollTop` to keep an anchor element stable.
3. **`revealNextCellOnExecute`** — specific to `executeAndSelectBelow`. Reveals the next cell after execution. Controlled by the `notebook.scrolling.revealNextCellOnExecute` setting (values: `"fullCell"`, `"firstLine"`, `"none"`).

Key finding: `notebook.cell.execute` and `notebook.cell.executeAndSelectBelow` trigger the **same** `NotebookController.executeHandler`. There is no difference in how output streaming works between them. The streaming concern is unfounded.

## Chosen Strategy

**Override `notebook.cell.executeAndSelectBelow` with a custom command** that:

1. Saves the current viewport anchor and selection
2. Dispatches `notebook.cell.execute` (avoids mechanism 3 entirely)
3. Restores viewport position once after execution completes

This is the most robust approach because:
- It eliminates the `revealNextCellOnExecute` scroll entirely (mechanism 3)
- It corrects the one-time `handleAutoReveal` scroll (mechanism 1) with a single restore
- It doesn't fight mechanism 2 continuously — instead it applies one final correction
- It uses `notebook.cell.execute` which has identical streaming behavior
- It is self-contained and doesn't require users to change settings

## Implementation Plan

### Step 1: Create the scroll-preservation utility module

Create a new file `src/notebook/executionScroll.ts` (or place the logic in whatever module currently handles notebook command overrides).

```typescript
// src/notebook/executionScroll.ts

import * as vscode from 'vscode';

/**
 * Executes the current notebook cell while preserving the viewport scroll position.
 * 
 * Replaces the default notebook.cell.executeAndSelectBelow behavior which
 * aggressively scrolls to the next cell after execution.
 * 
 * Architecture:
 * - Uses notebook.cell.execute (identical execution pipeline, no next-cell reveal)
 * - Saves viewport anchor before execution
 * - Restores viewport once after execution completes via onDidChangeCellExecutionState
 * - Restores cell selection to prevent focus jumping
 */
export async function executeAndPreserveScroll(): Promise<void> {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) {
        return;
    }

    // --- Save state ---
    const savedVisibleRange = editor.visibleRanges[0];
    const savedSelections = [...editor.selections];

    // --- Execute the cell ---
    // notebook.cell.execute triggers the same executeHandler as executeAndSelectBelow.
    // It does NOT break streaming output — this is confirmed from VSCode source.
    // The only difference is it does not select/reveal the next cell.
    await vscode.commands.executeCommand('notebook.cell.execute');

    // --- Restore state after execution completes ---
    // Use onDidChangeCellExecutionState to detect when execution finishes.
    // This is more reliable than setTimeout because it waits for the actual
    // execution lifecycle, not an arbitrary delay.
    const disposable = vscode.notebooks.onDidChangeCellExecutionState(e => {
        if (e.state === vscode.NotebookCellExecutionState.Idle) {
            disposable.dispose();

            // Restore viewport position
            if (savedVisibleRange) {
                editor.revealRange(
                    savedVisibleRange,
                    vscode.NotebookEditorRevealType.AtTop
                );
            }

            // Restore selection so focus doesn't jump
            if (savedSelections.length > 0) {
                editor.selections = savedSelections;
            }
        }
    });
}
```

### Step 2: Register the command override

In the extension's `activate` function (likely `src/extension.ts` or `src/notebook/notebookProvider.ts` — wherever notebook-related commands are registered), register the override:

```typescript
// In activate():

const executeOverride = vscode.commands.registerCommand(
    'notebook.cell.executeAndSelectBelow',
    executeAndPreserveScroll
);
context.subscriptions.push(executeOverride);
```

**Important**: This overrides the built-in command globally for the VSCode instance. The override only takes effect because we register a command with the same ID. VSCode allows extensions to shadow built-in commands this way.

If Wolfbook already has a command override for `notebook.cell.executeAndSelectBelow`, replace the existing handler body with the logic from `executeAndPreserveScroll`. Do not create a duplicate registration.

### Step 3: Handle the edge case — execution that doesn't transition to Idle

If the kernel crashes or the execution is cancelled, the `onDidChangeCellExecutionState` listener might never fire with `Idle`. Add a timeout safety net:

```typescript
export async function executeAndPreserveScroll(): Promise<void> {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) {
        return;
    }

    const savedVisibleRange = editor.visibleRanges[0];
    const savedSelections = [...editor.selections];

    await vscode.commands.executeCommand('notebook.cell.execute');

    // Safety timeout: if execution state never reaches Idle (crash, cancel),
    // clean up after 30 seconds to prevent a leaked listener.
    let disposed = false;

    const cleanup = () => {
        if (disposed) return;
        disposed = true;
        disposable.dispose();
        clearTimeout(safetyTimeout);

        if (savedVisibleRange && editor === vscode.window.activeNotebookEditor) {
            editor.revealRange(
                savedVisibleRange,
                vscode.NotebookEditorRevealType.AtTop
            );
        }
        if (savedSelections.length > 0 && editor === vscode.window.activeNotebookEditor) {
            editor.selections = savedSelections;
        }
    };

    const disposable = vscode.notebooks.onDidChangeCellExecutionState(e => {
        if (e.state === vscode.NotebookCellExecutionState.Idle) {
            cleanup();
        }
    });

    const safetyTimeout = setTimeout(cleanup, 30_000);
}
```

### Step 4: Also contribute the `revealNextCellOnExecute` default (belt and suspenders)

In `package.json`, contribute a configuration default so that even if the command override is somehow bypassed, the built-in scroll behavior is minimised:

```jsonc
// In package.json → "contributes" → "configuration":
{
    "properties": {
        "notebook.scrolling.revealNextCellOnExecute": {
            "type": "string",
            "default": "none",
            "description": "Controls how much of the next cell is revealed after Shift+Enter. Wolfbook sets this to 'none' to prevent viewport jumping."
        }
    }
}
```

**Note**: Check whether Wolfbook already contributes configuration properties and add this there. If contributing to the `notebook.scrolling` namespace causes a conflict with VSCode's own property, instead set it programmatically in `activate`:

```typescript
const config = vscode.workspace.getConfiguration('notebook.scrolling');
const current = config.get<string>('revealNextCellOnExecute');
if (current !== 'none') {
    await config.update('revealNextCellOnExecute', 'none', vscode.ConfigurationTarget.Global);
}
```

### Step 5: Verify streaming output still works

After implementing, verify with a test cell that produces streaming output. In the Wolfbook kernel (WSTP), create a cell that calls `appendOutput` multiple times with delays:

```
(* Test cell for streaming verification *)
Do[
  Print[i];
  Pause[0.5],
  {i, 1, 10}
]
```

Verify that:
- [ ] Each `Print` output appears incrementally as it's produced
- [ ] The viewport does NOT jump to the next cell during execution
- [ ] The viewport does NOT jump to the next cell after execution completes
- [ ] If the user manually scrolls during execution, the viewport stays where the user scrolled (the restore only fires once at Idle, and by that point the user's scroll is the latest state — see refinement below)

### Step 6 (refinement): Respect user scrolling during execution

If the user scrolls manually while the cell is executing, we should NOT snap them back. Detect this by comparing the viewport at the moment of restoration:

```typescript
const disposable = vscode.notebooks.onDidChangeCellExecutionState(e => {
    if (e.state === vscode.NotebookCellExecutionState.Idle) {
        disposable.dispose();
        clearTimeout(safetyTimeout);

        // Only restore if the viewport hasn't moved far from where we saved it.
        // If the user has scrolled away, respect their intent.
        const currentRange = editor.visibleRanges[0];
        if (
            savedVisibleRange &&
            currentRange &&
            editor === vscode.window.activeNotebookEditor
        ) {
            const drift = Math.abs(currentRange.start - savedVisibleRange.start);
            // If viewport drifted by more than 2 cells, assume user scrolled intentionally
            if (drift <= 2) {
                editor.revealRange(
                    savedVisibleRange,
                    vscode.NotebookEditorRevealType.AtTop
                );
            }
        }

        if (savedSelections.length > 0 && editor === vscode.window.activeNotebookEditor) {
            editor.selections = savedSelections;
        }
    }
});
```

## Final file structure

```
src/
  notebook/
    executionScroll.ts    ← NEW: the executeAndPreserveScroll function
  extension.ts            ← MODIFIED: register the command override in activate()
package.json              ← MODIFIED: optionally contribute revealNextCellOnExecute default
```

## Checklist for Copilot

1. [ ] Create `src/notebook/executionScroll.ts` with the `executeAndPreserveScroll` function (Step 3 version with safety timeout)
2. [ ] Add the drift-detection refinement from Step 6 into the function
3. [ ] Import and register the command in `activate()` — find the existing `notebook.cell.executeAndSelectBelow` override if one exists and replace its body
4. [ ] Add the `revealNextCellOnExecute` configuration default or programmatic set (Step 4)
5. [ ] Do NOT remove or modify any existing `appendOutput` / `replaceOutput` calls in the kernel — streaming is unaffected by this change
6. [ ] Test with a streaming-output cell and a single-output cell
7. [ ] Test that manual user scrolling during execution is respected (drift > 2 cells → don't restore)