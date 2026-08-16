(* Wolfbook: Graphics3D -> mesh JSON for the interactive WebGL viewer.

   Loaded by init.wl into Wolfbook`Private`, so every symbol here is internal
   and carries a wb3d prefix to stay clear of the other resource files.

   HARD RULE: everything in this file must stay IN-KERNEL. No Rasterize, no
   ExportString[g3d, "SVG"], no typesetting — those block in a C-level IPC wait
   on the front end (MathematicaServer), which TimeConstrained cannot interrupt.
   That is the reason render-expr.wl skips SVG for Graphics3D in the first place.

   Entry point: wb3dMeshJSON[expr] -> JSON string, or $Failed when the scene
   cannot be modelled (caller then keeps the PNG, which stays ground truth).
*)

$wb3dVertexCap = 400000;   (* total floats emitted before giving up *)

(* ---------- colour ---------- *)

(* AbsoluteOptions hands back RGBColor[{r,g,b}] (arguments wrapped in a list)
   while directives use RGBColor[r,g,b] — flatten so both read the same. *)
wb3dToRGB[c_] := Module[{r, l},
  r = Quiet@Check[ColorConvert[c, "RGB"], $Failed];
  If[Head[r] =!= RGBColor, Return[$Failed]];
  l = Flatten[List @@ r];
  If[Length[l] >= 3 && AllTrue[Take[l, 3], NumericQ], N@Take[l, 3], $Failed]];

wb3dAlpha[c_] := Module[{l},
  l = Quiet@Check[Flatten[List @@ ColorConvert[c, "RGB"]], {}];
  If[Length[l] >= 4 && NumericQ[l[[4]]], N@l[[4]], 1.]];

(* symbolic sizes (Thick, Large, ...) are not numbers *)
$wb3dThickSizes = <|Tiny -> 0.0005, Small -> 0.001, Medium -> 0.002,
                    Large -> 0.004, Thin -> 0.001, Thick -> 0.004|>;
$wb3dPointSizes = <|Tiny -> 0.003, Small -> 0.007, Medium -> 0.01, Large -> 0.015|>;

wb3dNumOr[x_, default_] := If[NumericQ[x], N[x], default];

(* ---------- pools: big arrays emitted once, referenced by id ---------- *)

(* Trim float noise to ~6 significant digits relative to the array's own scale.
   Roughly halves the JSON with no visible difference. *)
wb3dRoundArr[data_, rel_: 1.*^-6] := Module[{f, span},
  f = Flatten[data];
  If[f === {} || !AllTrue[f, NumericQ], Return[data]];
  span = Max[Abs[MinMax[f]]];
  If[!NumericQ[span] || span <= 0, data, Round[data, N[span] * rel]]];

wb3dPoolPut[data_, rel_: 1.*^-6] := Module[{d, key, id},
  d = wb3dRoundArr[N@data, rel];
  key = Hash[d];
  If[KeyExistsQ[$wb3dPoolIdx, key], Return[$wb3dPoolIdx[key]]];
  id = "p" <> ToString[Length[$wb3dPools]];
  $wb3dPools[id] = d;
  $wb3dPoolIdx[key] = id;
  $wb3dFloats += Length[Flatten[d]];
  If[$wb3dFloats > $wb3dVertexCap * 3, Throw[$Failed, "wb3d"]];
  id];

(* ---------- inherited directive state ---------- *)

$wb3dInit = <|
  "color" -> {0.45, 0.55, 0.75}, "opacity" -> 1.,
  "specular" -> None, "shininess" -> 30.,
  "pointSize" -> 0.008, "thickness" -> 0.002,
  "edge" -> Automatic,
  "pts" -> None, "vn" -> None, "vc" -> None
|>;

