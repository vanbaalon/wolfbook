(* Wolfram Kernel Initialization Script - WSTP mode *)
(* No ZeroMQ - installs rendering helpers called by JS via session.sub() *)

(* Ensure consistent UTF-8 encoding, important on non-Western systems *)
$CharacterEncoding = "UTF-8";

(* ===== Context isolation ===== *)
(* Touching user-facing symbols here (while $Context = "Global`") creates them in
   Global` before Begin switches $Context to Wolfbook`Private`.
   Every symbol NOT listed here is created in Wolfbook`Private`, so internal helpers,
   state variables, and Module pattern-variables never appear in Global`.
   This makes ClearAll["Global`*"] safe: it cannot reach Wolfbook`Private` symbols,
   so $wolframImgDir, $config, graphicsQ, etc. all survive intact. *)
WBPrint; WBVersion; WBInclude; WBExport; WBPrompt;
VsCodeRender; VsCodeRenderFull; VsCodeRenderShallow;
VsCodeRenderNth; VsCodeRenderLast; VsCodeEvalWrapper;
VsCodeSyntaxCheck; VsCodeSplitCode; VsCodeOpenAsText; VsCodeDynExportValue;
VsCodeSetImgDir; VsCodeCleanupImgDir; VsCodeSymbolMarkdown;
$setKernelConfig;   (* called from lifecycle.js + controller.js after init.wl loads *)
ClearGlobals;
Begin["Wolfbook`Private`"];

(* ===== Logging ===== *)
$logDir = FileNameJoin[{$UserBaseDirectory, "ApplicationData", "wolfbook"}];
If[!DirectoryQ[$logDir], Quiet[CreateDirectory[$logDir, CreateIntermediateDirectories -> True]]];
$logPath = FileNameJoin[{$logDir, "kernel.log"}];

$wbLog[msg_String] := Quiet[Module[{s},
    s = OpenAppend[$logPath];
    WriteString[s, DateString[] <> " " <> msg <> "\n"];
    Close[s]
]];
$wbLogFile[msg_String, file_String] := $wbLog["[" <> file <> "] " <> msg];
$wbLogError[msg_String] := $wbLog["ERROR: " <> msg];

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
    $wbLogError["Wolfram version " <> ToString[$VersionNumber] <> " < 12, some features may not work"]];

