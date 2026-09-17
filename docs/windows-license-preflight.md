# Windows licence preflight correction

Two 2.10.0 reports identified a false negative: `WolframKernel.exe
-licenseinfo` exits 0 without output on Windows, while the console sibling
`wolfram.exe` returns licence fields. There is no established VS Code regression.

The probe now prefers `wolfram.exe`, then `math.exe`, from the configured
Windows kernel's directory. The actual WSTP executable is unchanged. Custom
launchers are not substituted and PATH is not searched.

A clean exit with missing or unfamiliar output allows startup, but is logged
as unconfirmed rather than verified. Only a complete numeric three-field record
is interpreted for seat counts. Explicit licence errors, all-zero records and
zero available seats still reject. Timeouts, spawn errors and unsuccessful exits
retain the blocking-startup safety guard; unfamiliar failures no longer claim
the licence is invalid. The check is bounded and does not retry automatically.

Wolfram's documented contract:
https://reference.wolfram.com/language/ref/program/wolfram.html

## Validation and remaining limitations

Injected-process tests cover Windows sibling selection/fallback, exit-zero empty
and unfamiliar output, valid fields, explicit failures, zero seats, zero records,
non-zero/signal exits, timeout termination and redaction. These are not a native
Windows end-to-end test. Windows users should confirm startup and evaluation on
the packaged build with their original WolframKernel setting.

The report of orphaned processes is not yet reproduced. Preflight timeout kills
the owned child, but a Windows console stub may have descendants. WSTP startup
also has synchronous native operations; a JavaScript timeout cannot interrupt
them. General protection requires bounded/cancellable native startup (or an
isolated kernel host) and ownership-based process-tree cleanup. Do not kill all
Wolfram processes, and do not remove the timeout guard without that protection.