(* ---------- edges ----------

   Mathematica strokes polygon edges in Graphics3D by DEFAULT — that is the
   whole difference between our render and its PNG for explicit primitives.
   Measured on the reference images in Experiments/3d-graphics/out:

     Cuboid            all twelve edges, front AND back through a transparent face
     Polygon (explicit)  its boundary
     Cylinder          the two cap rims only — no silhouette, no facet seams
     Sphere            nothing at all
     Plot3D surface    nothing (the plot functions set EdgeForm[] themselves)

   The stroke is opaque black even when the FACE carries Opacity[0.4] (measured:
   RGBA 0,0,0/255 crossing a 40%-transparent cuboid), so the default edge does
   NOT inherit the surrounding face style. `edge` is therefore its own slot,
   Automatic until an EdgeForm says otherwise and resolved per primitive at the
   emit site. WHICH lines to draw is left to the viewer, which derives them from
   the geometry by dihedral angle — one rule that reproduces every row above. *)

$wb3dEdgeDefault = <|"color" -> {0., 0., 0.}, "opacity" -> 1., "thickness" -> 0.0015|>;

(* EdgeForm[] and EdgeForm[None] suppress; anything else is read as ordinary
   directives over the default, so EdgeForm[Directive[Red, Thick]] works. *)
wb3dEdgeFrom[args_List] := Module[{flat, st},
  flat = Flatten[Replace[args, {d_Directive :> List @@ d}, {1}]];
  If[flat === {} || MatchQ[flat, {None}],
    None,
    st = Fold[wb3dApplyDirective, Join[$wb3dInit, $wb3dEdgeDefault], flat];
    <|"color" -> st["color"], "opacity" -> st["opacity"],
      "thickness" -> st["thickness"]|>]];

wb3dDirectiveQ[d_] := MatchQ[d,
  _RGBColor | _GrayLevel | _Hue | _CMYKColor | _XYZColor | _LABColor |
  _Opacity | _Specularity | _Glow | _EdgeForm | _FaceForm | _Directive |
  _PointSize | _AbsolutePointSize | _Thickness | _AbsoluteThickness |
  Rule[Lighting, _] | _Dashing | _AbsoluteDashing | _CapForm | _JoinForm];

wb3dApplyDirective[st_, d_] := Module[{rgb},
  Which[
    Head[d] === Directive,   Fold[wb3dApplyDirective, st, List @@ d],
    Head[d] === Opacity,     Join[st, <|"opacity" -> wb3dNumOr[First[d], 1.]|>],
    Head[d] === Specularity, Join[st, <|
        "specular" -> Replace[wb3dToRGB[First[d]], $Failed -> {1., 1., 1.}],
        "shininess" -> If[Length[d] >= 2, wb3dNumOr[d[[2]], 30.], 30.]|>],
    Head[d] === PointSize || Head[d] === AbsolutePointSize,
        Join[st, <|"pointSize" ->
          wb3dNumOr[First[d], Lookup[$wb3dPointSizes, First[d], 0.008]]|>],
    Head[d] === Thickness || Head[d] === AbsoluteThickness,
        Join[st, <|"thickness" ->
          wb3dNumOr[First[d], Lookup[$wb3dThickSizes, First[d], 0.002]]|>],
    MatchQ[d, Rule[Lighting, _]], ($wb3dLighting = Last[d]; st),
    Head[d] === EdgeForm, Join[st, <|"edge" -> wb3dEdgeFrom[List @@ d]|>],
    (* parsed so they cannot leak a colour, but not modelled in v1 *)
    MatchQ[Head[d], FaceForm | Dashing | AbsoluteDashing |
                    CapForm | JoinForm | Glow], st,
    True,
      rgb = wb3dToRGB[d];
      If[rgb === $Failed, st,
         Join[st, <|"color" -> rgb, "opacity" -> wb3dAlpha[d] * st["opacity"]|>]]
  ]];

(* ---------- geometry helpers ---------- *)

wb3dIntArrayQ[a_]  := ArrayQ[a, _, IntegerQ];
wb3dRealArrayQ[a_] := ArrayQ[a, _, NumericQ] && !ArrayQ[a, _, IntegerQ];