(* ===== CodeParser availability ===== *)
(* Actual Needs["CodeParser`"] is deferred to first use (VsCodeSyntaxCheck) or
   loaded in the background by lifecycle.js via subWhenIdle() after kernel ready.
   Setting True here so api.wl's lazy-load branch is enabled. *)
$hasCodeParser = True;

(* ===== Configuration ===== *)
$config = <|
    "outputFormat"       -> "Auto",
    "imageScale"         -> 0.8,
    "useSVG"             -> True,
    "showPrint"          -> True,
    "maxOutputLength"    -> 100000,
    "outputSizeLimit"    -> 1000,  (* KB of ByteCount; expressions larger than this use Short[] for display *)
    "truncatedTooltip"   -> "Output truncated. Click \"Expand Inline\" to render in full.",
    "autoOpenMessages"   -> False
|>;

$setKernelConfig[name_String, value_] := ($config[name] = value; Null);
(* Guard: if $config was cleared by ClearAll["Global`*"], return the default instead of failing *)
$getKernelConfig[name_String]           := If[AssociationQ[$config], Lookup[$config, name, Missing["NotFound", name]], Missing["NotFound", name]];
$getKernelConfig[name_String, default_] := If[AssociationQ[$config], Lookup[$config, name, default], default];


(* ===== Render engine: helpers + VsCodeRenderExpr ===== *)
(* $wolframResourceDir is injected by lifecycle.js via Block before Get[init.wl] *)
Check[Get[FileNameJoin[{$wolframResourceDir, "render-expr.wl"}]],
      $wbLogError["Failed to load render-expr.wl from: " <> ToString[$wolframResourceDir]]];

(* ===== VS Code API functions: VsCodeRender, VsCodeSyntaxCheck, etc. ===== *)
Check[Get[FileNameJoin[{$wolframResourceDir, "api.wl"}]],
      $wbLogError["Failed to load api.wl from: " <> ToString[$wolframResourceDir]]];

(* ===== Load rendering primitives ===== *)
Check[Get[FileNameJoin[{$wolframResourceDir, "render-html.wl"}]],
      $wbLogError["Failed to load render-html.wl from: " <> ToString[$wolframResourceDir]]];

(* ===== Print / $PageWidth ===== *)
(* The WSTP $Output stream is a pseudo-stream; setting PageWidth on it via
   SetOptions has no effect on how Print[] wraps its output.  The only
   reliable fix is to override Print[] so each argument is formatted with
   ToString[..., OutputForm, PageWidth -> $PageWidth] explicitly.
   156 = 2× the standard Mathematica default of 78, matching the
   wolfram.notebook.print.pageWidth package.json default.
   controller.js also updates $PageWidth after launch so the user-configured
   value takes effect without a kernel restart. *)
$PageWidth = 78;
(* Prevent EnterTextPacket (Dialog/busy-path subAuto) from inserting
   OutputForm line-continuation escapes (\\\012 \012>) into long strings.
   The WSTP output stream defaults to PageWidth→78; setting it to Infinity
   ensures busy-path results are byte-identical to idle-path ones. *)
SetOptions[$Output, PageWidth -> Infinity];

(* ===== Shared arg encoder for Print / WBPrint ===== *)
(* Each arg is encoded to one of four prefixed forms:
     BoxData[…]  — expression typeset via MakeBoxes → BTL/KaTeX
     *STR*<txt>  — plain string literal
     *SVG*<b64>  — inline SVG base64 (graphics)
     <text>      — plain OutputForm fallback
   Multiple args in a single Print call are joined by ASCII File Separator (U+001C, \034)
   so the JS side can split them and render each piece individually. *)
$encodePrintArg[arg_] := Which[
    (* BoxData[_] from CellPrint-fallback / OGRe-style packages:
       serialize inner boxes as InputForm so all leaf atoms are
       quoted strings — required by the C++ boxToLatex parser. *)
    MatchQ[arg, _BoxData],
        "BoxData[" <> ToString[First[arg], InputForm] <> "]",
    (* Strings: pass through as plain text *)
    StringQ[arg],
        "*STR*" <> arg,
    (* Graphics: export as inline SVG (base64) so the JS side can
       embed it directly as a data URI — no file I/O needed.
       Skip Graphics3D/Image3D: ExportString["SVG"] for 3D can
       block waiting for the front-end renderer. *)
    TrueQ[UseSvgQ[]] && graphicsQ[arg] && FreeQ[arg, _Graphics3D | _Image3D],
        Module[{svg, svgClean, b64},
            svg = Quiet[CheckAbort[
                Check[TimeConstrained[ExportString[arg, "SVG", Background -> None], 10, $Failed], $Failed],
                $Failed]];
            If[StringQ[svg],
                svgClean = StringDelete[svg, "\n" | "\r"];
                svgClean = vscodeStripSVGFonts[svgClean];
                b64 = Quiet[BaseEncode[StringToByteArray[svgClean, "UTF-8"]]];
                "*SVG*" <> b64,
                (* SVG export failed — fall back to OutputForm *)
                ToString[arg, OutputForm, PageWidth -> $PageWidth]
            ]
        ],
    (* InformationData (result of ?Symbol / Information[sym] via Print side-channel)
       — the kernel emits InterpretationBox[<widget>, InformationData[assoc, True]].
       The widget boxes contain DynamicModuleBox / PaneSelectorBox / ButtonBox that
       BTL cannot render. Extract the association and build clean HTML directly.
       NOTE: InformationData lives in the Information` package context — do NOT use
       _InformationData pattern (resolves to Global`InformationData at load time).
       Use a string-based head check instead. *)
    Head[arg] === InterpretationBox && Length[arg] >= 2 &&
        StringContainsQ[ToString[Head[arg[[2]]], InputForm], "InformationData"],
        Module[{infoData, assoc, fullName, shortName, usageStr, attribs, dvHtml, html,
                esc},
            esc[s_String] := StringReplace[s,
                {"&" -> "&amp;", "<" -> "&lt;", ">" -> "&gt;", "\"" -> "&quot;"}];
            infoData  = arg[[2]];  (* InformationData[assoc, True] *)
            assoc     = If[Length[infoData] >= 1 && AssociationQ[infoData[[1]]],
                           infoData[[1]], <||>];
            fullName  = Lookup[assoc, "FullName", "?"];
            shortName = Last[StringSplit[fullName, "`"]];
            usageStr  = Lookup[assoc, "Usage", None];
            attribs   = Lookup[assoc, "Attributes", {}];
            dvHtml = Module[{sym, dvs},
                sym = Quiet[Check[ToExpression[fullName, InputForm], $Failed]];
                dvs = If[sym =!= $Failed && Head[sym] === Symbol,
                         Quiet[DownValues[sym]], {}];
                If[!ListQ[dvs] || Length[dvs] === 0, "",
                    "<div style=\"margin-top:6px;\">" <>
                    "<span style=\"font-size:11px;font-weight:bold;" <>
                    "color:var(--vscode-descriptionForeground,#888);\">Definitions</span>" <>
                    "<pre style=\"font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;" <>
                    "background:var(--vscode-textCodeBlock-background,rgba(128,128,128,0.1));" <>
                    "padding:6px 8px;border-radius:3px;margin:4px 0 0;\">" <>
                    esc[ToString[dvs, InputForm]] <>
                    "</pre></div>"
                ]
            ];
            html =
                "<div style=\"padding:4px 0;\">" <>
                "<div style=\"font-size:14px;font-weight:bold;margin-bottom:3px;\">" <>
                esc[shortName] <> "</div>" <>
                "<div style=\"font-size:11px;color:var(--vscode-descriptionForeground,#888);" <>
                "margin-bottom:6px;\">" <> esc[fullName] <> "</div>" <>
                If[StringQ[usageStr] && usageStr =!= "",
                    "<div style=\"font-size:12px;line-height:1.6;white-space:pre-wrap;" <>
                    "margin-bottom:4px;\">" <> esc[usageStr] <> "</div>",
                    ""] <>
                dvHtml <>
                If[ListQ[attribs] && Length[attribs] > 0,
                    "<div style=\"font-size:11px;color:var(--vscode-descriptionForeground,#888);" <>
                    "margin-top:4px;\">Attributes: " <>
                    esc[ToString[attribs, OutputForm]] <> "</div>",
                    ""] <>
                "</div>";
            "*HTML*" <> html
        ],
    (* Everything else: typeset via MakeBoxes → BTL/KaTeX pipeline *)
    True,
        Module[{boxes, boxStr},
            boxes = Quiet[CheckAbort[
                Check[MakeBoxes[arg, TraditionalForm], $Failed],
                $Failed]];
            If[boxes === $Failed,
                ToString[arg, OutputForm, PageWidth -> $PageWidth],
                boxes = expandAllTemplateBoxes[boxes];
                boxStr = ToString[boxes, InputForm];
                "BoxData[" <> boxStr <> "]"
            ]
        ]
];

