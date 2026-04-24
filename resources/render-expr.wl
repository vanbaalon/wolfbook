(* Wolfbook: rendering helpers and VsCodeRenderExpr dispatcher *)
(* Extracted from init.wl (Round 9 refactor). *)

(* ===== WBVersion[] — returns a formatted version summary ===== *)
WBVersion[] := (
    Print["Wolfbook extension : ", $getKernelConfig["wolfbookVersion",      "unknown"],
          "  (installed: ", $getKernelConfig["wolfbookBuildDate",    "unknown"], ")"];
    Print["BTL (box-to-LaTeX) : ", $getKernelConfig["wolfbookBtlVersion",   "unknown"],
          "  (built: ", $getKernelConfig["wolfbookBtlBuildDate", "unknown"], ")"];
    Print["WSTP addon         : ", $getKernelConfig["wolfbookWstpVersion",  "unknown"],
          "  (built: ", $getKernelConfig["wolfbookWstpBuildDate","unknown"], ")"];
    Print["Mathematica kernel : ", $Version];
);

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

(* ===== Expand TemplateBox to elementary display boxes ===== *)
(* TemplateBox[{args}, "Tag"] is opaque to our C++ boxToLatex translator for most
   tags.  BoxForm`TemplateBoxToDisplayBoxes resolves the display-function on the
   kernel side and returns only primitive boxes (RowBox, SubscriptBox, …) that
   btl already handles. The expansion is applied recursively so nested
   TemplateBoxes inside FractionBox, RowBox etc. are all resolved.
   If the expansion fails for any reason (e.g. BoxForm not yet initialised during
   early kernel startup), the original TemplateBox is left unchanged so the C++
   translateTemplateBox fallback in btl handles it instead. *)
expandAllTemplateBoxes[tb_TemplateBox] :=
    Module[{expanded},
        expanded = Quiet[Check[BoxForm`TemplateBoxToDisplayBoxes[tb], tb]];
        If[expanded === tb, tb, expandAllTemplateBoxes[expanded]]
    ];
expandAllTemplateBoxes[h_[args___]] :=
    h @@ (expandAllTemplateBoxes /@ {args});
expandAllTemplateBoxes[s_String] := s;
expandAllTemplateBoxes[n_?NumericQ] := n;
expandAllTemplateBoxes[other_] := other;

