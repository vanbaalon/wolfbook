(* Wolfram Kernel Initialization Script - WSTP mode *)
(* No ZeroMQ - installs rendering helpers called by JS via session.sub() *)

(* ===== Logging ===== *)
$logDir = FileNameJoin[{$UserBaseDirectory, "ApplicationData", "wolfbook"}];
If[!DirectoryQ[$logDir], Quiet[CreateDirectory[$logDir, CreateIntermediateDirectories -> True]]];
$logPath = FileNameJoin[{$logDir, "kernel.log"}];

logWrite[msg_String] := Quiet[Module[{s},
    s = OpenAppend[$logPath];
    WriteString[s, DateString[] <> " " <> msg <> "\n"];
    Close[s]
]];
logWriteFile[msg_String, file_String] := logWrite["[" <> file <> "] " <> msg];
logError[msg_String]  := logWrite["ERROR: " <> msg];

(* ===== Temporary output directory ===== *)
$wolframOutputTempDir = FileNameJoin[{$TemporaryDirectory, "wolfbook_output"}];
If[!DirectoryQ[$wolframOutputTempDir],
    Quiet[CreateDirectory[$wolframOutputTempDir, CreateIntermediateDirectories -> True]]];

(* Clean files older than 7 days *)
Quiet[Module[{files, now},
    files = FileNames["*", $wolframOutputTempDir];
    now = AbsoluteTime[];
    Do[If[AbsoluteTime[FileDate[f]] < now - 7*86400, DeleteFile[f]], {f, files}]
]];

(* ===== Per-notebook image directory ===== *)
(* Set by controller before each cell execution via VsCodeSetImgDir.              *)
(* SVG/PNG outputs are written as individual files; embedded via relative src=    *)
(* so the VS Code webview resolves them relative to the notebook directory.       *)
$wolframImgDir      = "";   (* absolute path — used for file I/O and GC         *)
$wolframImgRelPrefix = "";  (* relative prefix, e.g. "img/MyNotebook"            *)

VsCodeSetImgDir[dir_String, relPrefix_String] := Module[{},
    $wolframImgDir       = dir;
    $wolframImgRelPrefix = relPrefix;
    If[StringLength[dir] > 0 && !DirectoryQ[$wolframImgDir],
        Quiet[CreateDirectory[$wolframImgDir, CreateIntermediateDirectories -> True]]];
    Null
];

(* Backward-compat overload (no relPrefix): derive it from the last two path components *)
VsCodeSetImgDir[dir_String] := Module[{parts},
    parts = FileNameSplit[dir];
    VsCodeSetImgDir[dir,
        If[Length[parts] >= 2,
           parts[[-2]] <> "/" <> parts[[-1]],
           dir]
    ]
];

(* GC: delete every *.svg / *.png in $wolframImgDir that is NOT in keepPaths.    *)
(* Called by controller after each cell execution once new outputs are committed. *)
VsCodeCleanupImgDir[keepPaths_List] := Quiet[Module[{all},
    If[!DirectoryQ[$wolframImgDir], Return[Null]];
    all = FileNames["*.svg", $wolframImgDir] ~Join~ FileNames["*.png", $wolframImgDir];
    Do[If[!MemberQ[keepPaths, f], DeleteFile[f]], {f, all}]
]];

(* ===== Version check ===== *)
If[$VersionNumber < 12,
    logError["Wolfram version " <> ToString[$VersionNumber] <> " < 12, some features may not work"]];

(* ===== CodeParser availability ===== *)
$hasCodeParser = Quiet[Check[Needs["CodeParser`"]; True, False]];

(* ===== Configuration ===== *)
$config = <|
    "outputFormat"       -> "Auto",
    "imageScale"         -> 0.8,
    "useSVG"             -> True,
    "showPrint"          -> True,
    "maxOutputLength"    -> 100000,
    "outputSizeLimit"    -> 200,   (* KB of ByteCount; expressions larger than this use Short[] for display *)
    "truncatedTooltip"   -> "Output truncated. Click \"Expand Inline\" to render in full.",
    "autoOpenMessages"   -> False
|>;

$setKernelConfig[name_String, value_] := ($config[name] = value; Null);
$getKernelConfig[name_String]           := Lookup[$config, name, Missing["NotFound", name]];
$getKernelConfig[name_String, default_] := Lookup[$config, name, default];

