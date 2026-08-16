(* Wolfbook: 2D plot -> curve JSON for the hover coordinate callout.

   Loaded by init.wl into Wolfbook`Private`, after wb3d.wl (whose wb3dToRGB and
   wb3dAbsOpt are reused here) and before render-expr.wl, which calls
   wb2dPlotAttrs from both the SVG and the PNG-fallback branch.

   HARD RULE (same as wb3d.wl): everything here stays IN-KERNEL. No Rasterize,
   no ExportString[g, "SVG"], no typesetting — those block in a C-level IPC wait
   on the front end that TimeConstrained cannot interrupt. AbsoluteOptions,
   Cases and ExportString[..., "JSON"] are safe.

   What this extracts: Mathematica's own hover machinery is already in the
   expression. Plot wraps each curve in
     Annotation[prims, meta, "DynamicHighlight"]
   where meta declares "HighlightElements" (XYLabel + InterpolatedBall) and
   carries PlotRange / ScalingFunctions. The front end interprets that at
   ToBoxes time; exporting to SVG or PNG throws it away. So we read the sampled
   polyline out of prims and hand it to the webview, which redraws the callout.

   Entry point: wb2dPlotAttrs[expr] -> " data-wl-plot=... data-wl-plot-src=..."
   or "" when the plot cannot be modelled. EVERY failure path returns "" — the
   static image is always ground truth and must never be affected.
*)

$wb2dPointCap = 50000;   (* total sampled points emitted before giving up *)

(* ---------- geometry ---------- *)

wb2dPtArrayQ[a_] := ArrayQ[a, 2, NumericQ] && Last[Dimensions[a]] === 2;

(* Line[pts] is either one {{x,y}..} run or, when the plot has exclusions or
   discontinuities, a list of such runs with DIFFERENT lengths — ragged, so
   ArrayQ[_, 3] does not see it.  Point[{x,y}] is a single bare coordinate. *)
wb2dSegs[pts_] := Which[
  wb2dPtArrayQ[pts],                        {N@pts},
  ArrayQ[pts, 1, NumericQ] && Length[pts] === 2, {{N@pts}},
  ListQ[pts],                               Select[N /@ pts, wb2dPtArrayQ],
  True,                                     {}];

(* Trim float noise to ~6 significant digits, per axis: x and y routinely live
   on different scales, so wb3dRoundArr's single shared span would quantise the
   small axis into steps. *)
wb2dRoundSegs[segs_, rel_: 1.*^-6] := Module[{all, sx, sy, q},
  all = Join @@ segs;
  If[all === {}, Return[segs]];
  q[col_] := Module[{s = Max[Abs[MinMax[col]]]},
    If[NumericQ[s] && s > 0, Round[col, N[s] * rel], col]];
  sx = q[all[[All, 1]]]; sy = q[all[[All, 2]]];
  Map[Function[seg, Transpose[{q[seg[[All, 1]]], q[seg[[All, 2]]]}]], segs]];

(* ---------- per-curve metadata ---------- *)

(* Log/scaled plots: the geometry would still map (the polyline is already in
   scaled space) but the LABEL needs the inverse transform, so v1 declines the
   whole plot rather than reporting wrong coordinates.
   Verified shapes: linear -> {{Identity,Identity},{Identity,Identity}},
   LogPlot -> {{Identity,Identity},{Log,Exp}}. *)
wb2dLinearScalingQ[meta_] := Module[{lo, hlf, sf},
  lo = Lookup[meta, "LayoutOptions", <||>];
  If[!AssociationQ[lo], Return[True]];
  hlf = Lookup[lo, "HighlightLabelingFunctions", <||>];
  If[!AssociationQ[hlf], Return[True]];
  sf = Lookup[hlf, "ScalingFunctions", Missing["NotFound"]];
  If[MissingQ[sf], Return[True]];
  FreeQ[sf, Log | Log2 | Log10 | Exp | Power | Reverse |
            "Log" | "Log2" | "Log10" | "Reverse" | "Infinite"]];

$wb2dColorPat = _RGBColor | _GrayLevel | _Hue | _CMYKColor | _XYZColor | _LABColor;

wb2dColor[prims_, meta_] := Module[{c},
  c = FirstCase[prims, $wb2dColorPat, $Failed, {0, 5}];
  If[c === $Failed,
     c = FirstCase[Lookup[Lookup[meta, "LayoutOptions", <||>], "DefaultStyle", {}],
                   $wb2dColorPat, $Failed, {0, 4}]];
  If[c === $Failed, {0.24, 0.6, 0.8},
     Replace[wb3dToRGB[c], $Failed -> {0.24, 0.6, 0.8}]]];

(* ---------- the extractor ---------- *)

(* Plot[{f, g}, ...] emits ONE "DynamicHighlight" annotation holding both curves,
   each wrapped in its own inner Annotation[prims, "Charting`Private`Tag#N"] with
   its own colour directive.  Splitting on those keeps per-curve colours; a style
   that has no inner tags falls back to the block as a single curve. *)
wb2dGroups[prims_] := Module[{g},
  g = Cases[prims, Annotation[p_, _String] :> p, {0, 6}];
  If[g === {}, {prims}, g]];

(* Cases does not descend into what it has already matched, so the vertex arrays
   inside an Annotation are visited exactly once.  The level bound matters for
   the same reason FirstCase[..., {0, Infinity}] is banned in wb3d.wl. *)
