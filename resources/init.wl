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
$getKernelConfig[name_String]           := Lookup[$config, name, Missing["NotFound", name]];
$getKernelConfig[name_String, default_] := Lookup[$config, name, default];


(* ===== Render engine: helpers + VsCodeRenderExpr ===== *)
(* $wolframResourceDir is injected by lifecycle.js via Block before Get[init.wl] *)
Check[Get[FileNameJoin[{$wolframResourceDir, "render-expr.wl"}]],
      logError["Failed to load render-expr.wl from: " <> ToString[$wolframResourceDir]]];

(* ===== VS Code API functions: VsCodeRender, VsCodeSyntaxCheck, etc. ===== *)
Check[Get[FileNameJoin[{$wolframResourceDir, "api.wl"}]],
      logError["Failed to load api.wl from: " <> ToString[$wolframResourceDir]]];

(* ===== Load rendering primitives ===== *)
Check[Get[FileNameJoin[{$wolframResourceDir, "render-html.wl"}]],
      logError["Failed to load render-html.wl from: " <> ToString[$wolframResourceDir]]];

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
(* Prevent EnterTextPacket (Dialog/busy-path subAuto) from inserting
   OutputForm line-continuation escapes (\\\012 \012>) into long strings.
   The WSTP output stream defaults to PageWidth→78; setting it to Infinity
   ensures busy-path results are byte-identical to idle-path ones. *)
SetOptions[$Output, PageWidth -> Infinity];
Unprotect[Print];
Print[args___] /; !TrueQ[$inPrintPatch] :=
    Block[{$inPrintPatch = True},
        WriteString[$Output,
            StringJoin[Function[arg,
                (* BoxData[_] from CellPrint-fallback / OGRe-style packages:
                   serialize inner boxes as InputForm so all leaf atoms are
                   quoted strings — required by the C++ boxToLatex parser. *)
                If[MatchQ[arg, _BoxData],
                    "BoxData[" <> ToString[First[arg], InputForm] <> "]",
                    ToString[arg, OutputForm, PageWidth -> $PageWidth]
                ]
            ] /@ {args}] <> "\n"
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

(* SVG/typesetting pipeline and CodeParser are prewarmed in the background by
   lifecycle.js via subWhenIdle() after the kernel is declared ready.          *)

logWrite["init.wl loaded (WSTP mode, no ZMQ)"];

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