(* ===== Helpers ===== *)
makeWrapButton[label_String, uuid_String, action_String] :=
    "<button class=\"vscode-wolfram-btn\" data-uuid=\"" <> uuid <>
    "\" data-action=\"" <> action <> "\">" <> label <> "</button>";

UseSvgQ[] := TrueQ[$getKernelConfig["useSVG", True]];

cleanMathML[s_String] := StringReplace[s,
    "<math>" -> "<math xmlns=\"http://www.w3.org/1998/Math/MathML\">"];

(* Strip SVG 1.1 <font> elements and replace Wolfram custom font-family names
   with web-safe equivalents.  Chrome/Electron dropped SVG <font> support; when
   those blocks are present the browser falls back to a system font using its own
   glyph mapping, which often produces wrong characters (e.g. "20"->"He").      By removing the <font> blocks and naming real system fonts, text always renders
   with correct characters via the standard Unicode mapping. *)
vscodeStripSVGFonts[s_String] := Module[{r},
    r = s;
    (* Remove SVG <font ...> ... </font> definition blocks *)
    r = StringReplace[r, Shortest["<font" ~~ __ ~~ "</font>"] -> ""];
    (* Remove any stray standalone <font-face .../> elements *)
    r = StringReplace[r, Shortest["<font-face" ~~ __ ~~ "/>"] -> ""];
    (* Map Wolfram custom font families to browser-safe equivalents *)
    r = StringReplace[r, {
        "MathematicaMono-Regular" -> "\"Courier New\", Courier, monospace",
        "MathematicaSans-Regular" -> "Arial, Helvetica, sans-serif",
        "Mathematica1-Bold"       -> "serif",
        "Mathematica1"            -> "serif"
    }];
    r
];

(* ===== Render a single result expression as HTML string ===== *)
mathematicaformatResult[expr_] := Module[{boxes, svgStr, mathmlStr},
    (* SVG path — post-process to strip SVG 1.1 <font> elements (Chrome/Electron
       dropped support for them; they cause intermittent label corruption). *)
    If[UseSvgQ[],
        svgStr = Quiet[ExportString[expr, "SVG", ImageSize -> Automatic]];
        If[StringQ[svgStr] && StringLength[svgStr] > 10,
            svgStr = vscodeStripSVGFonts[svgStr];
            Return[<|"type" -> "svg", "data" -> svgStr|>]]];
    (* MathML path *)
    boxes = Quiet[MakeBoxes[expr, StandardForm]];
    mathmlStr = Quiet[ExportString[boxes, "MathML"]];
    If[StringQ[mathmlStr] && StringLength[mathmlStr] > 5,
        Return[<|"type" -> "mathml", "data" -> cleanMathML[mathmlStr]|>]];
    (* Fallback *)
    Return[<|"type" -> "input-form", "data" -> ToString[expr, InputForm]|>]
];

(* ===== Internal render dispatcher ===== *)
(* Check recursively whether expr contains any renderable graphic,
   regardless of nesting (e.g. Labeled[Plot[...]], Style[Graphics[...]] etc.) *)
graphicsQ[expr_] := !FreeQ[expr,
    _Graphics | _Graphics3D | _Graph | _GeoGraphics | _Legended | _Image | _Image3D];

