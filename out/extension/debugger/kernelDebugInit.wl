(* =========================================================================
   Wolfbook Debugger — Stage 2: Kernel Debug Support Code
   =========================================================================
   This file is evaluated in the kernel before each instrumented cell is run.
   It defines all wolfbookDebug$* state variables and functions.

   The instrumented cell calls:
     wolfbookDebug$BeforeStep[depth, localStep, {iterVarValues...}]
     wolfbookDebug$Timed[depth, localStep, expression]

   The extension (via WSTP) queries:
     wolfbookDebug$GetStepInfo[]
     wolfbookDebug$GetWatchValues[]
     wolfbookDebug$GetAllTimings[]
   and sends step commands by evaluating expressions in the Dialog subsession.
   ========================================================================= *)

(* ── Reset all state ──────────────────────────────────────────────────────── *)

wolfbookDebug$Active       = True;
wolfbookDebug$StepMode     = True;
wolfbookDebug$TargetDepth  = 0;          (* Step Over at top level to start *)
wolfbookDebug$CurrentDepth = 0;
wolfbookDebug$CurrentStep  = 0;
wolfbookDebug$CurrentIterVars = <||>;    (* <|"name" -> value, ...|> association *)
wolfbookDebug$WatchList    = {};         (* {"varName", ...} list *)
wolfbookDebug$Breakpoints  = {};         (* {{depth, step}, ...} list *)
wolfbookDebug$StepTimings  = <||>;       (* <| {depth,step} -> seconds, ... |> *)
wolfbookDebug$StepResults  = <||>;       (* <| {depth,step} -> result value, ... |> *)
wolfbookDebug$LastCompletedDepth = -1;   (* depth of the step that just ran *)
wolfbookDebug$LastCompletedStep  = -1;   (* localStep of the step that just ran *)

(* ── Core pause hook ──────────────────────────────────────────────────────── *)

(* Called BEFORE each instrumented statement.
   Pauses (enters Dialog[]) when:
     - StepMode is on and depth <= TargetDepth, OR
     - This step matches a registered breakpoint.
   When a breakpoint is hit in Continue mode, re-enables StepMode so the user
   can step from there. *)

wolfbookDebug$BeforeStep[depth_Integer, localStep_Integer, iterVarValues_] :=
  Module[{isBreakpoint, shouldPause},
    If[!wolfbookDebug$Active, Return[]];

    (* Update position *)
    wolfbookDebug$CurrentDepth = depth;
    wolfbookDebug$CurrentStep  = localStep;
    wolfbookDebug$CurrentIterVars = iterVarValues;

    (* Check breakpoint *)
    isBreakpoint = MemberQ[wolfbookDebug$Breakpoints, {depth, localStep}];

    (* If hit a breakpoint while in Continue mode, re-enable stepping *)
    If[isBreakpoint && !wolfbookDebug$StepMode,
      wolfbookDebug$StepMode    = True;
      wolfbookDebug$TargetDepth = depth;
    ];

    shouldPause = (wolfbookDebug$StepMode && depth <= wolfbookDebug$TargetDepth) || isBreakpoint;

    If[shouldPause, Dialog[]];
  ];

(* ── Timing wrapper ────────────────────────────────────────────────────────── *)

