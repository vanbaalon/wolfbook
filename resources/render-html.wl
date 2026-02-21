(* ::Package:: *)

(* 

  // Copyright 2021 Tianhuan Lu
  // 
  // Licensed under the Apache License, Version 2.0 (the "License");
  // you may not use this file except in compliance with the License.
  // You may obtain a copy of the License at
  // 
  //     http://www.apache.org/licenses/LICENSE-2.0
  // 
  // Unless required by applicable law or agreed to in writing, software
  // distributed under the License is distributed on an "AS IS" BASIS,
  // WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  // See the License for the specific language governing permissions and
  // limitations under the License. 

*)


$IterationLimit=400000;
$RecursionLimit=100000;


ClearAll[renderWrapper,renderHTML,renderImage,renderHTMLimage,renderMathML,renderInputForm];


$statestack=<||>;
$inheritedStyle=<||>;
$localStyle=<||>;

localStyleNames=<|
  RowBox->{},
  SqrtBox->{SurdForm},
  RadicalBox->{SurdForm},
  FrameBox->{Background,FrameMargins,ImageMargins,RoundingRadius},
  StyleBox->{TextAlignment,FontFamily,FontSize,FontWeight,FontSlant,FontTracking,FontVariations,FontColor,FontOpacity,Background},
  PaneBox->{ImageSize},
  GridBox->{GridBoxFrame}
|>;
inheritedStyleNames=<|
  RowBox->{},
  StyleBox->{ShowStringCharacters,SingleLetterItalics},
  PaneBox->{}
|>;
handleStyles[head_,styles_]:=Module[{keys},
  keys=Keys[styles];
  $localStyle=KeyTake[styles,Intersection[keys,Lookup[localStyleNames,head,{}]]];
  {KeyTake[styles,#],AssociationThread[#->Lookup[$inheritedStyle,#,Missing[]]]}&@Intersection[keys,Lookup[inheritedStyleNames,head,{}]]
];

SetAttributes[renderWrapper,HoldAll];
renderWrapper[state_Association,styles_,expr_]:=Module[{return,stateModifier,pop},
  stackPush[$statestack,Join[<|"head"->Null,"mutable"->False,"bracket"->False|>,<|"head"->state["head"]|>]];
  If[Length[styles]==0,$localStyle=<||>;,
    stateModifier=handleStyles[state["head"],styles];
    AssociateTo[$inheritedStyle,stateModifier[[1]]];
  ];

  return=expr;
  If[Length[styles]==0,$localStyle=<||>;,
    AssociateTo[$inheritedStyle,Select[stateModifier[[2]],Not@*MissingQ]];
    KeyDropFrom[$inheritedStyle,Keys@Select[stateModifier[[2]],MissingQ]];
  ];
  pop=stackPop[$statestack];
  If[pop["mutable"]===True&&Length[$statestack]>0,Null(*$statestack[[-1,"mutable"]]=True*)];
  return
];
renderWrapper[head_Symbol,styles_,expr_]:=renderWrapper[<|"head"->head|>,styles,expr];

(* rasterizeAsImage[boxes_]:= Rasterize[RawBoxes[boxes], Background -> If[TrueQ@$getKernelConfig["imageWithTransparency"], None, Automatic]]; *)

rasterizeAsImage[boxes_]:=Module[{expr=RawBoxes[boxes],black,white,alpha,image},
  If[!TrueQ@$getKernelConfig["imageWithTransparency"],
    Rasterize[expr],
    black=ImageData@Rasterize[expr,Background->Black];
    white=ImageData@Rasterize[expr,Background->White];
    alpha=Clip[1.-(1./3)(Total[white,{3}]-Total[black,{3}]),{0.,1.}];
    image=0.5*(1.0-(1.0-white)/#)+0.5*(black/#)&[Transpose[ConstantArray[Clip[alpha,{0.001,1.0}],3],{3,1,2}]];
    SetAlphaChannel[Image[Clip[image,{0.,1.}]],Image[alpha]]
  ]
]

renderHTMLimage[x_,resizable_:True]:=Module[{img=rasterizeAsImage[x] ,dim, final,imageInBase64},

  Export[FileNameJoin[{$TemporaryDirectory,"img.jpg"}], img];
  ba = ExportByteArray[img, "PNG"];
  imageInBase64 = BaseEncode[ba];
  dim=ImageDimensions[img]; 
  disableInvert=!TrueQ@$getKernelConfig["invertBrightnessInDarkThemes"];
  StringJoin["<wgraph ",
    If[TrueQ[resizable],"class=\"resizable\" ",""],
    "style=\"width:",TextString[N[dim[[1]]* $getKernelConfig["imageScalingFactor"]]],"px;height:",TextString[N[dim[[2]] * $getKernelConfig["imageScalingFactor"]]],"px;\" ",
    "aspect-ratio=\"",TextString[N[dim[[2]]/dim[[1]]]],"\" ",
    "tabIndex=\"-1\"><img ",If[disableInvert,"style=\"filter:none;\" ",""],"src=\"data:image/png;base64,",
    imageInBase64,
    "\" /></wgraph>"
  ]

];

(* Render as Image - PNG wrapped in HTML *)
renderImage[boxes_]:=StringJoin["<div class=\"wexpr\">",renderHTMLimage[boxes],"</div>"]

(* Render genuine HTML output like Wolfram Cloud *)
renderHTML[boxes_]:=Module[{cellExpr,html},
  (* Convert boxes to expression *)
  cellExpr=ToExpression[boxes,StandardForm,HoldComplete];
  (* Export to HTML - this gives genuine HTML like Wolfram Cloud *)
  html=ExportString[cellExpr[[1]],"HTML"];
  (* Wrap in div with wexpr class for consistent styling *)
  StringJoin["<div class=\"wexpr\">",html,"</div>"]
]

(* Render MathML output *)
renderMathML[boxes_]:=Module[{mathml,cellExpr},
  (* Convert boxes to expression if needed *)
  cellExpr=ToExpression[boxes,StandardForm,HoldComplete];
  (* Export to MathML *)
  mathml=ExportString[cellExpr[[1]],"MathML"];
  (* Wrap in div with wexpr class for consistent styling *)
  StringJoin["<div class=\"wexpr\">",mathml,"</div>"]
]

(* Render InputForm output - flatten boxes to plain text like converter *)
renderInputForm[boxes_]:=Module[{text},
  (* Convert boxes directly to InputForm string - this flattens all formatting *)
  text=ToString[ToExpression[boxes,StandardForm],InputForm];
  (* Wrap in pre tag to preserve formatting and whitespace *)
  StringJoin["<div class=\"wexpr\"><pre style=\"font-family:monospace;white-space:pre-wrap;\">",text,"</pre></div>"]
]