VsCodeRenderExpr[expr_, format_String, scale_?NumericQ] := Module[
    {fmt, svgStr, svgStart, pngData, pngStr, mathmlStr, html, mathStart},
    fmt = If[format === "Auto",
             If[UseSvgQ[] && graphicsQ[expr], "SVG", "MathML"],
             format];

    (* ---- SVG path: only for expressions containing Graphics ---- *)
    If[fmt === "SVG",
        If[graphicsQ[expr],
            svgStr = Quiet[Check[TimeConstrained[ExportString[expr, "SVG"], 15, $Failed], $Failed]];
            (* ExportString prepends <?xml...> and <!DOCTYPE...> before <svg.
               Strip everything before the first <svg so the browser gets clean SVG.
               Also strip newlines: WSTP transmits them as literal \012 escape sequences
               which appear verbatim in the output. SVG doesn't need newlines.
               Then strip embedded Wolfram font defs (Chrome/Electron dropped SVG 1.1 fonts). *)
            If[StringQ[svgStr],
                svgStart = First[Flatten[StringPosition[svgStr, "<svg"]], 0];
                If[svgStart > 1, svgStr = StringDrop[svgStr, svgStart - 1]];
                svgStr = StringDelete[svgStr, "\n" | "\r"];
                svgStr = vscodeStripSVGFonts[svgStr]
            ];
            If[StringQ[svgStr] && StringContainsQ[svgStr, "<svg"],
                If[$wolframImgDir =!= "" && StringLength[$wolframImgDir] > 0,
                    (* File-based: save SVG, embed via relative src path *)
                    Module[{fname, fpath},
                        fname = "wl_" <> StringReplace[CreateUUID[], "-" -> ""] <> ".svg";
                        fpath = FileNameJoin[{$wolframImgDir, fname}];
                        Quiet[Export[fpath, svgStr, "String"]];
                        Return["<img class=\"vscode-wolfram-svg-output\" data-wl-img=\"" <>
                               fpath <> "\" src=\"" <>
                               $wolframImgRelPrefix <> "/" <> fname <> "\"/>"]],
                    (* Fallback: inline SVG with font stripping *)
                    Return["<div class=\"vscode-wolfram-svg-output\">" <> svgStr <> "</div>"]
                ]
            ];
            (* SVG failed — PNG fallback *)
            If[$wolframImgDir =!= "" && StringLength[$wolframImgDir] > 0,
                (* File-based PNG via relative src path *)
                Module[{fname, fpath},
                    fname = "wl_" <> StringReplace[CreateUUID[], "-" -> ""] <> ".png";
                    fpath = FileNameJoin[{$wolframImgDir, fname}];
                    Quiet[Export[fpath, expr, "PNG"]];
                    If[FileExistsQ[fpath],
                        Return["<img class=\"vscode-wolfram-png-output\" data-wl-img=\"" <>
                               fpath <> "\" src=\"" <>
                               $wolframImgRelPrefix <> "/" <> fname <> "\"/>"]]]
            ];
            (* Inline PNG base64 fallback (no $wolframImgDir) *)
            pngData = Quiet[Check[TimeConstrained[ExportString[expr, "PNG"], 15, $Failed], $Failed]];
            If[StringQ[pngData],
                pngStr = StringReplace[Quiet[ExportString[pngData, "Base64"]], WhitespaceCharacter -> ""];
                If[StringQ[pngStr] && StringLength[pngStr] > 20,
                    Return["<img class=\"vscode-wolfram-png-output\" src=\"data:image/png;base64," <>
                           pngStr <> "\"/>"]]]
        ];
        (* Not graphics or both exports failed — fall through to MathML *)
        fmt = "MathML"
    ];

    (* ---- MathML path: for all algebraic / symbolic expressions ---- *)
    If[fmt === "MathML",
        mathmlStr = Quiet[Check[TimeConstrained[ExportString[expr, "MathML"], 15, $Failed], $Failed]];
        (* Strip any <?xml...>/<!DOCTYPE...> preamble before <math
           (same logic as SVG stripping before <svg). *)
        If[StringQ[mathmlStr],
            mathStart = First[Flatten[StringPosition[mathmlStr, "<math"]], 0];
            If[mathStart > 1, mathmlStr = StringDrop[mathmlStr, mathStart - 1]]];
        (* Size guard: MathML >60 KB causes browser layout freeze; fall to Text. *)
        If[StringQ[mathmlStr] && 5 < StringLength[mathmlStr] <= 60000,
            Return[
                "<div class=\"mathml-output\" style=\"overflow-x:auto;\">" <>
                cleanMathML[mathmlStr] <> "</div>"
            ]];
        fmt = "Text"
    ];

    (* ---- HTML path (explicit) ---- *)
    If[fmt === "HTML",
        html = Quiet[renderHTML[Quiet[MakeBoxes[expr, StandardForm]]]];
        If[StringQ[html], Return[html]];
        fmt = "Text"
    ];

    (* ---- Text / InputForm fallback ---- *)
    "<pre class=\"vscode-wolfram-text-output\">" <>
    StringReplace[ToString[expr, InputForm], {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}] <>
    "</pre>"
];

(* ===== VsCodeRender: called by JS via session.sub() ===== *)
(* Primary overload: render Out[n] with automatic Short[] skeleton for large expressions.
   This mirrors standard Mathematica behaviour: Out[n] is always preserved complete in
   the kernel; only the *display* expression is shortened.  The Expand Inline button
   calls VsCodeRenderFull[] which bypasses the size check. *)
