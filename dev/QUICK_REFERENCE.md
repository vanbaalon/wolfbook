# Quick Reference - Extended VSNB Editor

## Quick Deployment

```bash
# Deploy init.wl (most common)
cp "Extension Development/resources/init.wl" \
   ~/.vscode/extensions/customextension.extended-vsnb-editor-1.1.2/resources/init.wl

# Then: Reload VS Code + Restart Kernel
```

## File Locations

| File Type | Source | Deployed (Active) |
|-----------|--------|-------------------|
| Kernel init | `Extension Development/resources/init.wl` | `~/.vscode/extensions/customextension.extended-vsnb-editor-1.1.2/resources/init.wl` |
| Extension code | `Extension Development/out/extension/*.js` | `~/.vscode/extensions/customextension.extended-vsnb-editor-1.1.2/out/extension/*.js` |
| Config | `Extension Development/package.json` | `~/.vscode/extensions/customextension.extended-vsnb-editor-1.1.2/package.json` |

## Key Code Locations

| Feature | File | Lines |
|---------|------|-------|
| Message filtering | init.wl | 63-78 |
| Output truncation detection | init.wl | 408-424 |
| Truncation storage | init.wl | 537 |
| Expansion handler | init.wl | 594-670 |
| Open-as-text handler | init.wl | 672-710 |
| $Line assignment | init.wl | 808-820 |
| Kernel config | init.wl | 110-112 |
| Syntax error highlighting | controller.js | ~line 400-450 |
| Truncated output UI (with %) | controller.js | 562-600 |
| Output expansion | controller.js | 690-730 |
| Open text file | controller.js | 732-755 |
| Renderer buttons | index-with-messaging.js | 15-60 |

## Important Variables

**init.wl:**
- `$config` - Kernel configuration (outputFormat, outputSizeLimit, etc.)
- `$outputQueue` - Queue of pending outputs
- `$lineNumberByUUID` - Association mapping UUID → line number for Out[] retrieval
- `$lineNumber` - Current evaluation line number
- `$Line`, `In[]`, `Out[]` - Kernel history (Protected symbols)

**controller.js:**
- `truncatedOutputCells` - Map of UUID → {cell, outputIndex} for expansion
- `lastTruncatedExecution` - Reference to last truncated output

## Config Values

```wolfram
$config=<|
  "imageScalingFactor" -> 0.6,
  "storeOutputExpressions" -> True,
  "outputSizeLimit" -> 10,  (* KB *)
  "outputFormat" -> "MathML"  (* or "HTML", "Image", "InputForm" *)
|>
```

## Debugging Logs

**Find kernel log:**
```bash
# Log location (consistent across restarts)
cat ~/wolfram-kernel-debug.log

# Watch live
tail -f ~/wolfram-kernel-debug.log

# View recent entries
tail -100 ~/wolfram-kernel-debug.log
```

**Add debug logging:**
```wolfram
logWriteFile["[DEBUG] My message: " <> ToString[value] <> "\n"];
```

## Message Types (ZMQ)

| Type | Direction | Purpose |
|------|-----------|---------|
| `evaluate-cell` | Extension → Kernel | Request evaluation |
| `evaluation-done` | Kernel → Extension | Evaluation complete |
| `abort` | Extension → Kernel | Cancel evaluation |
| `restart` | Extension → Kernel | Restart kernel |
| `expand-output` | Extension → Kernel | Request full output (inline) |
| `show-full-output` | Kernel → Extension | Send full output HTML |
| `open-as-text` | Extension → Kernel | Request full output as text file |
| `open-text-file` | Kernel → Extension | Send text file path to open |
| `config-update` | Extension → Kernel | Update config value |

**Renderer Messages (postMessage API):**
| Type | Direction | Purpose |
|------|-----------|---------|
| `expand-truncated-output` | Renderer → Controller | User clicked "Expand Inline" |
| `open-truncated-as-text` | Renderer → Controller | User clicked "Open as Text File" |

## Common Patterns

### Check if output exceeds limit
```wolfram
exceedsExprSize = !TrueQ[ByteCount[expr] <= $getKernelConfig["outputSizeLimit"]*2^10];
```

