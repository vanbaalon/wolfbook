# Extended VSNB Editor - Development Guide

## Project Overview

This is a custom fork of the Wolfram VSCode extension (`wolframresearch.wolfram`) with enhanced features for notebook editing, output rendering, and kernel control. The extension is published as `customextension.extended-vsnb-editor`.

**Current Version:** 1.1.2

---

## CRITICAL WORKFLOW

**⚠️ ALWAYS follow this workflow:**

1. **Edit** files in: `~/Dropbox/MY/Programming/VSCodeWolframExtension/Extension Development/`
2. **Deploy** to: `~/.vscode/extensions/customextension.extended-vsnb-editor-1.1.2/`
   ```bash
   cp "Extension Development/out/extension/controller.js" \
      ~/.vscode/extensions/customextension.extended-vsnb-editor-1.1.2/out/extension/controller.js
   ```
3. **Reload Window** in VS Code (`Cmd+Shift+P` → "Developer: Reload Window")

**Log file location:** `~/wolfram-kernel-debug.log` (NOT in temp directory!)

---

## Project Structure

### Source Files (Development)
```
/Users/k0959535/Dropbox/MY/Programming/VSCodeWolframExtension/Extension Development/
├── package.json                    # Extension manifest (version, commands, config)
├── resources/
│   ├── init.wl                     # Kernel initialization script (CRITICAL)
│   └── render-html.wl              # HTML rendering for outputs
├── out/
│   └── extension/
│       ├── extension.js            # Extension entry point, command registration
│       ├── controller.js           # Main controller, kernel communication
│       └── ...other compiled files
├── src/                            # TypeScript source files
└── DEVELOPMENT_GUIDE.md            # This file
```

### Deployed Files (Active Extension)
```
~/.vscode/extensions/customextension.extended-vsnb-editor-1.1.2/
├── package.json                    # Deployed manifest
├── resources/
│   ├── init.wl                     # ACTIVE kernel script
│   └── render-html.wl
└── out/
    └── extension/
        ├── extension.js
        ├── controller.js
        └── ...
```

### Backup Location
```
/Users/k0959535/Dropbox/MY/Programming/VSCodeWolframExtension/Extension Backups/
└── wolframresearch.wolfram-2.0.1.backup/    # Original Wolfram extension
```

---

## Deployment Process

**CRITICAL:** Changes to source files do NOT automatically appear in VS Code!

### Manual Deployment Steps

1. **Edit source files** in `Extension Development/`
2. **Deploy to active extension:**
   ```bash
   cp "Extension Development/resources/init.wl" \
      ~/.vscode/extensions/customextension.extended-vsnb-editor-1.1.2/resources/init.wl
   ```
3. **Reload VS Code:** Cmd+Shift+P → "Developer: Reload Window"
4. **Restart kernel** in any open notebook

### What Needs Deployment

- `resources/init.wl` → Requires deployment + VS Code reload + kernel restart
- `out/extension/*.js` → Requires deployment + VS Code reload
- `package.json` → Requires deployment + VS Code reload

---

## Development History & Features

### Phase 1: Output Format Controls (Early)
**Goal:** Add UI controls for output format selection

**Changes:**
- Added `outputFormat` config option (Image/HTML/MathML/InputForm)
- Fixed config not being passed to kernel (`getKernelRelatedConfigs` in controller.js)
- Added format picker in notebook settings UI
- Modified `init.wl` to respect `outputFormat` setting
- Fixed `renderWrapper` function to handle different formats

**Files Modified:** 
- `controller.js`, `extension.js`, `package.json`, `init.wl`

---

### Phase 2: Notebook Customization (Mid)
**Goal:** Add customizable notebook appearance

**Changes:**
- Implemented background color picker with 3-color harmonious scheme
- Colors: Main background, heading background, output background
- Settings stored per-notebook in `.evsnb` file metadata

**Files Modified:**
- `extension.js` (settings commands), `package.json` (UI config)

---

### Phase 3: Output Management (Mid-Late)

#### 3.1 Auto-Clear Empty Outputs
**Issue:** Empty output cells not being cleared after evaluation

**Solution:** Modified `init.wl` to properly clear empty outputs

#### 3.2 Manual Clear Cell Output
**Changes:**
- Added "Clear Cell Output" command and toolbar button
- Clears output for selected cell

**Files Modified:**
- `extension.js`, `controller.js`, `package.json`

#### 3.3 Syntax Error Highlighting
**Issue:** Syntax errors not visually highlighted in code

**Solution:**
- Parse syntax error messages for character position
- Create diagnostic decorations at error location
- Add pulsing red animation to highlight errors
- Clear decorations when user edits cell

**Technical Details:**
- Uses VS Code Diagnostics API
- Regex pattern: `/Syntax error at character (\d+)/`
- Decoration with `backgroundColor: rgba(255, 0, 0, 0.3)`
- Pulsing animation defined in CSS

**Files Modified:**
- `controller.js` (decoration logic), CSS for animation