(* fan-triangulate one index row {i1..in} *)
wb3dFanRow[row_List] := Table[{row[[1]], row[[k]], row[[k + 1]]}, {k, 2, Length[row] - 1}];
(* one index row -> consecutive segment pairs *)
wb3dSegRow[row_List] := Table[{row[[k]], row[[k + 1]]}, {k, 1, Length[row] - 1}];

(* Every polygon's CLOSED boundary, each shared edge kept once.
   This is what an explicit EdgeForm has to draw, and it is why it cannot be left
   to the viewer's dihedral rule: `Mesh -> All` reaches us as EdgeForm[
   GrayLevel[0.2]] over the surface polygons (confirmed from a live kernel's mesh
   JSON — zero Line objects), and on a smooth surface every interior edge is a
   shallow dihedral, so an angle threshold erases the whole mesh and leaves only
   the silhouette. The fan diagonals we add when triangulating are not polygon
   boundaries and must not appear, which rules out a plain wireframe too. *)
$wb3dEdgeSegCap = 120000;
wb3dBoundarySegs[rows_List] := Module[{s},
  s = Join @@ (Function[r, Append[wb3dSegRow[r], {Last[r], First[r]}]] /@ rows);
  If[Length[s] > $wb3dEdgeSegCap, Return[Null]];
  Flatten[DeleteDuplicates[Sort /@ s]]];

wb3dAsRows[spec_] := Which[
  wb3dIntArrayQ[spec] && ArrayDepth[spec] == 1, {spec},
  wb3dIntArrayQ[spec] && ArrayDepth[spec] == 2, spec,
  ListQ[spec] && AllTrue[spec, ListQ], spec,
  True, {spec}];

wb3dEmit[o_] := AppendTo[$wb3dObjs, o];

(* None is not JSON-encodable; Null is. Convert here, at the few places a slot
   can be empty, so the finished scene never needs a full-depth rewrite. *)
wb3dNull[x_] := Replace[x, None -> Null];

wb3dMat[st_] := <|
  "color" -> st["color"], "opacity" -> st["opacity"],
  "specular" -> Replace[st["specular"], None -> Null],
  "shininess" -> st["shininess"]|>;

(* Same material, plus the resolved edge slot. `default` is what THIS primitive
   does when no EdgeForm has been given — the second column of the table above. *)
wb3dMatE[st_, default_] :=
  Join[wb3dMat[st], <|"edge" -> wb3dNull[Replace[st["edge"], Automatic :> default]]|>];

(* ---------- the walker ---------- *)

wb3dWalk[l_List, st_] := (Fold[wb3dStep, st, l]; Null);
wb3dStep[st_, e_] := If[wb3dDirectiveQ[e], wb3dApplyDirective[st, e], (wb3dWalk[e, st]; st)];

