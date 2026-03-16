import json

path = 'package.json'
with open(path) as f:
    p = json.load(f)

new_tools = [
    {
        "name": "wolfbook_deleteCell",
        "displayName": "Wolfbook: Delete Cell",
        "toolReferenceName": "wolfbookDelete",
        "modelDescription": "Deletes a cell from the active Wolfram notebook. The deleted cell's content is saved to ai_deleted_cells.md in the img/<notebook>/ directory for recovery. Call wolfbook_getNotebookContext first to confirm the correct cell number before deleting. Use this to remove redundant, broken, or superseded cells during notebook cleanup.",
        "canBeReferencedInPrompt": True,
        "inputSchema": {
            "type": "object",
            "properties": {
                "cellNumber": {
                    "type": "number",
                    "description": "1-based cell number to delete (from wolfbook_getNotebookContext)."
                },
                "saveToRecovery": {
                    "type": "boolean",
                    "description": "If true (default), save the deleted cell content to ai_deleted_cells.md before removing it."
                }
            },
            "required": ["cellNumber"]
        }
    },
    {
        "name": "wolfbook_editCell",
        "displayName": "Wolfbook: Edit Cell",
        "toolReferenceName": "wolfbookEdit",
        "modelDescription": "Replaces the source code of an existing cell in the active Wolfram notebook. Use this to fix bugs, update expressions, or refine output formatting in cells that have already been inserted. Call wolfbook_getNotebookContext first to confirm cell numbers and current source. Set evaluate:true to immediately run the updated content in the kernel and confirm the result. IMPORTANT: the content string must be syntactically correct Wolfram Language exactly as it should appear in the cell. Do NOT add extra blank lines between statements just to look pretty — write multi-statement code as a compact block.",
        "canBeReferencedInPrompt": True,
        "inputSchema": {
            "type": "object",
            "properties": {
                "cellNumber": {
                    "type": "number",
                    "description": "1-based cell number to edit (from wolfbook_getNotebookContext)."
                },
                "content": {
                    "type": "string",
                    "description": "The new source text for the cell. Write it exactly as it should appear in the cell — do NOT add extra blank lines between statements to format it nicely, as this creates invalid syntax for single-expression inputs. Multi-line constructs like Module[...] are fine as long as brackets match."
                },
                "evaluate": {
                    "type": "boolean",
                    "description": "If true (and the cell is a code cell), evaluate the new content in the live kernel immediately after editing and include the result in the response."
                },
                "timeoutSeconds": {
                    "type": "number",
                    "description": "Maximum seconds to wait for evaluation when evaluate:true (default: 15)."
                }
            },
            "required": ["cellNumber", "content"]
        }
    },
    {
        "name": "wolfbook_runCell",
        "displayName": "Wolfbook: Run Cell",
        "toolReferenceName": "wolfbookRun",
        "modelDescription": "Executes an existing notebook cell through the normal Wolfbook execution pipeline (equivalent to the user pressing Shift+Enter on it), waits for completion, and returns the cell's text/plain output. Unlike wolfbook_evaluateExpression, this runs the cell in-place so the result is stored as the cell's output in the notebook and visible to the user. Use this to re-run a cell after editing it with wolfbook_editCell, or to run a setup cell whose definitions are needed by later cells.",
        "canBeReferencedInPrompt": True,
        "inputSchema": {
            "type": "object",
            "properties": {
                "cellNumber": {
                    "type": "number",
                    "description": "1-based cell number to run (from wolfbook_getNotebookContext)."
                },
                "timeoutSeconds": {
                    "type": "number",
                    "description": "Maximum seconds to wait for the execution to finish (default: 30)."
                }
            },
            "required": ["cellNumber"]
        }
    },
    {
        "name": "wolfbook_getKernelState",
        "displayName": "Wolfbook: Get Kernel State",
        "toolReferenceName": "wolfbookState",
        "modelDescription": "Returns a summary of the current Wolfram kernel state: all user-defined symbols matching a context pattern, showing their values (for direct assignments) or rule counts (for functions with DownValues). Default pattern 'Global`*' shows everything defined interactively. Use a narrower pattern like 'QSC`*' to inspect a specific package context. Call this before inserting or editing code to understand what is already defined and avoid naming conflicts.",
        "canBeReferencedInPrompt": True,
        "inputSchema": {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Wolfram context pattern to match symbols against (default: 'Global`*'). Examples: 'Global`*', 'QSC`*', 'Global`Q*'."
                }
            },
            "required": []
        }
    },
    {
        "name": "wolfbook_saveNotebook",
        "displayName": "Wolfbook: Save Notebook",
        "toolReferenceName": "wolfbookSaveNotebook",
        "modelDescription": "Saves the active Wolfram notebook to disk. Call this after a batch of cell insertions, edits, or deletions to persist the changes. The file is saved to its current path — no dialog is shown and the user does not need to intervene.",
        "canBeReferencedInPrompt": True,
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    }
]

tools = p['contributes']['languageModelTools']
# Avoid duplicates on re-run
existing_names = {t['name'] for t in tools}
added = 0
for t in new_tools:
    if t['name'] not in existing_names:
        tools.append(t)
        added += 1

with open(path, 'w') as f:
    json.dump(p, f, indent='\t', ensure_ascii=False)
    f.write('\n')

print(f"Added {added} tools. Total now: {len(tools)}")
for t in tools:
    print(f"  {t['name']}")