Unprotect[Print];
Print[args___] /; !TrueQ[$inPrintPatch] :=
    Block[{$inPrintPatch = True},
        (* Args joined by ASCII File Separator (\034 / \x1c) so JS can split
           and render each piece (string / expression / graphics) individually. *)
        WriteString[$Output,
            StringRiffle[$encodePrintArg /@ {args}, "\034"] <> "\n"
        ]
    ];
Protect[Print];

(* ===== WBPrint — in-place updating print for loops / progress display ===== *)
(* Like Print but:
   - Carries an *WBP* prefix so the JS renderer can identify and update it in-place.
   - When called repeatedly (e.g. inside Do[]), each call REPLACES the previous
     WBPrint output for this cell — no accumulation, just an updating "status line".
   - The output disappears automatically when the next cell is evaluated. *)
WBPrint::usage = "WBPrint[args___] displays args as a single in-place output block that \
replaces itself on each call within the same cell evaluation. Unlike Print[], which \
accumulates one line per call, WBPrint[] shows only the most recent call\[CloseCurlyQuote]s \
output \[LongDash] making it ideal for loop progress display and live status updates. \
The output disappears automatically when any new cell starts evaluating. \
Accepts the same argument types as Print[]: strings, numbers, expressions, and Graphics objects.\n\n\
Examples:\n  Do[Pause[0.2]; WBPrint[\"Step: \", i, \" / 20\"], {i, 20}]\n  \
WBPrint[\"Computing\[Ellipsis] norm = \", Norm[v]]";
WBPrint[args___] :=
    Block[{$inPrintPatch = True},
        WriteString[$Output,
            "*WBP*" <> StringRiffle[$encodePrintArg /@ {args}, "\034"] <> "\n"
        ]
    ];