wb3dWalk[GraphicsComplex[pts_, prims_, opts___], st_] := Module[{vn, vc, st2, o = {opts}},
  vn = VertexNormals /. o /. VertexNormals -> None;
  vc = VertexColors  /. o /. VertexColors  -> None;
  st2 = Join[st, <|
    "pts" -> wb3dPoolPut[N@pts],
    "vn"  -> If[ArrayQ[vn, 2, NumericQ], wb3dPoolPut[N@vn, 1.*^-4], None],
    "vc"  -> If[ListQ[vc] && !MatchQ[vc, None | Automatic],
                wb3dPoolPut[N@Map[Replace[wb3dToRGB[#], $Failed -> {0., 0., 0.}] &, vc]], None]|>];
  wb3dWalk[prims, st2]];

wb3dWalk[Annotation[a_, ___], st_]    := wb3dWalk[a, st];
wb3dWalk[GraphicsGroup[a_, ___], st_] := wb3dWalk[a, st];
wb3dWalk[Tooltip[a_, ___], st_]       := wb3dWalk[a, st];
wb3dWalk[StatusArea[a_, ___], st_]    := wb3dWalk[a, st];
wb3dWalk[Style[a_, s___], st_]        := wb3dWalk[a, Fold[wb3dStep, st, {s}]];
wb3dWalk[Rotate[a_, ___], st_]        := wb3dWalk[a, st];   (* v1: transform ignored *)
wb3dWalk[Translate[a_, ___], st_]     := wb3dWalk[a, st];

wb3dWalk[Polygon[spec_, ___], st_] := Module[{rows, tris, flat, idx, ed, eidx, base, irows},
  Which[
    wb3dIntArrayQ[spec] && st["pts"] =!= None,
      rows = wb3dAsRows[spec];
      tris = Flatten[wb3dFanRow /@ rows] - 1;
      (* An INDEXED polygon is a tessellated surface (Plot3D, ContourPlot3D,
         DiscretizeRegion, …), never a shape the user drew: it defaults to NO
         edges, so a plot cannot come back wearing its own triangulation.
         An explicit EdgeForm — which is how `Mesh -> All` arrives — turns them
         on, and then every polygon boundary is drawn, not just the sharp ones. *)
      ed = Replace[st["edge"], Automatic :> None];
      eidx = If[ed === None, Null, Replace[wb3dBoundarySegs[rows], l_List :> l - 1]];
      wb3dEmit[<|"type" -> "mesh", "posPool" -> st["pts"],
                 "normPool" -> wb3dNull[st["vn"]], "colPool" -> wb3dNull[st["vc"]],
                 "index" -> tris, "edgeIndex" -> wb3dNull[eidx],
                 "mat" -> wb3dMatE[st, None]|>],
    wb3dRealArrayQ[spec],
      rows = If[ArrayDepth[spec] == 2, {spec}, spec];
      flat = {}; idx = {}; irows = {}; base = 0;
      Do[flat = Join[flat, r];
         idx = Join[idx, Flatten[wb3dFanRow[Range[Length[r]]]] + base - 1];
         AppendTo[irows, Range[Length[r]] + base];
         base += Length[r], {r, rows}];
      ed = Replace[st["edge"], Automatic :> $wb3dEdgeDefault];
      eidx = If[ed === None, Null, Replace[wb3dBoundarySegs[irows], l_List :> l - 1]];
      wb3dEmit[<|"type" -> "mesh", "posPool" -> wb3dPoolPut[N@flat],
                 "normPool" -> Null, "colPool" -> Null,
                 "index" -> idx, "edgeIndex" -> wb3dNull[eidx],
                 "mat" -> wb3dMatE[st, $wb3dEdgeDefault]|>],
    True, Null]];

wb3dWalk[Line[spec_, ___], st_] := Module[{rows, segs, flat, idx, base},
  Which[
    wb3dIntArrayQ[spec] && st["pts"] =!= None,
      rows = wb3dAsRows[spec];
      segs = Flatten[wb3dSegRow /@ rows] - 1;
      wb3dEmit[<|"type" -> "lines", "posPool" -> st["pts"], "index" -> segs,
                 "mat" -> wb3dMat[st], "thickness" -> st["thickness"]|>],
    wb3dRealArrayQ[spec],
      rows = If[ArrayDepth[spec] == 2, {spec}, spec];
      flat = {}; idx = {}; base = 0;
      Do[flat = Join[flat, r];
         idx = Join[idx, Flatten[wb3dSegRow[Range[Length[r]]]] + base - 1];
         base += Length[r], {r, rows}];
      wb3dEmit[<|"type" -> "lines", "posPool" -> wb3dPoolPut[N@flat], "index" -> idx,
                 "mat" -> wb3dMat[st], "thickness" -> st["thickness"]|>],
    True, Null]];

wb3dWalk[Point[spec_, ___], st_] :=
  Which[
    wb3dIntArrayQ[spec] && st["pts"] =!= None,
      wb3dEmit[<|"type" -> "points", "posPool" -> st["pts"],
                 "index" -> Flatten[{spec}] - 1, "mat" -> wb3dMat[st],
                 "size" -> st["pointSize"]|>],
    wb3dRealArrayQ[spec],
      wb3dEmit[<|"type" -> "points",
                 "posPool" -> wb3dPoolPut[N@If[ArrayDepth[spec] == 1, {spec}, spec]],
                 "index" -> Null, "mat" -> wb3dMat[st], "size" -> st["pointSize"]|>],
    True, Null];

(* parametric solids: rebuilt client-side by three.js, so the payload is tiny.
   All of them default to edges ON — the viewer's dihedral-angle rule is what
   decides that a sphere ends up with none and a cylinder with just its rims. *)
wb3dWalk[Sphere[c_: {0, 0, 0}, r_: 1], st_] :=
  Module[{cs = If[ArrayDepth[N@c] == 2, N@c, {N@c}]},
    Do[wb3dEmit[<|"type" -> "sphere", "c" -> ci, "r" -> N@r,
                  "mat" -> wb3dMatE[st, $wb3dEdgeDefault]|>], {ci, cs}]];

wb3dWalk[Cuboid[a_: {0, 0, 0}], st_] :=
  wb3dEmit[<|"type" -> "cuboid", "a" -> N@a, "b" -> N@a + 1,
             "mat" -> wb3dMatE[st, $wb3dEdgeDefault]|>];
wb3dWalk[Cuboid[a_, b_], st_] :=
  wb3dEmit[<|"type" -> "cuboid", "a" -> N@a, "b" -> N@b,
             "mat" -> wb3dMatE[st, $wb3dEdgeDefault]|>];

wb3dWalk[Cylinder[{a_, b_}, r_: 1], st_] :=
  wb3dEmit[<|"type" -> "cylinder", "a" -> N@a, "b" -> N@b, "r" -> N@r,
             "mat" -> wb3dMatE[st, $wb3dEdgeDefault]|>];
wb3dWalk[Cylinder[pts_ /; ArrayDepth[pts] == 3, r_: 1], st_] :=
  Do[wb3dEmit[<|"type" -> "cylinder", "a" -> N@p[[1]], "b" -> N@p[[2]], "r" -> N@r,
                "mat" -> wb3dMatE[st, $wb3dEdgeDefault]|>], {p, pts}];

wb3dWalk[Tube[spec_, r_: 0.02], st_] := Module[{rows},
  If[wb3dIntArrayQ[spec] && st["pts"] =!= None,
    wb3dEmit[<|"type" -> "tube", "posPool" -> st["pts"], "index" -> Flatten[{spec}] - 1,
               "r" -> N@r, "mat" -> wb3dMatE[st, None]|>],
    If[wb3dRealArrayQ[spec],
      rows = If[ArrayDepth[spec] == 2, {spec}, spec];
      Do[wb3dEmit[<|"type" -> "tube", "posPool" -> wb3dPoolPut[N@row], "index" -> Null,
                    "r" -> N@r, "mat" -> wb3dMatE[st, None]|>], {row, rows}]]]];

(* anything unmodelled is skipped in silence — the PNG stays ground truth *)
wb3dWalk[_, _] := Null;

(* ---------- scene metadata ---------- *)

wb3dAbsOpt[g_, o_] := Quiet@Check[o /. AbsoluteOptions[g, o], Automatic];

wb3dLightingSpec[] := Module[{l = $wb3dLighting},
  If[!ListQ[l], Return[Null]];
  DeleteCases[
    Function[item,
      Which[
        MatchQ[item, {"Ambient", _}],
          <|"type" -> "ambient",
            "color" -> Replace[wb3dToRGB[item[[2]]], $Failed -> {0.3, 0.3, 0.3}]|>,
        MatchQ[item, {"Directional" | "Point", _, _}],
          <|"type" -> ToLowerCase[item[[1]]],
            "color" -> Replace[wb3dToRGB[item[[2]]], $Failed -> {0.3, 0.3, 0.3}],
            "pos" -> N@Flatten[{item[[3]] /. ImageScaled -> Identity}],
            "scaled" -> MatchQ[item[[3]], _ImageScaled]|>,
        True, Null]] /@ l,
    Null]];

(* Ticks come straight from the kernel, so the numbers on the axes are exactly
   the ones Mathematica chose: {value, label, {majorLen, minorLen}} per entry,
   with "" as the label on minor ticks. *)
wb3dTickLabel[l_] := Which[StringQ[l], l, NumericQ[l], ToString[l], True, ""];

wb3dTicks[g_] := Module[{t},
  t = wb3dAbsOpt[g, Ticks];
  If[!MatchQ[t, {_List, _List, _List}], Return[Null]];
  Map[Function[axis, Module[{maj = {}, min = {}, lb},
      Do[Which[
          MatchQ[e, {_?NumericQ, _, ___}],
            lb = wb3dTickLabel[e[[2]]];
            If[lb === "", AppendTo[min, N@e[[1]]], AppendTo[maj, {N@e[[1]], lb}]],
          NumericQ[e],
            AppendTo[maj, {N[e], ToString[e]}]],
        {e, axis}];
      <|"major" -> maj, "minor" -> min|>]],
    t]];

(* AbsoluteOptions returns axis labels as typeset boxes
   (FormBox[TagBox["x", HoldForm], TraditionalForm]); peel them back to text. *)
wb3dLabelText[x_] := Module[{r},
  r = x //. {FormBox[a_, ___] :> a, TagBox[a_, ___] :> a, StyleBox[a_, ___] :> a,
             InterpretationBox[a_, ___] :> a, HoldForm[a_] :> a,
             RowBox[l_List] :> StringJoin[Select[l, StringQ]]};
  (* a string label's BOX form carries the quote marks: "x" -> "\"x\"" *)
  If[StringQ[r] && StringLength[r] >= 2 &&
     StringStartsQ[r, "\""] && StringEndsQ[r, "\""],
     r = StringTake[r, {2, -2}]];
  Which[StringQ[r], r,
        MatchQ[r, None | Automatic | Null], Null,
        True, Quiet@Check[ToString[r], Null]]];

wb3dAxesLabels[g_] := Module[{al},
  al = wb3dAbsOpt[g, AxesLabel];
  If[!ListQ[al], Return[Null]];
  wb3dLabelText /@ PadRight[al, 3, None]];

wb3dMeta[g_] := Module[{br, pr, vp, vv, ax, lt},
  br = wb3dAbsOpt[g, BoxRatios]; pr = wb3dAbsOpt[g, PlotRange];
  vp = wb3dAbsOpt[g, ViewPoint];  vv = wb3dAbsOpt[g, ViewVertical];
  ax = wb3dAbsOpt[g, Axes];
  (* A Lighting directive scoped to the surface wins; otherwise ask the kernel
     what the resolved default is, rather than inventing a rig. *)
  lt = wb3dLightingSpec[];
  If[lt === Null,
     $wb3dLighting = wb3dAbsOpt[g, Lighting]; lt = wb3dLightingSpec[]];
  <|
    "boxRatios" -> If[ArrayQ[br, 1, NumericQ], N@br, {1., 1., 0.4}],
    "plotRange" -> If[ArrayQ[pr, 2, NumericQ], N@pr, Null],
    "viewPoint" -> If[ArrayQ[vp, 1, NumericQ], N@vp, {1.3, -2.4, 2.}],
    "viewVertical" -> If[ArrayQ[vv, 1, NumericQ], N@vv, {0., 0., 1.}],
    "boxed" -> TrueQ[wb3dAbsOpt[g, Boxed]],
    "axes" -> Replace[ax, {True -> True, l_List :> TrueQ[Or @@ l], _ -> False}],
    "ticks" -> wb3dTicks[g],
    "axesLabels" -> wb3dAxesLabels[g],
    "lighting" -> lt
  |>];

(* ---------- entry point ---------- *)

$wb3dLastStats = <||>;
wb3dStats[] := $wb3dLastStats;

(* Finding the Graphics3D is deceptively expensive. FirstCase[expr, _Graphics3D,
   ..., {0, Infinity}] visits level 0 LAST, so for a plot it walks every vertex
   and index in the scene before matching the whole expression — that alone was
   1.15 s of a 1.2 s export. Check the head, then widen a level at a time, and
   only fall back to a full traversal for deeply buried graphics. *)
wb3dFindG3D[expr_] := Module[{r},
  If[Head[expr] === Graphics3D, Return[expr]];
  Do[r = FirstCase[expr, _Graphics3D, $Failed, {lvl}];
     If[Head[r] === Graphics3D, Return[r]], {lvl, 1, 4}];
  FirstCase[expr, _Graphics3D, $Failed, Infinity]];

(* Warm the graphics option-resolution machinery. The FIRST AbsoluteOptions call
   of a session costs ~0.75 s to initialise; afterwards it is ~7 ms. Called at
   kernel start so no user-visible export ever pays it. *)
wb3dWarmup[] := Quiet@Check[
  AbsoluteOptions[Graphics3D[{Point[{0., 0., 0.}]}],
    {PlotRange, Ticks, BoxRatios, ViewPoint, ViewVertical, Lighting, Axes,
     AxesLabel, Boxed}], $Failed];

(* Write the mesh for expr next to its PNG and return the <img> attributes that
   point at it, or "" when there is nothing to attach. Shared by the WL3D format
   and the ordinary image path, so a static 3D output is drag-activatable too. *)
wb3dMeshAttrs[expr_] := Module[{json, fname, fpath},
  If[$wolframImgDir === "" || StringLength[$wolframImgDir] == 0, Return[""]];
  json = Quiet[CheckAbort[TimeConstrained[wb3dMeshJSON[expr], 30, $Failed], $Failed]];
  If[!StringQ[json], Return[""]];
  fname = "wl3d_" <> IntegerString[Hash[json], 36] <> ".json";
  fpath = FileNameJoin[{$wolframImgDir, fname}];
  If[!FileExistsQ[fpath], Quiet[Export[fpath, json, "String"]]];
  If[FileExistsQ[fpath],
     " data-wl-mesh=\"" <> fpath <> "\" data-wl-mesh-src=\"" <>
       $wolframImgRelPrefix <> "/" <> fname <> "\"",
     ""]];

wb3dMeshJSON[expr_] := Module[{g3d, json, data, bad, t0 = AbsoluteTime[]},
  g3d = wb3dFindG3D[expr];
  If[Head[g3d] =!= Graphics3D, Return[$Failed]];
  $wb3dPools = <||>; $wb3dPoolIdx = <||>; $wb3dObjs = {};
  $wb3dFloats = 0; $wb3dLighting = None;
  Catch[
    wb3dWalk[First[g3d], $wb3dInit];
    If[$wb3dObjs === {}, Throw[$Failed, "wb3d"]];
    (* NB: do NOT sweep this structure with ReplaceAll or Cases — it holds every
       vertex and index in the scene, so any full-depth traversal here costs far
       more than building it (it was 1.3 s of a 1.3 s export). None is converted
       to Null at the emit sites instead, and the leaf audit below runs only on
       the rare failure path. *)
    data = <|"v" -> 1, "meta" -> wb3dMeta[g3d],
             "pools" -> $wb3dPools, "objects" -> $wb3dObjs|>;
    json = Quiet@Check[ExportString[data, "JSON", "Compact" -> True], $Failed];
    If[!StringQ[json],
      bad = DeleteDuplicates@
        Cases[data, s_Symbol /; !MemberQ[{True, False, Null}, s] :> SymbolName[s], {-1}];
      $wb3dLastStats = <|"failed" -> True, "reason" -> "json-export",
                         "badLeaves" -> bad, "objects" -> Length[$wb3dObjs],
                         "seconds" -> AbsoluteTime[] - t0|>;
      Throw[$Failed, "wb3d"]];
    $wb3dLastStats = <|"objects" -> Length[$wb3dObjs], "pools" -> Length[$wb3dPools],
                       "floats" -> $wb3dFloats, "bytes" -> StringLength[json],
                       "seconds" -> AbsoluteTime[] - t0|>;
    json,
    "wb3d",
    (($wb3dLastStats = <|"failed" -> True, "floats" -> $wb3dFloats,
                         "objects" -> Length[$wb3dObjs],
                         "seconds" -> AbsoluteTime[] - t0|>); $Failed) &]];
