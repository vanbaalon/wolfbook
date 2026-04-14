#!/usr/bin/env wolframscript
(* Convert .nb to .evsnb format *)
(* Usage: wolframscript convert_nb_to_vsnb.wls prototype1.nb *)

(* Get command line arguments *)
args = $ScriptCommandLine;

(* Locate tools relative to this script file (works even when CWD differs) *)
scriptDir = If[ValueQ[$InputFileName] && $InputFileName =!= "",
  DirectoryName[ExpandFileName[$InputFileName]],
  Directory[]
];

(* Accept input/output paths via env vars first — this avoids shell argument-
   splitting on paths that contain spaces.  Args are used as fallback so the
   script still works when called manually from the command line. *)
envInput  = Environment["WB_INPUT"];
envOutput = Environment["WB_OUTPUT"];

If[(envInput === $Failed || envInput === "") && Length[args] < 2,
  Print["Usage: wolframscript convert_nb_to_vsnb.wls <input.nb> [output.evsnb]"];
  Print["       (or set WB_INPUT / WB_OUTPUT environment variables)"];
  Exit[1];
];

inputFile = If[envInput =!= $Failed && envInput =!= "", envInput, args[[2]]];

outputFile = Which[
  envOutput =!= $Failed && envOutput =!= "",  envOutput,
  Length[args] >= 3,                           args[[3]],
  True,  FileNameJoin[{DirectoryName[AbsoluteFileName[inputFile]],
                       FileBaseName[inputFile] <> ".evsnb"}]
];

(* Paths of temporary files to clean up at the end *)
tempNbCopy = "";
tempMFile  = "";

(* Check if input is .nb file - if so, use nb2m script first *)
If[StringEndsQ[inputFile, ".nb"],
  Print["Converting .nb to .m using nb2m..."];

  nbmPath = FileNameJoin[{scriptDir, "nb2m"}];
  If[!FileExistsQ[nbmPath],
    Print["Error: nb2m not found at ", nbmPath];
    Exit[1];
  ];

  (* nb2m writes <basename>.m adjacent to its input file.
     To avoid polluting the user's source directory, copy the .nb to $TemporaryDirectory
     first - nb2m will then write the .m there too. *)
  tmpBase    = FileNameJoin[{$TemporaryDirectory, FileBaseName[inputFile]}];
  tempNbCopy = tmpBase <> ".nb";
  tempMFile  = tmpBase <> ".m";

  CopyFile[AbsoluteFileName[inputFile], tempNbCopy, OverwriteTarget -> True];

  (* On Windows nb2m is a wolframscript script with a Unix shebang — it cannot
     be executed directly. Invoke via wolframscript instead. *)
  nb2mCmd = If[$OperatingSystem === "Windows",
    {"wolframscript", "-file", nbmPath, tempNbCopy},
    {nbmPath, tempNbCopy}
  ];
  result = RunProcess[nb2mCmd];
  If[result["ExitCode"] != 0,
    (* cleanup *)
    If[FileExistsQ[tempNbCopy], DeleteFile[tempNbCopy]];
    Print["Error: nb2m conversion failed"];
    Print["Output: ", result["StandardOutput"]];
    Print["Error: ", result["StandardError"]];
    Exit[1];
  ];

  If[!FileExistsQ[tempMFile],
    If[FileExistsQ[tempNbCopy], DeleteFile[tempNbCopy]];
    Print["Error: nb2m ran but .m file not found at ", tempMFile];
    Exit[1];
  ];

  Print["Successfully created ", tempMFile];

  (* Use the .m file as input for the rest of the conversion *)
  inputFile = tempMFile;
];

(* Read the .m file with UTF-8 encoding *)
content = Import[inputFile, "Text", CharacterEncoding -> "UTF-8"];

