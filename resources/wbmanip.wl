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
wbManipRenderBody[id_String, scale_, requestedFormat_: Automatic] := Module[{r, val, fmt},
  r = $wbManipRegistry[id];
  If[!AssociationQ[r], Return[""]];
  (* A Manipulate body may be re-rendered in a user-selected format (notably
     WL3D).  Keep that choice in the registry so a later slider tick does not
     silently fall back to the notebook's Auto/SVG default. *)
  fmt = If[StringQ[requestedFormat], requestedFormat, Lookup[r, "format", "Auto"]];
  val = Quiet@Check[wbManipBind[r["body"], r["specs"], r["current"]], $Failed];
  If[val === $Failed,
     "<pre class=\"vscode-wolfram-text-output\">Manipulate body failed to evaluate.</pre>",
     VsCodeRenderExpr[val, fmt, scale]]];

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

(* Parse one Manipulate into {body, specs}, or $Failed for anything we do not
   model.  Shared by the first render and by the revive path below, so the two
   can never disagree about which controls are supported. *)
wbManipParse[m_] := Module[{n, specs = {}, sp, k, body},
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
  {body, specs}];

(* Store a parsed Manipulate under `id`, keeping any slider positions the caller
   already knows about (the revive path passes the reader's current values). *)
wbManipRegister[id_String, body_Hold, specs_List, fmt_String, current_Association] :=
  ($wbManipRegistry[id] = <|
     "body" -> body, "specs" -> specs, "format" -> fmt,
     "current" -> Join[Association[(#["name"] -> #["init"]) & /@ specs],
                       KeySelect[current, StringQ]]|>;
   $wbManipOrder = Append[DeleteCases[$wbManipOrder, id], id];
   wbManipTrim[];
   id);

(* The Manipulate's own source, base64'd onto the HTML.  This is what lets a
   saved notebook — or one whose kernel has since restarted — put its sliders
   back to work without the reader re-evaluating the cell by hand. *)
(* No Hold attribute is needed: Manipulate is HoldAll and, with no front end,
   evaluates to itself, so `m` is already the inert expression. *)
wbManipSrcAttr[m_] := Module[{src},
  src = Quiet@Check[ToString[m, InputForm], $Failed];
  If[!StringQ[src] || StringLength[src] > 200000, Return[""]];
  " data-manip-src=\"" <> BaseEncode[StringToByteArray[src, "UTF-8"]] <> "\""];

wbManipIntercept[m_, scale_, fmt_: "Auto"] := Module[{parsed, specs, id, body, inner},
  parsed = wbManipParse[m];
  If[parsed === $Failed, Return[$Failed]];
  {body, specs} = parsed;

  $wbManipCounter++;
  id = "m" <> IntegerString[Hash[{Hash[m], $wbManipCounter}], 36];
  wbManipRegister[id, body, specs, fmt, <||>];

  inner = wbManipRenderBody[id, scale, fmt];
  StringJoin[
    "<div class=\"wl-manip\" data-manip-id=\"", id, "\"", wbManipSrcAttr[m], ">",
      "<div class=\"wl-manip-controls\" data-manip-id=\"", id, "\"",
        " style=\"display:inline-block;padding:2px 0 6px 0;\">",
        StringJoin[wbManipControlHTML[id, #] & /@ specs],
      "</div>",
      "<div class=\"wl-manip-result\" data-manip-id=\"", id, "\">", inner, "</div>",
    "</div>"]];

(* ---------- update, called from the renderer via the extension ---------- *)
(* sets is an Association of name -> numeric value. *)

(* A Manipulate whose registry entry is gone \[LongDash] a restarted kernel, a
   reopened notebook, or an id aged out of the bounded registry.  The marker
   attribute is what the extension matches on to try a revive from the source
   carried in the HTML; the prose is the fallback the reader sees if that
   fails too. *)
wbManipDeadHTML[] :=
  "<pre class=\"vscode-wolfram-text-output\" data-wb-manip-dead=\"1\">This Manipulate is no \
longer live (the kernel restarted) \[LongDash] re-evaluate the cell.</pre>";

(* Keep this as a three-argument call.  A hot-deployed webview can then still
   talk to a kernel that has the preceding version of this definition loaded;
   old kernels harmlessly retain (and ignore) the reserved association key. *)
VsCodeManipUpdate[id_String, sets_Association, scale_?NumericQ] :=
  Module[{r, fmt, requestedFormat, valueSets},
    r = $wbManipRegistry[id];
    If[!AssociationQ[r], Return[wbManipDeadHTML[]]];
    requestedFormat = Lookup[sets, "__wolfbook_manip_format", Automatic];
    valueSets = KeyDrop[sets, "__wolfbook_manip_format"];
    $wbManipRegistry[id, "current"] =
      Join[r["current"], KeySelect[valueSets, StringQ]];
    (* The active output header tells us which format the user selected.  It is
       optional for backward compatibility with older renderer clients. *)
    If[StringQ[requestedFormat], $wbManipRegistry[id, "format"] = requestedFormat];
    fmt = If[StringQ[requestedFormat], requestedFormat, Lookup[r, "format", "Auto"]];
    Quiet@Check[
      TimeConstrained[wbManipRenderBody[id, scale, fmt], 30,
        "<pre class=\"vscode-wolfram-text-output\">Manipulate update timed out.</pre>"],
      "<pre class=\"vscode-wolfram-text-output\">Manipulate update failed.</pre>"]];

(* Retain the four-argument form for callers already using it. *)
VsCodeManipUpdate[id_String, sets_Association, scale_?NumericQ, requestedFormat_String] :=
  VsCodeManipUpdate[id,
    Join[KeyDrop[sets, "__wolfbook_manip_format"],
      <|"__wolfbook_manip_format" -> requestedFormat|>], scale];

VsCodeManipUpdate[___] :=
  "<pre class=\"vscode-wolfram-text-output\">Bad Manipulate update request.</pre>";

(* ---------- revive, called when an update finds no registry entry ---------- *)
(* srcB64 is the base64 UTF-8 InputForm of the original Manipulate, carried on
   the HTML by wbManipSrcAttr.  Re-registering under the SAME id keeps the
   sliders already on screen wired up, so the reader never sees them go dead.

   The body may still reference symbols the restarted kernel no longer defines;
   that surfaces as the ordinary "body failed to evaluate" result rather than a
   claim of success. *)
VsCodeManipRevive[id_String, srcB64_String, sets_Association, scale_?NumericQ] :=
  Module[{src, held, hits, m, parsed, body, specs, fmt, requestedFormat},
    src = Quiet@Check[ByteArrayToString[BaseDecode[srcB64], "UTF-8"], $Failed];
    If[!StringQ[src], Return[wbManipDeadHTML[]]];
    (* Parse WITHOUT evaluating.  src may be a whole notebook cell rather than a
       bare Manipulate \[LongDash] that is how a notebook saved before the source
       attribute existed is revived \[LongDash] and reconnecting sliders must never
       be a back door to running the rest of that cell. *)
    held = Quiet@Check[ToExpression[src, InputForm, Hold], $Failed];
    If[Head[held] =!= Hold, Return[wbManipDeadHTML[]]];
    hits = Cases[held, mm_Manipulate :> Hold[mm], {0, Infinity}, 1];
    If[hits === {}, Return[wbManipDeadHTML[]]];
    (* Manipulate is HoldAll and, with no front end, evaluates to itself. *)
    m = ReleaseHold[First[hits]];
    parsed = wbManipParse[m];
    If[parsed === $Failed, Return[wbManipDeadHTML[]]];
    {body, specs} = parsed;
    requestedFormat = Lookup[sets, "__wolfbook_manip_format", Automatic];
    fmt = If[StringQ[requestedFormat], requestedFormat, "Auto"];
    wbManipRegister[id, body, specs, fmt,
      KeyDrop[sets, "__wolfbook_manip_format"]];
    Quiet@Check[
      TimeConstrained[wbManipRenderBody[id, scale, fmt], 30,
        "<pre class=\"vscode-wolfram-text-output\">Manipulate update timed out.</pre>"],
      "<pre class=\"vscode-wolfram-text-output\">Manipulate update failed.</pre>"]];

VsCodeManipRevive[___] :=
  "<pre class=\"vscode-wolfram-text-output\">Bad Manipulate revive request.</pre>";