VsCodeRender[outN_Integer, format_String, scale_?NumericQ] := Module[
    {expr, displayExpr, lc, bc, limitBytes, shortLines, html, isSkeleton},
    expr = Quiet[Out[outN]];
    If[Head[expr] === Out || expr === $Failed,
        Return["<pre class=\"vscode-wolfram-text-output\">No output at Out[" <>
               ToString[outN] <> "]</pre>"]];
    If[expr === Null, Return[""]];

    isSkeleton = False;
    (* --- Size check: only for non-graphics expressions.
       LeafCount is the primary guard: it directly predicts MathML complexity.
       Range[500] has LeafCount=501 but ByteCount~4KB — ByteCount alone misses it.
       Graphics/SVG outputs are always passed through fully (no skeleton). *)
    If[!graphicsQ[expr],
        limitBytes = $getKernelConfig["outputSizeLimit", 200] * 1024;
        bc  = ByteCount[expr];
        lc  = LeafCount[expr];
        If[bc > limitBytes || lc > 200,
            shortLines  = Max[3, Min[20, Round[lc / 50] + 3]];
            displayExpr = Short[expr, shortLines];
            isSkeleton  = True,
        (* else *)
            displayExpr = expr],
    (* graphicsQ: always render full, no skeleton *)
        displayExpr = expr
    ];

    html = Quiet[VsCodeRenderExpr[displayExpr, format, scale]];
    If[!StringQ[html] || html === "",
        html = "<pre class=\"vscode-wolfram-text-output\">" <>
               StringReplace[ToString[displayExpr, InputForm],
                   {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}] <>
               "</pre>"];

    (* Skeleton outputs: wrap with data attributes only — no visible text.
       The JS layer reads data-wolfram-atom-count and builds the banner + buttons. *)
    If[isSkeleton,
        "<div data-wolfram-is-skeleton=\"1\" data-wolfram-atom-count=\"" <>
        ToString[LeafCount[expr]] <> "\">" <> html <> "</div>",
    (* else *)
        html
    ]
];

(* VsCodeRenderFull: same as VsCodeRender but NO size check — called by
   the Expand Inline button so the user always gets the complete output. *)
VsCodeRenderFull[outN_Integer, format_String, scale_?NumericQ] := Module[
    {expr, html},
    expr = Quiet[Out[outN]];
    If[Head[expr] === Out || expr === $Failed,
        Return["<pre class=\"vscode-wolfram-text-output\">No output at Out[" <>
               ToString[outN] <> "]</pre>"]];
    If[expr === Null, Return[""]];
    html = Quiet[VsCodeRenderExpr[expr, format, scale]];
    If[!StringQ[html] || html === "",
        html = "<pre class=\"vscode-wolfram-text-output\">" <>
               StringReplace[ToString[expr, InputForm],
                   {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}] <>
               "</pre>"];
    html
];

VsCodeRenderFull[outN_Integer, format_String] := VsCodeRenderFull[outN, format, 0.8];
VsCodeRenderFull[outN_Integer]               := VsCodeRenderFull[outN, "Auto", 0.8];

(* Overload: direct expression (for non-standard results) *)
VsCodeRender[expr_, format_String, scale_?NumericQ] :=
    VsCodeRenderExpr[expr, format, scale];

(* Convenience overloads with defaults *)
VsCodeRender[outN_Integer]                   := VsCodeRender[outN, "Auto", 0.8];
VsCodeRender[outN_Integer, format_String]    := VsCodeRender[outN, format, 0.8];

(* ===== VsCodeOpenAsText: write Out[n] to a temp file, return path ===== *)
VsCodeOpenAsText[outN_Integer, pageWidth_Integer: 100] := Module[{expr, str, file, s},
    expr = Quiet[Out[outN]];
    If[Head[expr] === Out || expr === $Failed, Return[$Failed]];
    str  = ToString[expr, InputForm, PageWidth -> pageWidth];
    file = FileNameJoin[{$wolframOutputTempDir,
        "wolfram_Out" <> ToString[outN] <> "_" <>
        DateString[{"Year","Month","Day","_","Hour24","Minute","Second"}] <> ".wls"}];
    s = OpenWrite[file];
    WriteString[s, str];
    Close[s];
    file
];