(* Replace Mathematica special characters with reasonable UTF-8 alternatives *)
(* This handles Wolfram's Private Use Area characters that nb2m outputs *)
specialCharReplacements = {
  (* Wolfram Private Use Area → Standard Unicode Math Symbols *)
  (* Script capitals *)
  FromCharacterCode[{16^^F6E7}] -> "ℱ",  (* Script F - U+2131 *)
  FromCharacterCode[{16^^F6E6}] -> "ℬ",  (* Script B - U+212C *)
  FromCharacterCode[{16^^F750}] -> "𝒫",  (* Script P - U+1D4AB *)
  FromCharacterCode[{16^^F74B}] -> "ℋ",  (* Script H - U+210B *)
  FromCharacterCode[{16^^F74F}] -> "ℒ",  (* Script L - U+2112 *)
  FromCharacterCode[{16^^F74C}] -> "ℳ",  (* Script M - U+2133 *)
  FromCharacterCode[{16^^F77D}] -> "𝒩",  (* Script N - U+1D4A9 *)
  FromCharacterCode[{16^^F6EA}] -> "𝒮",  (* Script S - U+1D4AE *)
  FromCharacterCode[{16^^F74D}] -> "E",  (* ExponentialE *)
  FromCharacterCode[{16^^F74E}] -> "I",  (* ImaginaryI *)
  (* Lowercase double-struck letters - convert from ASCII markers *)
  "__DBLSTKA__" -> FromCharacterCode[{16^^1D552}],  (* 𝕒 = a *)
  "__DBLSTKB__" -> FromCharacterCode[{16^^1D553}],  (* 𝕓 = b *)
  "__DBLSTKC__" -> FromCharacterCode[{16^^1D554}],  (* 𝕔 = c *)
  "__DBLSTKD__" -> FromCharacterCode[{16^^1D555}],  (* 𝕕 = d *)
  "__DBLSTKE__" -> FromCharacterCode[{16^^1D556}],  (* 𝕖 = e *)
  "__DBLSTKF__" -> FromCharacterCode[{16^^1D557}],  (* 𝕗 = f *)
  "__DBLSTKG__" -> FromCharacterCode[{16^^1D558}],  (* 𝕘 = g *)
  "__DBLSTKH__" -> FromCharacterCode[{16^^1D559}],  (* 𝕙 = h *)
  "__DBLSTKI__" -> FromCharacterCode[{16^^1D55A}],  (* 𝕚 = i *)
  "__DBLSTKJ__" -> FromCharacterCode[{16^^1D55B}],  (* 𝕛 = j *)
  "__DBLSTKK__" -> FromCharacterCode[{16^^1D55C}],  (* 𝕜 = k *)
  "__DBLSTKL__" -> FromCharacterCode[{16^^1D55D}],  (* 𝕝 = l *)
  "__DBLSTKM__" -> FromCharacterCode[{16^^1D55E}],  (* 𝕞 = m *)
  "__DBLSTKN__" -> FromCharacterCode[{16^^1D55F}],  (* 𝕟 = n *)
  "__DBLSTKO__" -> FromCharacterCode[{16^^1D560}],  (* 𝕠 = o *)
  "__DBLSTKP__" -> FromCharacterCode[{16^^1D561}],  (* 𝕡 = p *)
  "__DBLSTKQ__" -> FromCharacterCode[{16^^1D562}],  (* 𝕢 = q *)
  "__DBLSTKR__" -> FromCharacterCode[{16^^1D563}],  (* 𝕣 = r *)
  "__DBLSTKS__" -> FromCharacterCode[{16^^1D564}],  (* 𝕤 = s *)
  "__DBLSTKT__" -> FromCharacterCode[{16^^1D565}],  (* 𝕥 = t *)
  "__DBLSTKU__" -> FromCharacterCode[{16^^1D566}],  (* 𝕦 = u *)
  "__DBLSTKV__" -> FromCharacterCode[{16^^1D567}],  (* 𝕧 = v *)
  "__DBLSTKW__" -> FromCharacterCode[{16^^1D568}],  (* 𝕨 = w *)
  "__DBLSTKX__" -> FromCharacterCode[{16^^1D569}],  (* 𝕩 = x *)
  "__DBLSTKY__" -> FromCharacterCode[{16^^1D56A}],  (* 𝕪 = y *)
  "__DBLSTKZ__" -> FromCharacterCode[{16^^1D56B}],  (* 𝕫 = z *)
  (* DoubleStruck capitals *)
  FromCharacterCode[{16^^F7DA}] -> "ℂ",  (* DoubleStruck C - U+2102 *)
  FromCharacterCode[{16^^F7A9}] -> FromCharacterCode[{16^^1D53D}],  (* DoubleStruck F - U+1D53D = 𝔽 *)
  FromCharacterCode[{16^^F7AD}] -> FromCharacterCode[{16^^1D541}],  (* DoubleStruck J - U+1D541 = 𝕁 *)
  FromCharacterCode[{16^^F7B0}] -> FromCharacterCode[{16^^1D544}],  (* DoubleStruck M - U+1D544 = 𝕄 *)
  FromCharacterCode[{16^^F7D9}] -> "ℕ",  (* DoubleStruck N - U+2115 *)
  FromCharacterCode[{16^^F7DF}] -> "ℙ",  (* DoubleStruck P - U+2119 *)
  FromCharacterCode[{16^^F7E0}] -> "ℚ",  (* DoubleStruck Q - U+211A *)
  FromCharacterCode[{16^^F7E1}] -> "ℝ",  (* DoubleStruck R - U+211D *)
  FromCharacterCode[{16^^F7B6}] -> FromCharacterCode[{16^^1D54A}],  (* DoubleStruck S - U+1D54A = 𝕊 *)
  FromCharacterCode[{16^^F7E5}] -> "ℤ",  (* DoubleStruck Z - U+2124 *)
  (* Greek variants *)
  FromCharacterCode[{16^^F753}] -> "φ",  (* varphi - U+03C6 *)
  (* Common math symbols *)
  FromCharacterCode[{16^^F734}] -> "∞",  (* Infinity - U+221E *)
  FromCharacterCode[{16^^F733}] -> "∈",  (* Element - U+2208 *)
  FromCharacterCode[{16^^F7AA}] -> "∉",  (* NotElement - U+2209 *)
  FromCharacterCode[{16^^F6DF}] -> "∂",  (* PartialD - U+2202 *)
  FromCharacterCode[{16^^F3C7}] -> "\\[Transpose]",  (* Keep as literal \[Transpose] *)
  FromCharacterCode[{16^^F520}] -> "□",  (* Square - U+25A1 *)
  FromCharacterCode[{16^^F452}] -> "∀",  (* ForAll - U+2200 *)
  FromCharacterCode[{16^^F465}] -> "∃"   (* Exists - U+2203 *)
};

(* Debug: check if we have any Private Use Area characters before replacement *)
puaCount = Sum[StringCount[content, FromCharacterCode[{i}]], {i, 16^^F4DB, 16^^F4F4}];
If[puaCount > 0, Print["DEBUG: Found ", puaCount, " lowercase blackboard PUA characters (U+F4DB-F4F4)"]];
privatUseCount = StringCount[content, FromCharacterCode[{16^^F6E7}]] + StringCount[content, FromCharacterCode[{16^^F6E6}]];
If[privatUseCount > 0, Print["DEBUG: Found ", privatUseCount, " Private Use Area characters to replace"]];

content = StringReplace[content, specialCharReplacements];

(* Debug: check if replacement happened *)
lowerBBCount = Sum[StringCount[content, FromCharacterCode[{i}]], {i, 16^^1D552, 16^^1D56B}];
If[lowerBBCount > 0, Print["DEBUG: After replacement, found ", lowerBBCount, " lowercase blackboard letters (U+1D552-1D56B)"]];
replacedCount = StringCount[content, "ℱ"] + StringCount[content, "ℬ"];
If[replacedCount > 0, Print["DEBUG: After replacement, found ", replacedCount, " Unicode math symbols"]];

(* Remove the Package header line *)
content = StringReplace[content, StartOfString ~~ "(* ::Package:: *)\n\n" -> ""];

(* Split on ANY cell marker recognised by nb2m *)
cellMarkerPattern =
  "(* ::Input:: *)\n" |
  "(* ::Input::Initialization:: *)\n" |
  "(* ::Title:: *)\n" |
  "(* ::Section:: *)\n" |
  "(* ::Subsection:: *)\n" |
  "(* ::Subsubsection:: *)\n" |
  "(* ::Text:: *)\n" |
  "(* ::Code:: *)\n" |
  "(* ::Output:: *)\n";

(* Split while keeping the delimiters *)
parts = StringSplit[content, d:cellMarkerPattern :> d];

(* Remove empty parts *)
parts = Select[parts, StringLength[StringTrim[#]] > 0 &];

(* Group parts into cells: each cell starts with a marker followed by content *)
rawCells = {};
i = 1;
While[i <= Length[parts],
  part = parts[[i]];
  (* Check if this part is a cell marker *)
  If[StringMatchQ[part, cellMarkerPattern],
    (* This is a marker, next part (if exists) is the content *)
    marker = part;
    content = If[i < Length[parts] && !StringMatchQ[parts[[i+1]], cellMarkerPattern], parts[[i+1]], ""];
    AppendTo[rawCells, marker <> content];
    i = i + If[content != "", 2, 1];
    ,
    (* This shouldn't happen, but skip if it does *)
    i = i + 1;
  ];
];

Print["Found ", Length[rawCells], " cells"];

(* Process each cell - detect Title/Section markers and convert to markdown *)
jsonCells = Table[
  cellCode = StringTrim[rawCells[[i]]];
  
  (* Check if this is a Title or Section marker *)
  cellKind = 2; (* default: code cell *)
  cellLanguage = "wolfram";
  processedCode = cellCode;
  
  (* Check for Title marker: (* ::Title:: *)\n(*title text*) *)
  If[StringContainsQ[cellCode, "(* ::Title:: *)"],
    cellKind = 1; (* markdown cell *)
    cellLanguage = "markdown";
    (* Extract the title text from (*title text*) and remove the marker *)
    processedCode = StringReplace[cellCode, {
      "(* ::Title:: *)\n(*" ~~ title__ ~~ "*)" :> "# " <> title,
      "(* ::Title:: *)(*" ~~ title__ ~~ "*)" :> "# " <> title,
      "(* ::Title:: *)\n" -> ""
    }];
    processedCode = StringTrim[processedCode];
  ];
  
  (* Check for Section marker: (* ::Section:: *)\n(*section text*) *)
  If[StringContainsQ[cellCode, "(* ::Section:: *)"],
    cellKind = 1; (* markdown cell *)
    cellLanguage = "markdown";
    (* Extract the section text from (*section text*) and remove the marker *)
    processedCode = StringReplace[cellCode, {
      "(* ::Section:: *)\n(*" ~~ section__ ~~ "*)" :> "## " <> section,
      "(* ::Section:: *)(*" ~~ section__ ~~ "*)" :> "## " <> section,
      "(* ::Section:: *)\n" -> ""
    }];
    processedCode = StringTrim[processedCode];
  ];
  
  (* Check for Subsection marker *)
  If[StringContainsQ[cellCode, "(* ::Subsection:: *)"],
    cellKind = 1;
    cellLanguage = "markdown";
    processedCode = StringReplace[cellCode, {
      "(* ::Subsection:: *)\n(*" ~~ subsection__ ~~ "*)" :> "### " <> subsection,
      "(* ::Subsection:: *)(*" ~~ subsection__ ~~ "*)" :> "### " <> subsection,
      "(* ::Subsection:: *)\n" -> ""
    }];
    processedCode = StringTrim[processedCode];
  ];
  
  (* Check for Text marker *)
  If[StringContainsQ[cellCode, "(* ::Text:: *)"],
    cellKind = 1;
    cellLanguage = "markdown";
    processedCode = StringReplace[cellCode, {
      "(* ::Text:: *)\n(*" ~~ text__ ~~ "*)" :> text,
      "(* ::Text:: *)(*" ~~ text__ ~~ "*)" :> text,
      "(* ::Text:: *)\n" -> ""
    }];
    processedCode = StringTrim[processedCode];
  ];
  
  (* For Input cells, remove the marker *)
  If[StringContainsQ[cellCode, "(* ::Input::Initialization:: *)"],
    processedCode = StringReplace[cellCode, "(* ::Input::Initialization:: *)\n" -> ""];
    processedCode = StringTrim[processedCode];
  ];
  
  (* Skip cells that are just graphics (don't render correctly) *)
  If[StringContainsQ[processedCode, "GraphicsBox"] && StringContainsQ[processedCode, "CompressedData"],
    Nothing,
    (* else *)
    (* Generate cell ID from hash *)
    cellId = "#VSC-" <> StringTake[IntegerString[Hash[processedCode], 16, 8], -8];
    
    (* Manually escape string for JSON - avoid ExportString which mangles UTF-8 *)
    escapedCode = StringReplace[processedCode, {
      "\\" -> "\\\\",
      "\"" -> "\\\"",
      "\n" -> "\\n",
      "\r" -> "\\r",
      "\t" -> "\\t"
    }];
    
    (* Build the cell JSON *)
    "{\"kind\":" <> ToString[cellKind] <> ",\"value\":\"" <> escapedCode <> "\",\"languageId\":\"" <> cellLanguage <> "\",\"id\":\"" <> cellId <> "\"}"
  ]
  ,
  {i, Length[rawCells]}
];

(* Build the full JSON structure *)
allCells = jsonCells;
output = "{\"cells\":[" <> StringRiffle[allCells, ",\n"] <> "]}";

(* Write file using Export with explicit UTF-8 encoding *)
Export[outputFile, output, "Text", CharacterEncoding -> "UTF8"];

Print["Converted ", Length[jsonCells], " cells to ", outputFile];

(* Fix UTF-8 double-encoding using Python post-processor *)
pythonScript = FileNameJoin[{scriptDir, "fix_vsnb_encoding.py"}];
If[FileExistsQ[pythonScript],
  fixResult = RunProcess[{"python3", pythonScript, outputFile}];
  If[fixResult["ExitCode"] == 0,
    Print[StringTrim[fixResult["StandardOutput"]]],
    Print["Warning: UTF-8 fix failed: ", fixResult["StandardError"]]
  ],
  Print["Warning: fix_vsnb_encoding.py not found in current directory"]
];

(* Clean up temporary files in $TemporaryDirectory *)
If[tempMFile  =!= "" && FileExistsQ[tempMFile],  DeleteFile[tempMFile];  Print["Cleaned up ", tempMFile]];
If[tempNbCopy =!= "" && FileExistsQ[tempNbCopy], DeleteFile[tempNbCopy]; Print["Cleaned up ", tempNbCopy]];