### Store full output
```wolfram
$fullOutputStore[uuid] = fullExpression;
```

### Send message to extension
```wolfram
sendMessage[<|
  "type" -> "my-message-type",
  "data" -> "my data"
|>];
```

### Update output queue
```wolfram
UpdateOutputQueue[ExpressionHeader[expr]];
handleOutput[];
```

## Testing Commands

**In Wolfram notebook:**
```wolfram
(* Test basic evaluation *)
2 + 2

(* Test truncation - should trigger at 10KB *)
Range[1000]

(* Test large output - may trigger *)
Range[10000]

(* Test wrap toggle - creates wide output *)
Sum[x^i, {i, 1, 50}]

(* Test syntax error highlighting *)
Print[xxx  (* Missing closing bracket *)

(* Test format output *)
Plot[Sin[x], {x, 0, 10}]
```

## Truncation Features

**When outputs are truncated (ByteCount > 10KB AND LeafCount > 500):**

1. **Percentage Display** - Shows what % of output is visible
   - Example: "Showing 15% of output (1.5 KB / 10.2 KB)"
   - **Measurement**: ByteCount of rendered HTML/MathML (what you actually see)
   - **Accurate**: Compares actual display size, not internal expression overhead
   - **Capped**: Shows "~100%" if calculated percentage exceeds 100% (can happen with rendering overhead)
   
2. **Expand Inline** - Replaces truncated output with full rendered version
   - Button shows "⏳ Expanding..." while processing
   - Retrieves from `Out[$lineNumber]`
   - Renders using MathML/SVG
   - Updates cell in place
   - **Timeout**: 30 seconds (increased for large outputs like Range[1000])
   - **Error Handling**: Shows helpful message if timeout/memory/crash occurs
   - **Recommendation**: For very large outputs (>1000 elements), use "Open as Text File" instead

3. **Open as Text File** - Opens full output in temporary Wolfram Language Script file
   - Button shows "⏳ Opening..." while processing
   - Uses `InputForm` (Mathematica syntax)
   - **Direct export**: Kernel writes directly to file, NO data passed through VS Code
   - File location: `$TemporaryDirectory/wolfram-vscode-outputs/`
   - Filename: `wolfram-output-YYYYMMDD-HHMMSS-<uuid>.wls`
   - Opens in VS Code editor with Wolfram Language syntax highlighting
   - Useful for very large outputs or copying data
   - **Auto-cleanup**: Files older than 7 days deleted on kernel startup (like Jupyter)

**UI Details:**
- Truncation message shows: "📦 Output Truncated"
- Two interactive buttons with visual feedback
- UUID not displayed (internal implementation detail)

**Storage:**
- Full results stored in kernel's `Out[]` history
- Mapping: `$lineNumberByUUID[uuid] = $lineNumber`
- Always accessible via `Out[n]` even after truncation

**Rendering:**
- MathML output: 100% font size (normal), with horizontal scroll for wide expressions
- SVG output: Graphics and plots wrapped in `<div class="wexpr">`
- Auto-scroll: Wide outputs get horizontal scrollbar instead of extending off-screen
- **Wrap toggle**: Click the "⤓ Wrap" button (top-right of MathML output) to force-wrap to screen width
  - Toggles between scroll mode (horizontal scrollbar) and wrap mode (forced wrapping)
  - Useful for viewing long expressions without scrolling

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Changes not applying | Deploy → Reload VS Code → Restart kernel |
| $Line error messages | Check Off/On in init.wl line ~758 |
| Output not appearing | Check kernel log for errors |
| Truncation not working | Check outputSizeLimit config value |
| Expansion not working | Check $fullOutputStore, ensure UUID matches |
| Kernel hangs | Abort then restart kernel |

## Critical Reminders

⚠️ **Always deploy after editing source files**

⚠️ **Reload VS Code after deploying**

⚠️ **Restart kernel after deploying init.wl**

⚠️ **Check kernel logs when debugging**

⚠️ **ByteCount returns bytes, config is in KB**

---

For detailed information, see [DEVELOPMENT_GUIDE.md](DEVELOPMENT_GUIDE.md)