(* ===== VsCodeSyntaxCheck: return JSON string with error list ===== *)
(* Return format: {"errors":[{"line":1,"column":1,"message":"...","character":5},...]} *)
VsCodeSyntaxCheck[text_String] := Module[
    {result, errors, jsonErrors},

    If[$hasCodeParser,
        Quiet[
            Needs["CodeParser`"];
            result = CodeParser`CodeParse[text, "SourceConvention" -> "LineColumn"];
            errors = Cases[result,
                (CodeParser`ErrorNode | CodeParser`AbstractSyntaxErrorNode |
                 CodeParser`UnterminatedGroupNode | CodeParser`UnterminatedCallNode)[___],
                Infinity];
            If[Length[errors] === 0,
                Return["{\"errors\":[]}"]];
            jsonErrors = StringRiffle[
                Map[
                    Function[e, Module[{src, msg},
                        src = Quiet[e[[3]][CodeParser`Source]];
                        msg = StringReplace[ToString[e[[2]]], "\"" -> "\\\""];
                        "{" <>
                        "\"message\":\"" <> msg <> "\"" <>
                        If[ListQ[src] && Length[src] >= 2 && ListQ[src[[1]]] && Length[src[[1]]] >= 2,
                            ",\"line\":"   <> ToString[src[[1, 1]]] <>
                            ",\"column\":" <> ToString[src[[1, 2]]],
                            ",\"line\":1,\"column\":1"
                        ] <>
                        "}"
                    ]],
                    errors],
                ","];
            Return["{\"errors\":[" <> jsonErrors <> "]}"]
        ],
        (* No CodeParser - use SyntaxLength *)
        Quiet[
            Module[{sl},
                sl = SyntaxLength[text];
                If[sl >= StringLength[text],
                    Return["{\"errors\":[]}"]];
                Return["{\"errors\":[{\"message\":\"Syntax error at character " <>
                    ToString[sl] <>
                    "\",\"character\":" <> ToString[sl] <> "}]}"]
            ]
        ]
    ]
];

(* ===== VsCodeSplitCode: split WL source into top-level sub-expression strings =====
   Uses SyntaxLength[] to find where each top-level expression ends, then takes
   the RAW SOURCE TEXT for that span.  This is essential for two reasons:
     1. SyntaxLength never evaluates the input, so % / %% / %%% shortcuts
        are preserved as-is and resolve to the correct Out[N] at evaluation time.
     2. ToExpression[..., HoldComplete] would evaluate % to Out[$Line-1] at
        *parse* time — before any sub-expression has been evaluated — giving
        wrong line numbers.
   Falls back to {code} on any parsing failure. *)
VsCodeSplitCode[code_String] := Module[{remaining, parts, len, part},
    remaining = code;
    parts     = {};
    While[StringLength[StringTrimLeft[remaining]] > 0,
        remaining = StringTrimLeft[remaining];  (* strip leading whitespace/newlines *)
        If[StringLength[remaining] == 0, Break[]];
        len = SyntaxLength[remaining];
        (* SyntaxLength returns the number of characters consumed by the first
           complete syntactic expression.  A negative/zero value means the entire
           remaining text is one (possibly incomplete) expression. *)
        If[!IntegerQ[len] || len <= 0 || len > StringLength[remaining],
            AppendTo[parts, remaining]; Break[]];
        part      = StringTake[remaining, len];
        remaining = StringDrop[remaining, len];
        AppendTo[parts, part]
    ];
    If[Length[parts] == 0, {code}, parts]
];

(* ===== VsCodeEvalWrapper: kept for backwards compatibility =====
   Parses the input into individual top-level expressions (so a cell with two
   separate lines gives two outputs), evaluates each sequentially, stores all
   results in $vsCodeLastResultList.

   Returns Null so that the interactive-mode kernel main loop does NOT
   overwrite Out[$Line] with the wrapper's return value.  Instead the wrapper
   explicitly sets Out[$Line] = $vsCodeLastResult before returning, which
   persists because the kernel silently suppresses Null results.

   Status strings are stored in $vsCodeLastStatuses and read back by JS via
   sub("$vsCodeLastStatuses") after evaluate() returns.

   Never transfers raw big expressions over WSTP — avoids WSGetFunction failures.
   Rendering is done by VsCodeRenderNth[n, format, scale] called separately. *)

$vsCodeLastResult     = Null;  (* last result of the most-recent evaluation *)
$vsCodeLastResultList = {};    (* all results (one per top-level expression) *)
$vsCodeLastStatuses   = {};    (* status strings, read by JS via sub() *)