(* ===== Render a single result expression as HTML string ===== *)
mathematicaformatResult[expr_] := Module[{boxes, svgStr, mathmlStr},
    (* SVG path — post-process to strip SVG 1.1 <font> elements (Chrome/Electron
       dropped support for them; they cause intermittent label corruption). *)
    If[UseSvgQ[],
        svgStr = Quiet[CheckAbort[ExportString[expr, "SVG", ImageSize -> Automatic], $Failed]];
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

(* ===== Expand \!\(\*BoxExpr\) inline LinearSyntax in usage strings ===== *)
(* WL ::usage messages embed box expressions as \!\(\*BoxExpr\) in the string   *)
(* value (prefix = 6 chars \!\(\* , suffix = 2 chars \) ).  MakeBoxes on such  *)
(* a plain String returns it as a quoted-string box, which BTL can only wrap in *)
(* \text{} — the inline notation comes through as literal characters.  This     *)
(* function splits the string at those boundaries and reassembles as a RowBox  *)
(* mixing plain text strings and real box expressions, so BTL renders them.    *)
expandInlineBoxes[str_String] :=
  Module[{parts},
    (* Fast path: no inline notation present *)
    If[!StringContainsQ[str, "\!\("], Return[str]];
    (* Split at \!\(\*BoxExpr\) boundaries.
       Delimiters are PUA chars: \! = U+F781, \( = U+F789, \* = U+F788, \) = U+F780.
       Prefix is 3 chars, suffix is 1 char. *)
    parts = StringSplit[str,
      x : ("\!" ~~ "\(" ~~ "\*" ~~ Shortest[___] ~~ "\)") :>
        Quiet[Check[
          ToExpression[StringDrop[StringDrop[x, 3], -1], InputForm],
          x  (* keep as string on any parse failure *)
        ]]
    ];
    (* If all parts are still strings, nothing changed *)
    If[AllTrue[parts, StringQ], Return[str]];
    RowBox[parts]
  ];
expandInlineBoxes[other_] := other;

(* Wrap expandInlineBoxes result so MakeBoxes passes it through unchanged *)
prepareExprForBoxes[expr_] :=
  Module[{e2 = expandInlineBoxes[expr]},
    If[Head[e2] === RowBox, RawBoxes[e2], e2]
  ];

(* ===== Internal render dispatcher ===== *)
(* Check recursively whether expr contains any renderable graphic,
   regardless of nesting (e.g. Labeled[Plot[...]], Style[Graphics[...]] etc.) *)
graphicsQ[expr_] := !FreeQ[expr,
    _Graphics | _Graphics3D | _Graph | _GeoGraphics | _Legended | _Image | _Image3D];

VsCodeRenderExpr[expr_, format_String, scale_?NumericQ, searchPat_String:""] :=
 Block[{$RecursionLimit = 100000, $IterationLimit = 400000},
  Module[
    {fmt, svgStr, svgStart, pngData, pngStr, mathmlStr, html, mathStart,
     rasImg, rasData, rasStr, rasFname, rasFpath, texStr,
     fname, fpath, hashStr},
    fmt = If[format === "Auto",
             If[UseSvgQ[] && graphicsQ[expr], "SVG", "MathML"],
             format];

    (* For graphics expressions: expression-only formats make no visual sense.
       Promote WLLatex/WLLatex2/MathML/TeX/TeXSrc to SVG so a Graphics output is
       always rendered as an image regardless of the current expression-format setting.
       Explicit WL/InputForm/SVGSrc choices are left untouched. *)
    If[graphicsQ[expr] && MemberQ[{"WLLatex", "WLLatex2", "WLLatexSrc", "SVGT", "MathML", "TeX", "TeXSrc"}, fmt],
        fmt = "SVG"];

    (* ---- InformationDataGrid path: ?*pattern* search results ---- *)
    (* InformationDataGrid[{ctx -> {sym,...}, ...}, expanded_] is what the kernel
       returns for ?*pattern* wildcard searches.  MakeBoxes on it requires a front
       end (DynamicModuleBox / FEPrivate) and produces nothing useful when rendered
       headlessly.  Instead we extract the symbol list directly and emit clickable
       HTML badges so the user can click any name to open its full documentation in
       the Watch panel (via the existing wolfbook.expandHoverDoc / docLookup pipeline). *)
    If[Head[expr] === InformationDataGrid,
        Module[{groups, totalCount, ctxHtml, symHtml, badgeStyle, groupStyle,
                groupLabelStyle, wrapStyle, headerStyle, litPat},
            groups = If[Length[expr] >= 1 && ListQ[expr[[1]]], expr[[1]], {}];
            totalCount = Total[Length[Last[#]] & /@ groups];
            (* Extract the literal search string from the glob pattern, e.g. "*Sin*" -> "Sin".
               Using StringCases+Except instead of StringReplace because "*" in WL string rules
               is treated as a wildcard (matches the whole string), not a literal asterisk. *)
            litPat = StringJoin[StringCases[searchPat, Except["*"]..]];
            badgeStyle =
                "display:inline-block;padding:1px 7px;margin:2px 3px;" <>
                "border:1px solid rgba(128,128,128,0.35);border-radius:3px;" <>
                "font-size:12px;cursor:pointer;font-family:monospace;" <>
                "background:transparent;color:var(--vscode-foreground,inherit);" <>
                "transition:background 0.15s;";
            groupStyle = "margin:6px 0 10px;";
            groupLabelStyle =
                "font-size:11px;color:var(--vscode-descriptionForeground,#888);" <>
                "margin-bottom:4px;";
            wrapStyle = "display:flex;flex-wrap:wrap;";
            headerStyle =
                "font-size:12px;color:var(--vscode-descriptionForeground,#999);" <>
                "margin-bottom:8px;";
            ctxHtml = StringJoin[
                Map[
                    Function[rule,
                        Module[{ctx, syms, ctxShort, symBadges},
                            {ctx, syms} = {First[rule], Last[rule]};
                            ctxShort = StringReplace[ctx, "`" -> ""];
                            symBadges = StringJoin[
                                Map[
                                    Function[sym,
                                        Module[{symHtml},
                                            symHtml = If[litPat =!= "",
                                                StringReplace[sym, litPat ->
                                                    "<mark style=\"background:rgba(100,170,255,0.35);color:inherit;border-radius:2px;padding:0 1px;\">" <> litPat <> "</mark>", 1],
                                                sym
                                            ];
                                            "<button class=\"wl-info-grid-symbol\" " <>
                                            "data-action=\"doc-lookup\" " <>
                                            "data-symbol=\"" <> sym <> "\" " <>
                                            "style=\"" <> badgeStyle <> "\">" <>
                                            symHtml <> "</button>"
                                        ]
                                    ],
                                    syms
                                ]
                            ];
                            "<div style=\"" <> groupStyle <> "\">" <>
                            "<div style=\"" <> groupLabelStyle <> "\">" <> ctxShort <> "</div>" <>
                            "<div style=\"" <> wrapStyle <> "\">" <> symBadges <> "</div>" <>
                            "</div>"
                        ]
                    ],
                    groups
                ]
            ];
            Return[
                "<div class=\"vscode-wolfram-info-grid\" style=\"padding:4px 2px;\">" <>
                "<div style=\"" <> headerStyle <> "\">" <>
                ToString[totalCount] <> " matching symbol" <>
                If[totalCount === 1, "", "s"] <>
                " &mdash; click to view documentation</div>" <>
                ctxHtml <>
                "</div>"
            ]
        ]
    ];

    (* ---- WLLatex path: TraditionalForm boxes → C++ boxToLatex addon → KaTeX HTML ---- *)
    If[fmt === "WLLatex",
        Module[{boxes, boxStr, b64},
            boxes = CheckAbort[Quiet[Check[MakeBoxes[expr, TraditionalForm], $Failed]], $Failed];
            If[boxes === $Failed,
                Return["<pre class=\"vscode-wolfram-text-output\">WLLatex: MakeBoxes failed.</pre>"]
            ];
            boxes = expandAllTemplateBoxes[boxes];
            boxStr = ToString[boxes, InputForm];
            (* Encode as UTF-8 bytes → Base64 so Unicode (emoji, \[Alpha]) survives
               without being converted to \|NNNNNN / \[Name] escape sequences that
               BTL cannot decode. *)
            b64 = Quiet[BaseEncode[StringToByteArray[boxStr, "UTF-8"], "Base64"]];
            b64 = StringReplace[b64, WhitespaceCharacter -> ""];
            Return["<div class=\"vscode-wolfram-wllatex-boxes\" data-boxes-b64=\"" <> b64 <> "\"></div>"]
        ]
    ];

    (* ---- WLLatex2 path: same box extraction, raw LaTeX rendered in webview via KaTeX ---- *)
    If[fmt === "WLLatex2",
        Module[{boxes, boxStr, b64},
            boxes = CheckAbort[Quiet[Check[MakeBoxes[expr, TraditionalForm], $Failed]], $Failed];
            If[boxes === $Failed,
                Return["<pre class=\"vscode-wolfram-text-output\">WLLatex2: MakeBoxes failed.</pre>"]
            ];
            boxes = expandAllTemplateBoxes[boxes];
            boxStr = ToString[boxes, InputForm];
            b64 = Quiet[BaseEncode[StringToByteArray[boxStr, "UTF-8"], "Base64"]];
            b64 = StringReplace[b64, WhitespaceCharacter -> ""];
            Return["<div class=\"vscode-wolfram-wllatex-boxes-raw\" data-boxes-b64=\"" <> b64 <> "\"></div>"]
        ]
    ];

    (* ---- WLLatexSrc path: same box extraction, sends boxes to JS for btl→LaTeX source display ---- *)
    If[fmt === "WLLatexSrc",
        Module[{boxes, boxStr, b64},
            boxes = CheckAbort[Quiet[Check[MakeBoxes[expr, TraditionalForm], $Failed]], $Failed];
            If[boxes === $Failed,
                Return["<pre class=\"vscode-wolfram-text-output\">LaTeX src: MakeBoxes failed.</pre>"]
            ];
            boxes = expandAllTemplateBoxes[boxes];
            boxStr = ToString[boxes, InputForm];
            b64 = Quiet[BaseEncode[StringToByteArray[boxStr, "UTF-8"], "Base64"]];
            b64 = StringReplace[b64, WhitespaceCharacter -> ""];
            Return["<div class=\"vscode-wolfram-wllatex-boxes-src\" data-boxes-b64=\"" <> b64 <> "\"></div>"]
        ]
    ];

    (* ---- SVGSrc path: convert SVG to TikZ via svg2tikz (pip install svg2tikz) ---- *)
    If[fmt === "SVGSrc",
        If[!graphicsQ[expr],
            Return["<pre class=\"vscode-wolfram-text-output\">TikZ export is only available for graphics expressions.</pre>"]
        ];
        svgStr = Quiet[CheckAbort[Check[TimeConstrained[ExportString[expr, "SVG", Background -> None], 15, $Failed], $Failed], $Failed]];
        If[!StringQ[svgStr],
            Return["<pre class=\"vscode-wolfram-text-output\">SVG export failed — cannot convert to TikZ.</pre>"]
        ];
        Module[{svgTmp, tikzResult, tikzStr, errMsg},
            svgTmp = FileNameJoin[{$TemporaryDirectory,
                "wolfbook_" <> StringReplace[CreateUUID[], "-" -> ""] <> ".svg"}];
            Quiet[Export[svgTmp, svgStr, "String"]];
            tikzResult = Quiet[Check[RunProcess[{"svg2tikz", "--codeoutput", "codeonly", svgTmp}], $Failed]];
            Quiet[DeleteFile[svgTmp]];
            If[!AssociationQ[tikzResult],
                (* svg2tikz not found on PATH *)
                Return["<pre class=\"vscode-wolfram-text-output\">svg2tikz not found.\nInstall it with:\n\n    pip install svg2tikz\n\nThen reload the VS Code window.</pre>"]
            ];
            If[tikzResult["ExitCode"] =!= 0,
                errMsg = If[StringQ[tikzResult["StandardError"]] && tikzResult["StandardError"] =!= "",
                            tikzResult["StandardError"], "(no error details)"];
                Return["<pre class=\"vscode-wolfram-text-output\">svg2tikz failed (exit " <>
                    ToString[tikzResult["ExitCode"]] <> "):\n" <> errMsg <> "</pre>"]
            ];
            tikzStr = "% \\usepackage{tikz}\n\n" <> tikzResult["StandardOutput"];
            Module[{esc = StringReplace[tikzStr, {"&" -> "&amp;", "\"" -> "&quot;", "<" -> "&lt;", ">" -> "&gt;", "\n" -> "&#10;", "\r" -> ""}]},
                Return["<pre class=\"vscode-wolfram-tex-source\" data-tex-src=\"" <> esc <> "\" data-hljs-lang=\"latex\"></pre>"]
            ]
        ]
    ];

    (* ---- SVGT path: TraditionalForm typeset for non-graphics; same as SVG for graphics ---- *)
    If[fmt === "SVGT",
        If[graphicsQ[expr],
            fmt = "SVG",  (* Graphics: delegate to the SVG path below *)
            (* Non-graphics: rasterize the TraditionalForm typeset expression to PNG *)
            rasImg = Quiet[CheckAbort[Check[TimeConstrained[Rasterize[TraditionalForm[expr], ImageResolution -> 144, Background -> None], 15, $Failed], $Failed], $Failed]];
            If[ImageQ[rasImg],
                If[$wolframImgDir =!= "" && StringLength[$wolframImgDir] > 0,
                    rasFname = "wl_" <> IntegerString[Hash[rasImg], 36] <> ".png";
                    rasFpath = FileNameJoin[{$wolframImgDir, rasFname}];
                    If[!FileExistsQ[rasFpath], Quiet[Export[rasFpath, rasImg, "PNG"]]];
                    If[FileExistsQ[rasFpath],
                        Return["<img class=\"vscode-wolfram-png-output\" data-wl-img=\"" <>
                               rasFpath <> "\" src=\"" <>
                               $wolframImgRelPrefix <> "/" <> rasFname <> "\"/>"]]]
            ];
            (* No imgDir set — cannot save image file *)
            If[ImageQ[rasImg],
                Return["<pre class=\"vscode-wolfram-text-output\">Image dir not configured — cannot render graphics.</pre>"]]
            ;
            fmt = "MathML"  (* Rasterize fallback *)
        ]
    ];

    (* ---- SVG path: Graphics → SVG/PNG vector; non-graphics → Rasterize → PNG ---- *)
    If[fmt === "SVG",
        If[graphicsQ[expr],
            svgStr = Quiet[CheckAbort[Check[TimeConstrained[ExportString[expr, "SVG", Background -> None], 10, $Failed], $Failed], $Failed]];
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
            (* SVG succeeded — save to file. Falls through to PNG only if SVG timed out. *)
            If[StringQ[svgStr] && StringContainsQ[svgStr, "<svg"],
                If[$wolframImgDir =!= "" && StringLength[$wolframImgDir] > 0,
                    (* Save SVG file. Return here exits VsCodeRenderExpr (outer Module). *)
                    hashStr = IntegerString[Hash[svgStr], 36];
                    fname = "wl_" <> hashStr <> ".svg";
                    fpath = FileNameJoin[{$wolframImgDir, fname}];
                    If[!FileExistsQ[fpath], Quiet[Export[fpath, svgStr, "String"]]];
                    Return["<img class=\"vscode-wolfram-svg-output\" data-wl-img=\"" <>
                           fpath <> "\" src=\"" <>
                           $wolframImgRelPrefix <> "/" <> fname <> "\"/>"]
                ]
            ];
            (* SVG timed out (>10s) — PNG fallback at the same ImageSize so it looks the same. *)
            If[$wolframImgDir =!= "" && StringLength[$wolframImgDir] > 0,
                hashStr = IntegerString[Hash[expr], 36];
                fname = "wl_" <> hashStr <> ".png";
                fpath = FileNameJoin[{$wolframImgDir, fname}];
                If[!FileExistsQ[fpath],
                    Quiet[CheckAbort[Export[fpath, expr, "PNG",
                        Background -> None, ImageSize -> Automatic, ImageResolution -> 144], $Failed]]];
                If[FileExistsQ[fpath],
                    Return["<img class=\"vscode-wolfram-png-output\" data-wl-img=\"" <>
                           fpath <> "\" src=\"" <>
                           $wolframImgRelPrefix <> "/" <> fname <> "\"/>"]
                ]
            ];
            (* No imgDir — cannot render graphics without an image directory *)
            Return["<pre class=\"vscode-wolfram-text-output\">Image dir not configured — cannot render graphics.</pre>"]
        ,
            (* Non-Graphics SVG: Rasterize the typeset expression to PNG *)
            rasImg = Quiet[CheckAbort[Check[TimeConstrained[Rasterize[expr, ImageResolution -> 144, Background -> None], 15, $Failed], $Failed], $Failed]];
            If[ImageQ[rasImg],
                If[$wolframImgDir =!= "" && StringLength[$wolframImgDir] > 0,
                    (* Hash-based filename: same rasterized image → same file, no duplicate writes. *)
                    rasFname = "wl_" <> IntegerString[Hash[rasImg], 36] <> ".png";
                    rasFpath = FileNameJoin[{$wolframImgDir, rasFname}];
                    If[!FileExistsQ[rasFpath], Quiet[Export[rasFpath, rasImg, "PNG"]]];
                    If[FileExistsQ[rasFpath],
                        Return["<img class=\"vscode-wolfram-png-output\" data-wl-img=\"" <>
                               rasFpath <> "\" src=\"" <>
                               $wolframImgRelPrefix <> "/" <> rasFname <> "\"/>"]]];
                (* No imgDir — cannot save rasterized image *)
                Return["<pre class=\"vscode-wolfram-text-output\">Image dir not configured — cannot render graphics.</pre>"]
            ]
        ];
        (* All SVG/PNG/Rasterize attempts failed — fall through to MathML *)
        fmt = "MathML"
    ];

    (* ---- TeX rendered: TeXForm → KaTeX div (renderer injects KaTeX) ---- *)
    (* ---- TeX source:   TeXForm → highlighted code block              ---- *)
    If[fmt === "TeX" || fmt === "TeXSrc",
        texStr = Quiet[Check[ToString[expr, TeXForm], $Failed]];
        If[StringQ[texStr],
            Module[{esc = StringReplace[texStr, {"&" -> "&amp;", "\"" -> "&quot;", "<" -> "&lt;", ">" -> "&gt;", "\n" -> "&#10;", "\r" -> ""}]},
                If[fmt === "TeXSrc",
                    Return["<pre class=\"vscode-wolfram-tex-source\" data-tex-src=\"" <> esc <> "\"></pre>"],
                    (* TeX rendered: HTML-attribute-escape LaTeX so it survives WSTP transit *)
                    Return["<div class=\"vscode-wolfram-tex-output\" data-tex-src=\"" <> esc <> "\"></div>"]
                ]
            ]
        ];
        fmt = "MathML"  (* fallback if TeXForm fails *)
    ];

    (* ---- InputForm / plain text path ---- *)
    If[fmt === "InputForm",
        Module[{s, innerExpr},
            (* If VsCodeRender/VsCodeRenderShallow wrapped the display expression in
               Shallow[...] for truncation, unwrap it: ToString[Shallow[e,spec],InputForm]
               prints "Shallow[{...},spec]" which is wrong — the user expects the
               truncated content without the Shallow head. *)
            innerExpr = If[Head[expr] === Shallow, First[expr], expr];
            s = ToString[innerExpr, InputForm];
            (* Decode WL \:XXXX unicode escape sequences produced by InputForm *)
            s = StringReplace[s, "\\:" ~~ h:RegularExpression["[0-9a-fA-F]{4}"] :>
                    FromCharacterCode[FromDigits[h, 16]]];
            Return["<pre class=\"vscode-wolfram-text-output\" style=\"white-space:pre-wrap;overflow-wrap:break-word;\">" <>
                   StringReplace[s, {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}] <>
                   "</pre>"]
        ]
    ];

    (* ---- MathML path: for all algebraic / symbolic expressions ---- *)
    (* CheckAbort wraps ExportString so that a $RecursionLimit abort caused by
       user Format rules (e.g. Format[x]=Style[x,Red]) does not silently abort
       the entire rendering call and produce no output. *)
    If[fmt === "MathML",
        mathmlStr = CheckAbort[
            Quiet[Check[TimeConstrained[ExportString[expr, "MathML"], 15, $Failed], $Failed]],
            $Failed];
        (* Strip any <?xml...>/<!DOCTYPE...> preamble before <math *)
        If[StringQ[mathmlStr],
            mathStart = First[Flatten[StringPosition[mathmlStr, "<math"]], 0];
            If[mathStart > 1, mathmlStr = StringDrop[mathmlStr, mathStart - 1]]];
        (* Size guard: MathML >60 KB causes browser layout freeze; fall to Text. *)
        If[StringQ[mathmlStr] && 5 < StringLength[mathmlStr] <= 60000,
            Return[
                "<div class=\"mathml-output\" style=\"overflow-x:auto;\">" <>
                cleanMathML[mathmlStr] <> "</div>"
            ]];
        (* MathML export failed: recursion limit from a Format rule, timeout, or
           export error.  Return an amber warning + InputForm text so the user
           understands why no formatted output is shown. *)
        Return[
            "<div class=\"vscode-wolfram-message-output\" style=\"color:#cc8800;padding:4px 0\">" <>
            "Rendering failed \[LongDash] MathML export returned $Failed. " <>
            "If you have a custom Format rule (e.g. <code>Format[x]=Style[x,Red]</code>), " <>
            "clear it with <code>Unset[Format[x]]</code> then re-evaluate." <>
            "</div>" <>
            "<pre class=\"vscode-wolfram-text-output\">" <>
            CheckAbort[
                StringReplace[ToString[expr, InputForm],
                    {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}],
                StringReplace[ToString[expr, FullForm],
                    {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}]
            ] <>
            "</pre>"
        ]
    ];

    (* ---- HTML path (explicit) ---- *)
    If[fmt === "HTML",
        html = CheckAbort[Quiet[renderHTML[Quiet[MakeBoxes[expr, StandardForm]]]], $Failed];
        If[StringQ[html], Return[html]];
        fmt = "Text"
    ];

    (* ---- Text / InputForm fallback ---- *)
    (* Use CheckAbort so a recursive Format rule on any sub-symbol doesn't abort
       the fallback too.  If InputForm also fails, show the FullForm (always safe). *)
    CheckAbort[
        "<pre class=\"vscode-wolfram-text-output\">" <>
        StringReplace[ToString[expr, InputForm], {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}] <>
        "</pre>",
        (* Abort in InputForm (unusual but possible with all-forms Format rule): fall to FullForm *)
        "<pre class=\"vscode-wolfram-text-output\">" <>
        StringReplace[ToString[expr, FullForm], {"<" -> "&lt;", ">" -> "&gt;", "&" -> "&amp;"}] <>
        "</pre>"]
 ] (* end Module *)
]; (* end Block *)

(* ===== Protect all wolfbook render-expr symbols from ClearAll["Global`*"] ===== *)
Protect[
    WBVersion, makeWrapButton, UseSvgQ, cleanMathML, vscodeStripSVGFonts,
    expandAllTemplateBoxes, mathematicaformatResult, expandInlineBoxes,
    prepareExprForBoxes, graphicsQ, VsCodeRenderExpr
];