---

### Phase 4: Kernel Control (Late)

#### 4.1 Restart Override for Abort
**Issue:** After aborting, restart kernel would fail with "still sending abort" error

**Solution:**
- Modified restart handler to immediately reset `isAborting` flag
- Restart now always proceeds regardless of abort state

**Files Modified:**
- `controller.js` (restart handler)

---

### Phase 5: Output Truncation System (Recent)

**Goal:** Handle large outputs gracefully (like Mathematica's behavior)

#### Architecture

**Detection:**
- Use `ByteCount[]` to measure expression size
- Threshold: 10KB (configurable via `outputSizeLimit` config)
- Check happens in `init.wl` before rendering

**Truncation:**
- Full expression stored in `$fullOutputStore` (Association keyed by UUID)
- Truncated version created using `Short[expr, 5]`
- Flag `isTruncated: true` sent with output

**Display:**
- Orange warning box added to output HTML:
  ```html
  <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 10px;">
    ⚠️ Output truncated due to size. Click "Expand Truncated Output" to see full result.
  </div>
  ```

**Expansion Protocol:**
1. User clicks "Expand Truncated Output" button in cell toolbar (next to "Clear Output")
2. Extension sends `expand-output` message with UUID to kernel
3. Kernel retrieves full expression from `$fullOutputStore[uuid]`
4. Kernel renders full expression to HTML
5. Kernel sends `show-full-output` message with full HTML
6. Extension replaces truncated output with full output

**Text File Export (Jupyter-style):**
- **Why:** Extremely large outputs may fail to render even when expanded
- **Implementation:**
  1. User clicks "Open as Text File" button
  2. Kernel exports DIRECTLY to file (no data sent through VS Code messaging)
  3. Only file path sent to frontend
  4. VS Code opens file in text editor
- **File Management:**
  - Location: `$TemporaryDirectory/wolfram-vscode-outputs/`
  - Naming: `wolfram-output-YYYYMMDD-HHMMSS-<uuid>.txt`
  - Format: Mathematica `InputForm` syntax
  - Auto-cleanup: Files older than 7 days deleted on kernel startup
  - Similar to Jupyter's temp file management

**Key Code Locations:**
- Detection: `init.wl` lines ~408-424
- Storage: `init.wl` line 499 (`$fullOutputStore[uuid] = fullExpr`)
- Expansion handler: `init.wl` lines 543-603
- Text export handler: `init.wl` lines 672-710
- Temp file cleanup: `init.wl` lines 64-86 (on kernel startup)
- UI handling: `controller.js` lines 520-543, 652-670
- Text file opener: `controller.js` lines 732-755
- Command: `extension.js` lines 146-163

**Files Modified:**
- `init.wl`, `controller.js`, `extension.js`, `package.json`

---

### Phase 6: Message Filtering (Current)

**Issue:** `Set::wrsym: Symbol $Line is Protected` appearing in output

**Root Cause:**
- Kernel maintains `$Line`, `In[]`, `Out[]` for history
- These symbols are Protected by default
- Must Unprotect → Set → Protect on each evaluation
- `Internal`AddHandler["Message"]` catches ALL messages, even those in `Quiet[]`

**Solutions Attempted:**

1. **Quiet[] wrapper** (FAILED)
   - Wrapped operations in `Quiet[..., {Set::wrsym, ...}]`
   - Message handler still caught messages before Quiet could suppress

2. **displayMessage filter** (FAILED)
   - Added filter in `displayMessage` function to Return[] early
   - Filter checked for Set/Unprotect/Protect::wrsym about $Line/In/Out
   - Debug logs showed filter was never triggered (message not reaching handler)

3. **Off[]/On[] approach** (CURRENT)
   - Completely disable messages with `Off[Set::wrsym, Unprotect::wrsym, Protect::wrsym]`
   - Perform operations
   - Re-enable with `On[...]`
   - This prevents message generation entirely

**Current Code (init.wl ~758-770):**
```wolfram
$lineNumber = $lineNumber + 1;

(* Completely disable these protection messages *)
Off[Set::wrsym, Unprotect::wrsym, Protect::wrsym];
Unprotect[In, Out, $Line];
$Line = $lineNumber + 1;
With[{in = input}, In[$lineNumber] := ReleaseHold[in]];
Out[$lineNumber] = evalRes;
Protect[In, Out, $Line];
On[Set::wrsym, Unprotect::wrsym, Protect::wrsym];
```

**Files Modified:**
- `init.wl` (message filtering and Off/On approach)

---

## Critical Technical Details

### init.wl Message Handler
```wolfram
messageHandler = If[Last[#], displayMessage[#]]&;
Internal`AddHandler["Message", messageHandler];
```

**Important:** This handler intercepts ALL messages before any suppression (Quiet, Off, etc.) can hide them. Filtering must happen inside `displayMessage`.

### Kernel Configuration
Located in `init.wl` around line 110:
```wolfram
$config=<|
  "imageScalingFactor" -> <|"value"-> 0.6, ...>,
  "storeOutputExpressions"-> <|"value"->True, ...>,
  "outputSizeLimit"-> <|"value"->10(*KB*), ...>,
  "outputFormat"-> <|"value"->"MathML", ...>
|>
```

**Access:** `$getKernelConfig["outputSizeLimit"]` returns value in KB

### Output Queue System
- `$outputQueue` holds pending outputs
- `UpdateOutputQueue[]` adds to queue
- `handleOutput[]` processes and sends to extension
- Output types: ExpressionHeader, TextHeader, MessageHeader, InputHeader, OutputHeader

### ZMQ Communication
- Extension ↔ Kernel via ZeroMQ sockets
- Message format: JSON with `type`, `uuid`, `data` fields
- Message types:
  - `evaluate-cell` → Extension to Kernel
  - `evaluation-done` → Kernel to Extension
  - `abort` → Extension to Kernel
  - `expand-output` → Extension to Kernel
  - `show-full-output` → Kernel to Extension

---

## Common Tasks

### Adding a New Command

1. **Define in package.json:**
   ```json
   {
     "command": "wolfram.myCommand",
     "title": "My Command",
     "category": "Wolfram"
   }
   ```

2. **Register in extension.js:**
   ```javascript
   vscode.commands.registerCommand('wolfram.myCommand', () => {
     // Implementation or call to controller
   });
   ```

3. **Deploy and reload**

### Modifying Kernel Behavior

1. **Edit init.wl** in `Extension Development/resources/`
2. **Test logic** in Mathematica if needed
3. **Deploy:**
   ```bash
   cp "Extension Development/resources/init.wl" \
      ~/.vscode/extensions/customextension.extended-vsnb-editor-1.1.2/resources/init.wl
   ```
4. **Reload VS Code + Restart Kernel**

### Debugging

**Kernel Side:**
- Logs written to: `~/wolfram-kernel-debug.log`
- Use `logWriteFile["message"]` in init.wl
- View log: `cat ~/wolfram-kernel-debug.log`
- Watch live: `tail -f ~/wolfram-kernel-debug.log`
- Log is overwritten on each kernel restart

**Extension Side:**
- Use VS Code Developer Console: Help → Toggle Developer Tools
- Use `console.log()` in JS files
- Check output panel: "Wolfram Language Notebook"

---

## Known Issues & Workarounds

### Issue: Changes Don't Apply
**Cause:** Forgot to deploy or reload
**Solution:** Always deploy → reload → restart kernel

### Issue: $Line Protection Message
**Status:** Resolved with Off/On approach
**History:** See Phase 6 above

### Issue: Output Blocking After Truncation
**Status:** Under investigation
**Symptom:** After $Line message, output never appears
**Potential Cause:** Message handler blocking output queue processing

---

## Testing Checklist

After making changes:

- [ ] Deploy files to active extension
- [ ] Reload VS Code window
- [ ] Restart kernel
- [ ] Test basic evaluation (e.g., `2+2`)
- [ ] Test each modified feature
- [ ] Test large outputs if changed truncation
- [ ] Check error handling (syntax errors, etc.)
- [ ] Check kernel logs for errors

---

## Version History

**1.1.2** (Current)
- Output truncation with expansion
- ByteCount threshold at 10KB (testing)
- Off/On message suppression for $Line
- Debug logging throughout

**1.1.1**
- Syntax error highlighting with animation
- Clear decorations on edit
- Restart override for abort

**1.1.0**
- Output format controls (MathML/HTML/Image/InputForm)
- Notebook color customization
- Auto-clear empty outputs
- Manual clear cell output

**1.0.0**
- Fork of wolframresearch.wolfram-2.0.1
- Basic notebook support

---

## Future Development Notes

### Potential Improvements
- Optimize truncation threshold (currently 10KB for testing)
- Add "Show More" option for progressive output loading
- Implement output caching for repeated evaluations
- Better error recovery when kernel hangs
- Progressive rendering for very large outputs

### Architecture Considerations
- Message handler runs before any suppression → filter in handler or disable globally
- ByteCount is faster than LeafCount for size detection
- ZMQ communication is synchronous → long operations block
- Decorations cleared on document change → use event listeners

---

## Emergency Recovery

If extension is completely broken:

1. **Restore original extension:**
   ```bash
   cp -r "Extension Backups/wolframresearch.wolfram-2.0.1.backup" \
         ~/.vscode/extensions/
   ```

2. **Disable custom extension:**
   - Extensions panel → Find "Extended VSNB Editor"
   - Click "Disable" or "Uninstall"

3. **Reload VS Code**

---

## Contact & Contribution

This is a personal fork for research use. The base extension is:
- **Original:** WolframResearch/vscode-wolfram
- **License:** MIT (see LICENSE.txt)

Keep this document updated as development continues!

---

**Last Updated:** February 17, 2026
**Maintained by:** Development session with GitHub Copilot (Claude Sonnet 4.5)