(* Wraps each instrumented statement in AbsoluteTiming so the kernel records
   execution time.
   HoldRest prevents WL from evaluating the third argument before it is passed
   in — without this the caller's expression is fully evaluated before entering
   the function, so AbsoluteTiming only sees the already-computed result (≈0 s).
   Returns the original expression's result (not the timing list). *)

SetAttributes[wolfbookDebug$Timed, HoldRest];

wolfbookDebug$Timed[depth_Integer, localStep_, expr_] :=
  Module[{timing, result, msgs = {}, captured},
    (* Capture Messages emitted during evaluation so we can surface them *)
    captured = Check[
      {timing, result} = AbsoluteTiming[expr];
      (* Check returns its first argument on success *)
      True,
      (* On any Message, record it but let the expression return its value *)
      False
    ];
    (* If Check caught an error, timing/result may still be set by AbsoluteTiming,
       but if the expression Threw or Aborted, they won't be. Guard against that. *)
    If[!ValueQ[timing], timing = 0];
    If[!ValueQ[result], result = $Failed];
    wolfbookDebug$StepTimings[{depth, localStep}] = timing;
    wolfbookDebug$StepResults[{depth, localStep}] = result;
    wolfbookDebug$LastCompletedDepth = depth;
    wolfbookDebug$LastCompletedStep  = localStep;
    result
  ];

(* Render a stored step result for display — returns "" for Null/Missing results.
   Uses VsCodeRenderExpr directly to avoid VsCodeRender[outN_Integer,...] dispatch
   when the stored result happens to be an integer. *)
wolfbookDebug$RenderStep[depth_Integer, localStep_Integer, format_String, scale_?NumericQ] :=
  Module[{result},
    result = wolfbookDebug$StepResults[{depth, localStep}];
    If[MissingQ[result] || result === Null, Return[""] ];
    VsCodeRenderExpr[result, format, scale]
  ];

(* ── Query functions (called by extension from Dialog subsession) ─────────── *)

(* Return current position + timing of the step that just completed.
   "Previous step" is the step before the current BeforeStep call, i.e. one
   localStep back at the same depth. Timing may be Missing if first step. *)

wolfbookDebug$GetStepInfo[] :=
  Module[{lastTiming},
    lastTiming = If[
      wolfbookDebug$LastCompletedDepth >= 0,
      Lookup[
        wolfbookDebug$StepTimings,
        Key[{wolfbookDebug$LastCompletedDepth, wolfbookDebug$LastCompletedStep}],
        Missing["NotAvailable"]
      ],
      Missing["NotAvailable"]
    ];
    <|
      "depth"            -> wolfbookDebug$CurrentDepth,
      "step"             -> wolfbookDebug$CurrentStep,
      "targetDepth"      -> wolfbookDebug$TargetDepth,
      "iterVarValues"    -> wolfbookDebug$CurrentIterVars,
      "prevTiming"       -> lastTiming,
      "prevTimingDepth"  -> wolfbookDebug$LastCompletedDepth,
      "prevTimingStep"   -> wolfbookDebug$LastCompletedStep
    |>
  ];

(* Return current values of all watched variables.
   Each entry has "short" (OutputForm string) and "full" (InputForm string). *)

wolfbookDebug$GetWatchValues[] :=
  Association @ Map[
    Function[name,
      name -> <|
        "short" -> ToString[ToExpression[name], OutputForm],
        "full"  -> ToString[ToExpression[name], InputForm]
      |>
    ],
    wolfbookDebug$WatchList
  ];

(* Return the complete timings association. *)

wolfbookDebug$GetAllTimings[] := wolfbookDebug$StepTimings;

(* ── Step control helpers (convenience — extension can call these directly) ── *)

(* Step Over: stay at the current depth, skip deeper levels. *)
wolfbookDebug$StepOver[] := (
  wolfbookDebug$StepMode    = True;
  wolfbookDebug$TargetDepth = wolfbookDebug$CurrentDepth
);

(* Step Into: pause at everything, including deeper depths. *)
wolfbookDebug$StepInto[] := (
  wolfbookDebug$StepMode    = True;
  wolfbookDebug$TargetDepth = Infinity
);

(* Step Out: finish current depth level, pause at parent. *)
wolfbookDebug$StepOut[] := (
  wolfbookDebug$StepMode    = True;
  wolfbookDebug$TargetDepth = wolfbookDebug$CurrentDepth - 1
);

(* Continue: run until next breakpoint (or end). *)
wolfbookDebug$Continue[] := (
  wolfbookDebug$StepMode = False
);

(* Run to end, ignoring all breakpoints. *)
wolfbookDebug$RunToEnd[] := (
  wolfbookDebug$StepMode    = False;
  wolfbookDebug$Breakpoints = {}
);

(* ── Cleanup (called after debug session ends) ─────────────────────────────── *)

wolfbookDebug$Cleanup[] := (
  wolfbookDebug$Active              = False;
  wolfbookDebug$StepMode            = False;
  wolfbookDebug$LastCompletedDepth  = -1;
  wolfbookDebug$LastCompletedStep   = -1;
  Clear[wolfbookDebug$StepTimings];
  wolfbookDebug$StepTimings  = <||>;
);

(* =========================================================================
   End of kernelDebugInit.wl
   ========================================================================= *)