(* ===== Usage messages for JS-intercepted WB functions ===== *)
(* WBInclude, WBExport, and WBPrompt are intercepted by the Wolfbook extension   *)
(* before the kernel ever sees them.  These ::usage strings exist purely so that  *)
(* ?WBInclude (and friends) display helpful documentation in the kernel REPL.    *)
WBInclude::usage = "WBInclude[\"path\"] imports the contents of an external .wl, .m, \
.wls, .nb, .evsnb, or .wb file as new notebook cells inserted immediately after the \
WBInclude cell. The path must be a static string literal \[LongDash] runtime expressions \
are not supported. This call is intercepted by the Wolfbook extension and never \
reaches the kernel.";

WBExport::usage = "WBExport[] or WBExport[\"path\"] exports the current Wolfbook \
notebook as a Mathematica .nb file. Without an argument the .nb file is saved \
alongside the current .wb notebook. The path argument, if given, must be a static \
string literal. This call is intercepted by the Wolfbook extension and never \
reaches the kernel.";

WBPrompt::usage = "WBPrompt[\"text\"] or WBPrompt[\"text\", \"wolfbook\"->True|False] \
opens the Copilot Agent Chat panel with the given prompt pre-filled and submitted. \
With \"wolfbook\"->True (default) the prompt is routed to the @wolfbook agent, which \
has live kernel access and can insert cells. With \"wolfbook\"->False the prompt \
goes to plain Copilot chat. The argument must be a static string literal. This call \
is intercepted by the Wolfbook extension and never reaches the kernel.";

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

(* SVG/typesetting pipeline and CodeParser are prewarmed in the background by
   lifecycle.js via subWhenIdle() after the kernel is declared ready.          *)

$wbLog["init.wl loaded (WSTP mode, no ZMQ)"];

