// wstp-backend — TypeScript declarations

/**
 * A Wolfram Language expression, converted from the WSTP wire format.
 *
 * Exactly one of the structural fields will be set depending on the
 * expression type:
 *   - integer: `type === "integer"`, `value` is a JS number
 *   - real:    `type === "real"`,    `value` is a JS number
 *   - string:  `type === "string"`,  `value` is a JS string
 *   - symbol:  `type === "symbol"`,  `value` is the symbol name
 *   - function:`type === "function"`, `head` is the head name, `args` is the argument list
 *   - error:   `type === undefined`, `error` is a message string (never resolved normally)
 */
export interface WExpr {
    type?:   "integer" | "real" | "string" | "symbol" | "function";
    value?:  number | string;   // set for integer / real / string / symbol
    head?:   string;            // set for function
    args?:   WExpr[];           // set for function
    error?:  string;            // set when addon encountered an internal error
}

/**
 * Everything the kernel sends for one cell evaluation.
 *
 * The kernel sends packets in this order:
 *   InputNamePacket  → cellIndex
 *   (computation)
 *   MessagePacket + TextPacket (0 or more pairs) → messages
 *   TextPacket (0 or more)                       → print
 *   OutputNamePacket                              → outputName
 *   ReturnPacket                                  → result
 */
export interface EvalResult {
    /** The n in In[n]:= — monotonically increasing counter for each evaluation. */
    cellIndex:  number;
    /** E.g. "Out[42]=" for a non-Null result, or "" when the result is Null. */
    outputName: string;
    /** The expression returned by the kernel (ReturnPacket payload). */
    result:     WExpr;
    /** Lines written via Print[] or other output functions, in order. */
    print:      string[];
    /**
     * Kernel messages, one string per message.
     * Format: "symbol::tag — human readable text"
     * E.g. "Power::infy — Infinite expression 1/0 encountered."
     */
    messages:   string[];
    /** True when the evaluation was stopped by abort(). */
    aborted:    boolean;
}

/**
 * Optional streaming callbacks for one evaluate() call.
 *
 * Both callbacks are invoked on the main thread as the kernel produces
 * output — before the returned Promise resolves.  Use them for real-time
 * progress feedback during long computations.
 */
export interface EvalOptions {
    /** Called once per line written via Print[] (or similar output functions). */
    onPrint?:   (line: string) => void;
    /** Called once per kernel message (e.g. "Power::infy: Infinite expression…"). */
    onMessage?: (msg:  string) => void;
    /**
     * Called when the kernel opens a Dialog[] subsession.
     * @param level  Nesting depth (1 for the outermost dialog).
     */
    onDialogBegin?: (level: number) => void;
    /**
     * Called once per Print[] line produced inside the dialog subsession.
     * @param line  Output line text.
     */
    onDialogPrint?: (line: string) => void;
    /**
     * Called when the dialog subsession closes (Return[] or kernel exit).
     * @param level  The nesting depth that just closed.
     */
    onDialogEnd?: (level: number) => void;
}

/**
 * A session wrapping one WolframKernel process connected over WSTP.
 *
 * Multiple evaluate() calls are automatically serialised through an
 * internal queue — it is safe to fire them without awaiting.  The kernel
 * link is never corrupted even under concurrent callers.
 */
export class WstpSession {
    /**
     * Launch a new WolframKernel process and connect to it over WSTP.
     * @param kernelPath  Full path to WolframKernel binary.
     *                    Defaults to the standard macOS install location.
     * @throws if the kernel cannot be launched or the link fails to activate.
     */
    constructor(kernelPath?: string);

    /**
     * Evaluate a Wolfram Language expression string and return the full result.
     *
     * The kernel parses the string with ToExpression, evaluates it, and
     * returns an EvalResult capturing the return value, all Print[] output,
     * and all kernel messages that were emitted during evaluation.
     *
     * Multiple calls are serialised automatically — you may fire them
     * concurrently without awaiting; each one will start after the previous
     * one finishes.
     *
     * @param expr  Wolfram Language expression as a string.
     * @param opts  Optional streaming callbacks (`onPrint`, `onMessage`).
     * @returns     Promise that resolves with the EvalResult when the kernel responds.
     */
    evaluate(expr: string, opts?: EvalOptions): Promise<EvalResult>;

    /**
     * Exit the currently-open Dialog[] subsession.
     *
     * Sends `Return[retVal]` as `EnterTextPacket` — the interactive-context
     * packet that the kernel recognises as "exit the dialog".  This is
     * different from `dialogEval('Return[]')` which uses `EvaluatePacket`
     * and leaves `Return[]` unevaluated (no enclosing Do/Block to return from).
     *
     * Resolves with `null` once `EndDialogPacket` is received.
     * Rejects immediately if `isDialogOpen` is false.
     *
     * @param retVal  Optional Wolfram Language string to pass as the return
     *                value of `Dialog[]`, e.g. `'42'` or `'myVar'`.
     */
    exitDialog(retVal?: string): Promise<null>;

