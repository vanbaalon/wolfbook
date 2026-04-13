(* Wolfbook: VS Code API functions — VsCodeRender, VsCodeSyntaxCheck, etc. *)
(* Extracted from init.wl (Round 9 refactor). *)

(* ===== VsCodeDynExportValue: evaluate Dynamic slot inside Dialog[] ===== *)
(* Takes the WL expression as a STRING, evaluates it inside Module (so abort/    *)
(* timeout are self-contained), exports the result to a temp .mx file, and       *)
(* returns "WLVAL:FILE:<path>" for the JS side.                                  *)
(* NO CheckAbort wrapper: inside Dialog[], an active abort would trap CheckAbort  *)
(* immediately and return $Failed before the expression is evaluated.             *)
(* After exitDialog() the JS side passes the .mx path to the _subKernel for full  *)
(* VsCodeRenderExpr rendering (SVG/MathML) — subkernel needs no context for n.   *)
VsCodeDynExportValue[exprStr_String] := Module[
    {val, tmpFile},
    (* TimeConstrained guards slow expressions. Avoid Check[..,$Failed] here:
       many harmless messages would otherwise collapse valid values to $Failed. *)
    val = TimeConstrained[
        Quiet[ToExpression[exprStr]],
        4, $Failed
    ];
    If[!MatchQ[val, Except[$Failed | $Aborted | HoldComplete[___]]],
        Return["WLVAL:FAILED"]];
    tmpFile = FileNameJoin[{$TemporaryDirectory,
        "wl_dyn_" <> StringReplace[CreateUUID[], "-" -> ""] <> ".mx"}];
    Quiet[Export[tmpFile, val]];
    If[!FileExistsQ[tmpFile], Return["WLVAL:FAILED"]];
    "WLVAL:FILE:" <> tmpFile
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
       Graphics/SVG outputs are always passed through fully (no skeleton).
       NOTE: We use Shallow[], NOT Short[].  Short is a front-end display hint;
       in a headless kernel it wraps the FULL boxes in a TagBox and does nothing.
       Shallow actually truncates at the kernel level, producing \[LeftSkeleton]..\[RightSkeleton]
       skeleton markers that BTL renders as <<N>>. *)
    If[!graphicsQ[expr],
        limitBytes = $getKernelConfig["outputSizeLimit", 1000] * 1024;
        bc  = ByteCount[expr];
        lc  = LeafCount[expr];
        If[bc > limitBytes || lc > 1000,
            (* Breadth = 500 elements at each level initially; +... steps by +500.
               Depth = Infinity so nested structures are visible. *)
            Module[{breadth = 500},
                displayExpr = Shallow[expr, {Infinity, breadth}];
                isSkeleton  = True],
        (* else *)
            displayExpr = expr],
    (* graphicsQ: always render full, no skeleton *)
        displayExpr = expr
    ];

    (* CheckAbort: if rendering aborts (e.g. $RecursionLimit from a recursive
       Format rule like Format[x]=Style[x,Red]), produce visible output:
       an amber warning message + the InputForm text.  Do NOT return a bare
       $Aborted symbol or empty string — that would silently produce no output.
       We embed the warning DIRECTLY in the HTML so the user sees it even
       though the MESSAGEPKT from $RecursionLimit::reclim is suppressed by
       the inner Quiet[] wrappers in VsCodeRenderExpr. *)
    html = CheckAbort[
        Quiet[VsCodeRenderExpr[displayExpr, format, scale]],
        (* Abort caught — build: (1) amber warning box + (2) plain-text fallback *)
        Module[{warnHtml, fbText},
            warnHtml =
                "<div class=\"vscode-wolfram-message-output\" style=\"color:#cc8800;padding:4px 0\">" <>
                "$RecursionLimit::reclim: Recursion depth of " <> ToString[$RecursionLimit] <>
                " exceeded during rendering \[LongDash] likely caused by a recursive Format rule " <>
                "(e.g. <code>Format[x]=Style[x,Red]</code>). " <>
                "Tip: evaluate <code>Unset[Format[x]]</code> then re-run." <>
                "</div>";
            fbText = CheckAbort[
                StringReplace[ToString[displayExpr, InputForm],
                    {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}],
                "[InputForm also aborted]"];
            warnHtml <>
            "<pre class=\"vscode-wolfram-text-output\">" <> fbText <> "</pre>"
        ]
    ];
    If[!StringQ[html] || html === "",
        (* Render returned non-string (most likely $Failed from Check inside
           VsCodeRenderExpr which caught $RecursionLimit::reclim from a
           recursive Format rule, e.g. Format[x]=Style[x,Red,Bold,20]).
           Do a quick cheap probe to detect the recursion case. *)
        Module[{isRecursive, warnPart, fbText},
            isRecursive = Block[{$RecursionLimit = 50},
                Quiet[Check[MakeBoxes[displayExpr, StandardForm], $Failed]] === $Failed
            ];
            warnPart = If[isRecursive,
                "<div class=\"vscode-wolfram-message-output\" style=\"color:#cc8800;padding:4px 0\">" <>
                "Rendering failed \[LongDash] recursive Format rule detected " <>
                "(e.g. <code>Format[x]=Style[x,Red]</code>). " <>
                "Tip: evaluate <code>Unset[Format[x]]</code> then re-run." <>
                "</div>",
                ""
            ];
            fbText = CheckAbort[
                StringReplace[ToString[displayExpr, InputForm],
                    {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}],
                "[InputForm also aborted]"
            ];
            html = warnPart <>
                   "<pre class=\"vscode-wolfram-text-output\">" <> fbText <> "</pre>"
        ]
    ];

    (* Prepend an invisible graphics marker so the JS layer can detect the output
       type from the WL expression itself, not from the rendered HTML format. *)
    Module[{gfxMarker = If[graphicsQ[expr],
        "<span class=\"vscode-wolfram-gfx-marker\" style=\"display:none;\"></span>", ""]},
        If[isSkeleton,
            gfxMarker <>
            "<div data-wolfram-is-skeleton=\"1\" data-wolfram-atom-count=\"" <>
            ToString[LeafCount[expr]] <> "\">" <> html <> "</div>",
        (* else *)
            gfxMarker <> html
        ]
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
    html = CheckAbort[
        Quiet[VsCodeRenderExpr[expr, format, scale]],
        Module[{warnHtml, fbText},
            warnHtml =
                "<div class=\"vscode-wolfram-message-output\" style=\"color:#cc8800;padding:4px 0\">" <>
                "$RecursionLimit::reclim: Recursion depth of " <> ToString[$RecursionLimit] <>
                " exceeded during rendering \[LongDash] likely caused by a recursive Format rule. " <>
                "Tip: evaluate <code>Unset[Format[x]]</code> then re-run." <>
                "</div>";
            fbText = CheckAbort[
                StringReplace[ToString[expr, InputForm],
                    {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}],
                "[InputForm also aborted]"];
            warnHtml <>
            "<pre class=\"vscode-wolfram-text-output\">" <> fbText <> "</pre>"
        ]
    ];
    If[!StringQ[html] || html === "",
        Module[{isRecursive, warnPart, fbText},
            isRecursive = Block[{$RecursionLimit = 50},
                Quiet[Check[MakeBoxes[expr, StandardForm], $Failed]] === $Failed
            ];
            warnPart = If[isRecursive,
                "<div class=\"vscode-wolfram-message-output\" style=\"color:#cc8800;padding:4px 0\">" <>
                "Rendering failed \[LongDash] recursive Format rule detected " <>
                "(e.g. <code>Format[x]=Style[x,Red]</code>). " <>
                "Tip: evaluate <code>Unset[Format[x]]</code> then re-run." <>
                "</div>",
                ""
            ];
            fbText = CheckAbort[
                StringReplace[ToString[expr, InputForm],
                    {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}],
                "[InputForm also aborted]"
            ];
            html = warnPart <>
                   "<pre class=\"vscode-wolfram-text-output\">" <> fbText <> "</pre>"
        ]
    ];
    (* Same gfx marker as VsCodeRender so expand restores the correct button set *)
    If[graphicsQ[expr],
        "<span class=\"vscode-wolfram-gfx-marker\" style=\"display:none;\"></span>" <> html,
        html]
];
VsCodeRenderFull[outN_Integer]               := VsCodeRenderFull[outN, "Auto", 0.8];