wb2dCurves[g_] := Module[{anns, curves = {}, total = 0, scaled = False},
  If[ByteCount[g] > 32*10^6, Return[$Failed]];
  anns = Cases[First[g],
    Annotation[p_, m_?AssociationQ, "DynamicHighlight"] :> {p, m}, {0, 8}];
  If[anns === {}, Return[$Failed]];
  Do[
    If[!wb2dLinearScalingQ[a[[2]]], scaled = True; Break[]];
    Do[
      Module[{col = wb2dColor[grp, a[[2]]], segs},
        segs = Join @@ (wb2dSegs /@ Cases[grp, Line[pts_] :> pts, {0, 5}]);
        If[segs =!= {},
           total += Total[Length /@ segs];
           AppendTo[curves, <|"kind" -> "line", "color" -> col,
                              "segs" -> wb2dRoundSegs[segs]|>]];
        segs = Join @@ (wb2dSegs /@ Cases[grp, Point[pts_] :> pts, {0, 5}]);
        If[segs =!= {},
           total += Total[Length /@ segs];
           AppendTo[curves, <|"kind" -> "points", "color" -> col,
                              "segs" -> wb2dRoundSegs[segs]|>]]],
      {grp, wb2dGroups[a[[1]]]}],
    {a, anns}];
  If[scaled || curves === {} || total == 0 || total > $wb2dPointCap,
     $Failed, curves]];

(* Legended[...] is deliberately NOT accepted: the exported image includes the
   legend, so the inner Graphics' ImageSize/ImagePadding no longer describe the
   picture and every mapped coordinate would be offset. *)
wb2dPlotJSON[expr_] := Module[{g = expr, curves, pr, prp, frame, pad, isz, data},
  If[Head[g] =!= Graphics, Return[$Failed]];
  curves = wb2dCurves[g];
  If[!ListQ[curves] || curves === {}, Return[$Failed]];
  pr  = wb3dAbsOpt[g, PlotRange];
  prp = wb3dAbsOpt[g, PlotRangePadding];
  pad = wb3dAbsOpt[g, ImagePadding];
  isz = wb3dAbsOpt[g, ImageSize];
  If[!ArrayQ[pr,  2, NumericQ] || Dimensions[pr]  =!= {2, 2}, Return[$Failed]];
  If[!ArrayQ[prp, 2, NumericQ] || Dimensions[prp] =!= {2, 2}, Return[$Failed]];
  If[!ArrayQ[pad, 2, NumericQ] || Dimensions[pad] =!= {2, 2}, Return[$Failed]];
  If[!ArrayQ[isz, 1, NumericQ] || Length[isz] =!= 2,          Return[$Failed]];
  (* a degenerate range or size makes the affine map non-invertible *)
  If[!(isz[[1]] > 0 && isz[[2]] > 0),                         Return[$Failed]];
  If[pr[[1, 2]] - pr[[1, 1]] == 0 || pr[[2, 2]] - pr[[2, 1]] == 0, Return[$Failed]];
  (* PlotRange is NOT what fills the plot area: PlotRangePadding widens it, and
     it is that widened frame the picture is drawn into.  Measured against the
     exported SVG of Plot[Sin[x],{x,0,2}], the data occupies the middle 96% of
     the area horizontally and 90% vertically — ignoring this put the ball a
     visible ~5% off the curve.  AbsoluteOptions reports the padding already
     resolved to data units, so the frame is just PlotRange widened by it. *)
  frame = {{pr[[1, 1]] - prp[[1, 1]], pr[[1, 2]] + prp[[1, 2]]},
           {pr[[2, 1]] - prp[[2, 1]], pr[[2, 2]] + prp[[2, 2]]}};
  If[frame[[1, 2]] - frame[[1, 1]] == 0 || frame[[2, 2]] - frame[[2, 1]] == 0,
     Return[$Failed]];
  data = <|"v" -> 1, "plotRange" -> N@pr, "frameRange" -> N@frame,
           "imageSize" -> N@isz, "imagePadding" -> N@pad, "curves" -> curves|>;
  Quiet@Check[ExportString[data, "JSON", "Compact" -> True], $Failed]];

(* Warm the graphics option-resolution machinery: the FIRST AbsoluteOptions call
   of a session costs ~0.75 s, ~7 ms after.  Called at kernel start (lifecycle.js)
   so no user-visible export ever pays it. *)
wb2dWarmup[] := Quiet@Check[
  AbsoluteOptions[Graphics[{Line[{{0., 0.}, {1., 1.}}]}],
    {PlotRange, ImagePadding, ImageSize, AspectRatio}], $Failed];

(* Write the curve data for expr next to its SVG/PNG and return the <img>
   attributes pointing at it.  data-wl-plot is absolute (cleanupImgDir scans it
   for liveness); data-wl-plot-src is relative, and is what the webview fetches.
   Content-hashed, so re-evaluating the same plot rewrites nothing. *)
wb2dPlotAttrs[expr_] := Module[{json, fname, fpath},
  If[$wolframImgDir === "" || StringLength[$wolframImgDir] == 0, Return[""]];
  json = Quiet[CheckAbort[TimeConstrained[wb2dPlotJSON[expr], 5, $Failed], $Failed]];
  If[!StringQ[json], Return[""]];
  fname = "wl2d_" <> IntegerString[Hash[json], 36] <> ".json";
  fpath = FileNameJoin[{$wolframImgDir, fname}];
  If[!FileExistsQ[fpath], Quiet[Export[fpath, json, "String"]]];
  If[FileExistsQ[fpath],
     " data-wl-plot=\"" <> fpath <> "\" data-wl-plot-src=\"" <>
       $wolframImgRelPrefix <> "/" <> fname <> "\"",
     ""]];