(* ===== AI/Copilot helper — symbol documentation for wolfbook_lookupSymbol tool ===== *)
(* longForm: if True (default), appends a link to the online Wolfram documentation for System symbols *)
VsCodeSymbolMarkdown[symName_String, longForm_: True] :=
    ToExpression[symName, InputForm,
        Function[sym,
            Module[{ctx, rawUsage, usage, ov, dv, attrs, opts, docURL, parts},
                (* Context[sym] is HoldFirst — returns context of the symbol, ignoring its value *)
                ctx = Quiet[Context[sym]];
                If[!StringQ[ctx], ctx = "Global`"];
                (* MessageName is HoldFirst — reads symbol's usage, not its value *)
                rawUsage = Quiet[MessageName[sym, "usage"]];
                (* Documentation URL for System-context symbols *)
                docURL = If[ctx === "System`",
                    "https://reference.wolfram.com/language/ref/" <> symName <> ".html",
                    None];
                parts = {"## `" <> symName <> "`\n\n"};
                If[ctx =!= "Global`",
                    AppendTo[parts, "**Context:** `" <> ctx <> "`\n\n"]];
                If[StringQ[rawUsage],
                    (* Convert \!\(\*boxes\) to LaTeX via TeXForm/DisplayForm.
                       MessageName returns boxes using Unicode private-use area (PUA) characters:
                         U+F7C1 = \!   U+F7C9 = \(   U+F7C8 = \*   U+F7C0 = \)
                       so the pattern must use the PUA chars, not ASCII backslash sequences. *)
                    usage = StringReplace[rawUsage,
                        Shortest["\:F7C1\:F7C9\:F7C8" ~~ x__ ~~ "\:F7C0"] :>
                            Quiet[Check[
                                "$" <> ToString[TeXForm[DisplayForm[
                                    ToExpression[x, InputForm]
                                ]]] <> "$",
                                ""]]];
                    AppendTo[parts, "### Usage\n" <> usage <> "\n\n"],
                    (* No ::usage — show values / DownValues instead *)
                    ov = Quiet[OwnValues[sym]];   (* HoldAll — sees symbol, not value *)
                    dv = Quiet[DownValues[sym]];  (* HoldAll — sees symbol, not value *)
                    If[ov =!= {},
                        AppendTo[parts,
                            "**Value:** `" <> symName <> " = " <>
                                ToString[ov[[1, 2]], InputForm] <> "`\n\n"]];
                    If[dv =!= {},
                        AppendTo[parts, "### Definitions\n```wolfram\n" <>
                            StringJoin[ToString[#, InputForm] <> "\n" & /@ dv] <> "```\n\n"]];
                    If[ov === {} && dv === {},
                        AppendTo[parts, "(Undefined — no definitions or values.)\n\n"]]
                ];
                attrs = Quiet[Attributes[sym]];  (* HoldAll *)
                If[attrs =!= {},
                    AppendTo[parts, "**Attributes:** " <>
                        StringJoin[Riffle[ToString /@ attrs, ", "]] <> "\n\n"]];
                opts = Quiet[Options[Unevaluated[sym]]];  (* Unevaluated prevents b->3 etc. *)
                If[ListQ[opts] && opts =!= {},
                    AppendTo[parts,
                        "### Options\n| Option | Default |\n|--------|----------|\n" <>
                        StringJoin["| `" <> ToString[#[[1]]] <> "` | `" <>
                            ToString[#[[2]], InputForm] <> "` |\n" & /@ opts]]];
                If[TrueQ[longForm] && StringQ[docURL],
                    AppendTo[parts, "\n---\n[Full documentation](" <> docURL <> ")"]];
                StringJoin[parts]
            ],
        HoldFirst]
    ];


(* ===== Oberon utilities ===== *)
(* Clears user-defined Global` symbols; skips Protected/Locked symbols and any
   symbol whose name contains "$" (state variables, WB internals). *)
ClearGlobals[] := ClearAll @@ Select[Names["Global`*"],
    FreeQ[Attributes[#], Protected | Locked] && Not[StringMatchQ[#, "*$*"]] &];

(* ===== Clean up any Global` shadows of System` symbols created during loading ===== *)
(* Loading render-expr.wl / render-html.wl / api.wl in Global` context can         *)
(* cause the kernel to intern certain System` symbols into Global` before the       *)
(* corresponding System` definition is loaded (especially in -wstp mode without     *)
(* the front-end). The most common offender is `Absolute`, which Wolfram uses for   *)
(* notebook styling; if Global`Absolute is present it triggers Absolute::shdw the   *)
(* first time any plotting function touches System`Absolute.                         *)
(* Strategy: remove the Global` shadow after init is complete so the symbol table   *)
(* is clean before the user evaluates anything.  Using Remove (not ClearAll) so the *)
(* symbol is fully deleted, not just unvalued.                                       *)
Quiet[
    If[MemberQ[Names["Global`*"], "Absolute"],
       Remove["Global`Absolute"]
    ];
    (* Use full context to avoid accidentally creating Global`Absolute if System`Absolute
       hasn't been loaded yet — Off with an unqualified name would intern the symbol in
       the current context instead of System`. *)
    Off[System`Absolute::shdw]
];

(* ===== Protect user-facing Global` symbols ===== *)
(* Internal symbols (now in Wolfbook`Private`) are immune to ClearAll["Global`*"]
   and do not need Protect.  We only protect the Global`-context user-facing symbols
   to prevent accidental redefinition from user code. *)
Protect[
    $setKernelConfig,
    VsCodeSetImgDir, VsCodeCleanupImgDir,
    VsCodeSymbolMarkdown,
    WBPrint, WBInclude, WBExport, WBPrompt,
    ClearGlobals
];

End[]; (* Wolfbook`Private` *)
