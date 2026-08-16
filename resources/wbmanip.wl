(* Wolfbook: Manipulate -> real HTML sliders backed by the kernel.

   Loaded by init.wl into Wolfbook`Private`; every symbol carries a wbManip
   prefix. VsCodeManipUpdate is Global` (declared in init.wl) because the
   extension calls it by name over WSTP.

   Manipulate is HoldAll and, with no front end, evaluates to itself — so the
   body and each control spec can be lifted out with Extract[..., Hold] without
   ever evaluating the control variable. That is the whole trick: we never let
   the kernel try to build a DynamicModule (which needs a front end and renders
   as box soup), we read the specification and drive it ourselves.

   v1 handles slider controls only:
       {u, min, max}            {u, min, max, step}
       {{u, init}, min, max}    {{u, init}, min, max, step}
       {{u, init, label}, ...}
   Anything else -> $Failed, and the caller falls back to the old rendering.
*)

$wbManipRegistry = <||>;
$wbManipOrder    = {};      (* ids, oldest first — bounded so a long session
                               cannot pin every Manipulate body in memory *)
$wbManipCounter  = 0;
$wbManipMax      = 64;

(* ---------- helpers that must not evaluate the control variable ---------- *)

wbManipName[Hold[s_Symbol]] := SymbolName[Unevaluated[s]];
wbManipName[_] := $Failed;

(* symbol -> value, with the symbol shielded from evaluation *)
wbManipRule[Hold[s_Symbol], v_] := HoldPattern[s] :> v;

wbManipLabelText[l_] := Which[
  StringQ[l], l,
  MatchQ[l, None | Automatic | Null], Null,
  True, Quiet@Check[ToString[l], Null]];

(* ---------- spec parsing ---------- *)
(* Takes ONE held control spec, returns an association or $Failed. Numeric
   bounds are evaluated (2 Pi is fine); the control symbol never is. *)

wbManipSpec[h_Hold] := Module[{res = $Failed},
  Replace[h, {
    Hold[{u_Symbol, mn_, mx_}] /; NumericQ[mn] && NumericQ[mx] :>
      (res = <|"hold" -> Hold[u], "min" -> N[mn], "max" -> N[mx],
               "step" -> Automatic, "init" -> N[mn], "label" -> Null|>),
    Hold[{u_Symbol, mn_, mx_, st_}] /; NumericQ[mn] && NumericQ[mx] && NumericQ[st] :>
      (res = <|"hold" -> Hold[u], "min" -> N[mn], "max" -> N[mx],
               "step" -> N[st], "init" -> N[mn], "label" -> Null|>),
    Hold[{{u_Symbol, in_}, mn_, mx_}] /; NumericQ[mn] && NumericQ[mx] && NumericQ[in] :>
      (res = <|"hold" -> Hold[u], "min" -> N[mn], "max" -> N[mx],
               "step" -> Automatic, "init" -> N[in], "label" -> Null|>),
    Hold[{{u_Symbol, in_}, mn_, mx_, st_}] /; NumericQ[mn] && NumericQ[mx] && NumericQ[in] && NumericQ[st] :>
      (res = <|"hold" -> Hold[u], "min" -> N[mn], "max" -> N[mx],
               "step" -> N[st], "init" -> N[in], "label" -> Null|>),
    Hold[{{u_Symbol, in_, lb_}, mn_, mx_}] /; NumericQ[mn] && NumericQ[mx] && NumericQ[in] :>
      (res = <|"hold" -> Hold[u], "min" -> N[mn], "max" -> N[mx],
               "step" -> Automatic, "init" -> N[in], "label" -> wbManipLabelText[lb]|>),
    Hold[{{u_Symbol, in_, lb_}, mn_, mx_, st_}] /; NumericQ[mn] && NumericQ[mx] && NumericQ[in] && NumericQ[st] :>
      (res = <|"hold" -> Hold[u], "min" -> N[mn], "max" -> N[mx],
               "step" -> N[st], "init" -> N[in], "label" -> wbManipLabelText[lb]|>),
    _ :> (res = $Failed)
  }];
  If[!AssociationQ[res], Return[$Failed]];
  res["name"] = wbManipName[res["hold"]];
  If[!StringQ[res["name"]], Return[$Failed]];
  (* a slider with no explicit step gets ~100 stops, like Manipulate's own *)
  If[res["step"] === Automatic,
     res["step"] = If[res["max"] > res["min"], N[(res["max"] - res["min"])/100], 0.01]];
  If[!(NumericQ[res["step"]] && res["step"] > 0), res["step"] = 0.01];
  res];

(* ---------- binding + rendering ---------- *)

wbManipBind[held_Hold, specs_List, current_Association] :=
  ReleaseHold[held /. (wbManipRule[#["hold"], Lookup[current, #["name"], #["init"]]] & /@ specs)];

(* Render the CURRENT body of a registered Manipulate to output HTML. *)
wbManipRenderBody[id_String, scale_] := Module[{r, val},
  r = $wbManipRegistry[id];
  If[!AssociationQ[r], Return[""]];
  val = Quiet@Check[wbManipBind[r["body"], r["specs"], r["current"]], $Failed];
  If[val === $Failed,
     "<pre class=\"vscode-wolfram-text-output\">Manipulate body failed to evaluate.</pre>",
     VsCodeRenderExpr[val, "Auto", scale]]];

(* ---------- HTML ---------- *)

(* Format a number for an HTML attribute.

   ToString[N[-2], InputForm] gives "-2." — Wolfram's own notation, but NOT a
   valid HTML floating-point number, which requires digits after the decimal
   point. A browser silently DISCARDS an invalid min/max/value and falls back to
   its default 0..100 range, so every slider silently lost its real bounds.
   Integers print bare; everything else prints positionally (never 1.*^-9). *)
wbManipNum[x_] := Module[{v, s},
  v = Quiet@Check[N[x], $Failed];
  If[!NumericQ[v], Return["0"]];
  v = N[v];
  If[Abs[v] < 1.*^15 && v == Round[v], Return[ToString[Round[v]]]];
  s = StringTrim[ToString[DecimalForm[v, {17, 10}]]];
  If[StringContainsQ[s, "."],
     s = StringReplace[s, RegularExpression["0+$"] -> ""];
     If[StringEndsQ[s, "."], s = s <> "0"]];
  If[StringMatchQ[s, RegularExpression["-?[0-9]+(\\.[0-9]+)?"]],
     s,
     ToString[Round[v]]]];

wbManipControlHTML[id_String, sp_Association] := Module[{lbl, name},
  name = sp["name"];
  lbl = If[StringQ[sp["label"]], sp["label"], name];
  StringJoin[
    "<div class=\"wl-manip-row\" style=\"display:flex;align-items:center;gap:8px;margin:2px 0;\">",
      "<span class=\"wl-manip-label\" style=\"min-width:3.5em;text-align:right;",
        "font-size:12px;opacity:0.85;\">", lbl, "</span>",
      "<input type=\"range\" class=\"wl-manip-slider\"",
        " data-manip-id=\"", id, "\" data-var=\"", name, "\"",
        " min=\"", wbManipNum[sp["min"]], "\"",
        " max=\"", wbManipNum[sp["max"]], "\"",
        " step=\"", wbManipNum[sp["step"]], "\"",
        " value=\"", wbManipNum[sp["init"]], "\"",
        " style=\"flex:0 1 180px;\"/>",
      "<span class=\"wl-manip-value\" data-manip-id=\"", id, "\" data-var=\"", name, "\"",
        " style=\"min-width:4em;font-size:12px;font-family:var(--vscode-editor-font-family,monospace);",
        "opacity:0.85;\">", wbManipNum[sp["init"]], "</span>",
    "</div>"]];

(* ---------- registry ---------- *)

wbManipTrim[] := Module[{drop},
  While[Length[$wbManipOrder] > $wbManipMax,
    drop = First[$wbManipOrder];
    $wbManipOrder = Rest[$wbManipOrder];
    $wbManipRegistry = KeyDrop[$wbManipRegistry, drop]]];

(* ---------- entry point ---------- *)
(* Returns the full HTML block, or $Failed to let the caller render normally. *)

wbManipIntercept[m_, scale_] := Module[{n, specs = {}, sp, k, id, body, inner},
  If[Head[m] =!= Manipulate, Return[$Failed]];
  n = Length[m];
  If[n < 2, Return[$Failed]];
  body = Extract[m, {1}, Hold];
  Do[
    sp = Extract[m, {k}, Hold];
    (* trailing options are not controls; ignore them *)
    If[MatchQ[sp, Hold[_Rule] | Hold[_RuleDelayed]], Continue[]];
    sp = wbManipSpec[sp];
    If[sp === $Failed, Return[$Failed, Module]];   (* unsupported control *)
    AppendTo[specs, sp],
    {k, 2, n}];
  If[specs === {}, Return[$Failed]];

  $wbManipCounter++;
  id = "m" <> IntegerString[Hash[{Hash[m], $wbManipCounter}], 36];
  $wbManipRegistry[id] = <|
    "body" -> body, "specs" -> specs,
    "current" -> Association[(#["name"] -> #["init"]) & /@ specs]|>;
  $wbManipOrder = Append[$wbManipOrder, id];
  wbManipTrim[];

  inner = wbManipRenderBody[id, scale];
  StringJoin[
    "<div class=\"wl-manip\" data-manip-id=\"", id, "\">",
      "<div class=\"wl-manip-controls\" data-manip-id=\"", id, "\"",
        " style=\"display:inline-block;padding:2px 0 6px 0;\">",
        StringJoin[wbManipControlHTML[id, #] & /@ specs],
      "</div>",
      "<div class=\"wl-manip-result\" data-manip-id=\"", id, "\">", inner, "</div>",
    "</div>"]];

(* ---------- update, called from the renderer via the extension ---------- *)
(* sets is an Association of name -> numeric value. *)

VsCodeManipUpdate[id_String, sets_Association, scale_?NumericQ] :=
  Module[{r},
    r = $wbManipRegistry[id];
    If[!AssociationQ[r],
      Return["<pre class=\"vscode-wolfram-text-output\">This Manipulate is no longer live \
(the kernel restarted) \[LongDash] re-evaluate the cell.</pre>"]];
    $wbManipRegistry[id, "current"] =
      Join[r["current"], KeySelect[sets, StringQ]];
    Quiet@Check[
      TimeConstrained[wbManipRenderBody[id, scale], 30,
        "<pre class=\"vscode-wolfram-text-output\">Manipulate update timed out.</pre>"],
      "<pre class=\"vscode-wolfram-text-output\">Manipulate update failed.</pre>"]];

VsCodeManipUpdate[___] :=
  "<pre class=\"vscode-wolfram-text-output\">Bad Manipulate update request.</pre>";