    /**
     * Evaluate an expression inside the currently-open Dialog[] subsession.
     *
     * Queues `expr` for evaluation by the kernel's dialog REPL.  Resolves with
     * the WExpr result once the dialog loop has processed it.  Rejects if
     * `isDialogOpen` is false at call time (i.e. no dialog is currently open).
     *
     * @param expr  Wolfram Language expression string.
     * @returns     Promise that resolves with the WExpr result.
     */
    dialogEval(expr: string): Promise<WExpr>;

    /**
     * Send WSInterruptMessage to the kernel (best-effort).
     *
     * Whether this has any effect depends on whether a Wolfram-side interrupt
     * handler has been installed, e.g.:
     * ```
     * Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]
     * ```
     * Without such a handler this is a no-op.  For a guaranteed way to enter
     * a dialog, call `Dialog[]` directly from Wolfram code.
     *
     * @returns true if the message was posted to the link successfully.
     */
    interrupt(): boolean;

    /** True while a Dialog[] subsession is open on this link. */
    readonly isDialogOpen: boolean;

    /**
     * Interrupt the currently running evaluate() call.
     *
     * Posts WSAbortMessage to the kernel.  The kernel stops its current
     * computation and the evaluate() Promise resolves with `aborted: true`
     * and `result: { type: "symbol", value: "$Aborted" }`.
     *
     * The kernel remains alive and can accept further evaluations.
     *
     * @returns true if the abort message was posted successfully.
     */
    abort(): boolean;

    /**
     * Evaluate an expression, returning just the result expression
     * (not a full EvalResult).
     *
     * `sub()` is always prioritised over pending `evaluate()` calls: it runs
     * before any already-queued evaluations.  If the session is currently busy,
     * `sub()` waits for the in-flight evaluation to finish, then runs next
     * (ahead of any other queued `evaluate()` calls).  If idle, it starts
     * immediately.
     *
     * Multiple `sub()` calls are queued FIFO among themselves and all run
     * before the next `evaluate()` call in the queue.
     *
     * @param expr  Wolfram Language expression string to evaluate.
     * @returns     Promise that resolves with the WExpr result.
     */
    sub(expr: string): Promise<WExpr>;

    /**
     * Launch an independent child kernel as a new WstpSession.
     *
     * The child has completely isolated state (variables, definitions, memory).
     * It must be closed independently with child.close().
     *
     * @param kernelPath  Optional path override; defaults to the parent's path.
     */
    createSubsession(kernelPath?: string): WstpSession;

    /**
     * Send Quit[] to the kernel, close the link, and release all resources.
     * Subsequent calls to evaluate() will reject immediately.
     */
    close(): void;

    /** True while the link is open and the kernel is running. */
    readonly isOpen: boolean;
}

/**
 * A reader that connects to a named WSTP link created by the kernel
 * (via `LinkCreate`) and receives expressions pushed by the kernel
 * (via `LinkWrite`).
 *
 * Use this for real-time monitoring: the kernel pushes variable snapshots
 * while the main link is blocked on a long evaluation.
 *
 * @example
 * // Wolfram side:
 * //   $mon = LinkCreate[LinkProtocol -> "TCPIP"];
 * //   linkName = $mon[[1]];          (* extract string from LinkObject *)
 * //   Do[LinkWrite[$mon, i]; Pause[1], {i, 1, 10}];
 * //   LinkClose[$mon];
 *
 * // JS side:
 * const reader = new WstpReader(linkName);
 * while (reader.isOpen) {
 *     try {
 *         const v = await reader.readNext();
 *         console.log('monitor:', v);
 *     } catch { break; }
 * }
 */
export class WstpReader {
    /**
     * Connect to a named WSTP link that is already listening.
     *
     * @param linkName  The name returned by Wolfram's `$link[[1]]` or `LinkName[$link]`.
     *                  For TCPIP links this looks like "port@host,0@host".
     * @param protocol  Link protocol, default "TCPIP".
     * @throws if the connection cannot be established.
     */
    constructor(linkName: string, protocol?: string);

    /**
     * Wait for the next expression written by the kernel via LinkWrite.
     *
     * Blocks on Node's thread pool until an expression arrives.
     * When the kernel closes the link (LinkClose[$link]), this rejects.
     *
     * @returns Promise that resolves with the next WExpr.
     */
    readNext(): Promise<WExpr>;

    /** Close the link and release resources. */
    close(): void;

    /** True while the link is open. */
    readonly isOpen: boolean;
}

/**
 * Register a callback that receives internal C++ diagnostic messages.
 *
 * Messages include WSTP packet traces (`[Eval] pkt=N`), TSFN dispatch
 * timestamps (`[TSFN][onPrint] dispatch +Nms`), `WstpReader` spin-wait
 * traces, and kernel lifecycle events (`[WarmUp]`, `[Session]`).
 *
 * The callback fires on the JS main thread, so it can safely write to
 * `process.stderr` or update UI.  It does **not** prevent the Node.js
 * process from exiting normally.
 *
 * Alternatively, set `DEBUG_WSTP=1` in the environment to write the same
 * messages directly to `stderr` from C++ (no JS handler needed):
 * ```
 * DEBUG_WSTP=1 node myscript.js 2>diag.txt
 * ```
 *
 * @param fn  Callback receiving each diagnostic message string,
 *            or `null` / `undefined` to clear a previously-set handler.
 */
export function setDiagHandler(fn: ((msg: string) => void) | null | undefined): void;