VsCodeEvalWrapper[code_String] := Module[
    {held, n, results, r, statuses},
    $vsCodeLastResultList = {};

    (* Parse into individually held top-level expressions *)
    held = Quiet[ToExpression[code, InputForm, HoldComplete]];
    n    = If[Head[held] === HoldComplete, Length[held], 0];

    results = {};

    If[n == 0,
        (* Parsing failed — fall back to direct evaluation *)
        r = Quiet[Check[ToExpression[code], $Failed]];
        AppendTo[results, r],

        (* Evaluate each top-level expression; stop on $Aborted *)
        Do[
            r = Quiet[Check[
                    ReleaseHold[Extract[held, {k}, HoldComplete]],
                    $Failed]];
            AppendTo[results, r];
            If[r === $Aborted, Break[]],
            {k, n}
        ]
    ];

    $vsCodeLastResultList = results;
    $vsCodeLastResult     = Last[results];

    statuses = Map[
        Function[rv, Which[
            rv === $Aborted, "aborted",
            rv === $Failed,  "error",
            rv === Null,     "null",
            True,            "ok"]],
        results
    ];

    (* Store statuses for JS to retrieve via sub("$vsCodeLastStatuses"). *)
    $vsCodeLastStatuses = statuses;

    (* Return the last result so the kernel's interactive main loop sets
       Out[$Line] and % naturally.  The kernel suppresses Out for Null results.
       C++ reads RETURNEXPRPKT safely (skips complex types to avoid crash);
       JS always renders via VsCodeRenderNth from $vsCodeLastResultList. *)
    $vsCodeLastResult
];

(* Render the n-th result from the most-recent evaluation (1-based) *)
VsCodeRenderNth[n_Integer, format_String, scale_?NumericQ] :=
    If[1 <= n <= Length[$vsCodeLastResultList],
        VsCodeRenderExpr[$vsCodeLastResultList[[n]], format, scale],
        ""
    ];

VsCodeRenderNth[n_Integer] := VsCodeRenderNth[n, "Auto", 0.8];

(* Convenience: render the last (or only) result *)
VsCodeRenderLast[format_String, scale_?NumericQ] :=
    VsCodeRenderNth[Length[$vsCodeLastResultList], format, scale];

VsCodeRenderLast[] := VsCodeRenderLast["Auto", 0.8];

(* ===== Load rendering primitives ===== *)
Block[{$InputFileName = $InputFileName},
    Quiet[Get[FileNameJoin[{DirectoryName[$InputFileName], "render-html.wl"}]]]
];

(* ===== Print / $PageWidth ===== *)
(* The WSTP $Output stream is a pseudo-stream; setting PageWidth on it via
   SetOptions has no effect on how Print[] wraps its output.  The only
   reliable fix is to override Print[] so each argument is formatted with
   ToString[..., OutputForm, PageWidth -> $PageWidth] explicitly.
   156 = 2× the standard Mathematica default of 78, matching the
   wolfram.notebook.print.pageWidth package.json default.
   controller.js also updates $PageWidth after launch so the user-configured
   value takes effect without a kernel restart. *)
$PageWidth = 156;
Unprotect[Print];
Print[args___] /; !TrueQ[$inPrintPatch] :=
    Block[{$inPrintPatch = True},
        WriteString[$Output,
            StringJoin[ToString[#, OutputForm, PageWidth -> $PageWidth] & /@ {args}] <> "\n"
        ]
    ];
Protect[Print];

(* ===== Interrupt → Dialog handler ===== *)
(* Required for the ⌥⇧↵ "evaluate in dialog" and variable-monitor features.     *)
(* When JS calls session.interrupt() (WSInterruptMessage), this handler opens    *)
(* Dialog[], which causes the kernel to emit BEGINDLGPKT and wait for input.     *)
(* The C++ drain loop detects BEGINDLGPKT and sets isDialogOpen = true, making   *)
(* session.dialogEval() / session.exitDialog() operational.                      *)
(* Suppress "Entering/Exiting Dialog" system messages globally — Quiet[] is not  *)
(* sufficient because the kernel prints these before the Quiet context applies.  *)
Off[Interrupt::dgbgn]; Off[Interrupt::dgend];
Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]];

logWrite["init.wl loaded (WSTP mode, no ZMQ)"];