(* Overload: direct expression (for non-standard results) *)
VsCodeRender[expr_, format_String, scale_?NumericQ] :=
    VsCodeRenderExpr[expr, format, scale];

(* ---- VsCodeRenderShallow: progressive expansion for the +… button. ----
   Identical pipeline to VsCodeRender but uses Shallow[Out[N], {Infinity, breadth}].
   Returns a plain HTML string exactly like VsCodeRender — no JSON wrapping.
   When the expression is still truncated the returned HTML contains
   data-wolfram-is-skeleton="1" so JS can show the +… banner again. *)
VsCodeRenderShallow[outN_Integer, breadth_Integer, format_String, scale_?NumericQ] := Module[
    {expr, displayExpr, html, hasSkeleton},
    expr = Quiet[Out[outN]];
    If[Head[expr] === Out || expr === $Failed,
        Return["<pre class=\"vscode-wolfram-text-output\">No output at Out[" <> ToString[outN] <> "]</pre>"]];
    If[expr === Null, Return[""]];
    displayExpr = Shallow[expr, {Infinity, breadth}];
    (* hasSkeleton: determine whether Shallow[] actually truncated the expression.
       NOTE: FreeQ[Shallow[expr,spec], _Skeleton] is ALWAYS False in a headless kernel —
       Shallow[] is a formatting wrapper that does NOT evaluate to expose Skeleton[N]
       atoms in the kernel expression (skeleton appears only in the MakeBoxes result).
       Instead we compare LeafCount[expr]-1 (total atoms minus the outer head) to breadth:
       if the expression has more atoms than the current breadth limit it is still being
       truncated by Shallow[].  This is conservative: for a few deeply-nested structures
       the banner may linger one extra expansion step, but it is never falsely omitted. *)
    hasSkeleton = !AtomQ[expr] && (LeafCount[expr] - 1 > breadth);
    html = CheckAbort[
        Quiet[VsCodeRenderExpr[displayExpr, format, scale]],
        "<pre class=\"vscode-wolfram-text-output\">Rendering aborted</pre>"
    ];
    If[!StringQ[html], html = "<pre class=\"vscode-wolfram-text-output\">Rendering failed</pre>"];
    (* Same wrapper as VsCodeRender so JS can detect skeleton and atom count *)
    If[hasSkeleton,
        "<div data-wolfram-is-skeleton=\"1\" data-wolfram-atom-count=\"" <>
        ToString[LeafCount[expr]] <> "\">" <> html <> "</div>",
        html
    ]
];
VsCodeRenderShallow[outN_Integer, breadth_Integer] := VsCodeRenderShallow[outN, breadth, "Auto", 0.8];

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

(* ===== Protect all wolfbook API symbols from ClearAll["Global`*"] ===== *)
Protect[
    VsCodeDynExportValue, VsCodeRender, VsCodeRenderFull, VsCodeRenderShallow,
    VsCodeOpenAsText,
    VsCodeSyntaxCheck, VsCodeSplitCode, VsCodeEvalWrapper, VsCodeRenderNth,
    VsCodeRenderLast,
    $vsCodeLastResult, $vsCodeLastResultList, $vsCodeLastStatuses
];
