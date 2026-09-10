# Wolfbook Activity

The live view shows unfinished operations individually, with the reported caller/session, tool, elapsed time, owning VS Code window, and notebook/cell or paper selector. Background execution remains active after the initial tool response. “Open target” routes to the owning window; no kernel restart is needed to navigate.

## Controls

- Click an agent card or idle-agent chip to filter Recent work; click again or use Clear to remove the filter.
- The kernel Dock shows live kernels. Click to inspect the active or last recorded task. Kernels without a recorded task show status only. Restart remains behind “Kernel controls…” and requires confirmation in VS Code.
- Press Space or Enter on an activity row for Quick Look. Use arrow keys or the inspector’s arrows to browse calls; Escape closes it.
- Press Command-K (Control-K on Windows/Linux) for agents, notebook navigation, kernel inspection, and common filters.
- Related completed calls are grouped by caller, owning window, notebook, and proximity in time. These are browsing groups, not inferred agent task identities. Expand a group to inspect individual calls.
- New calls do not replace the history while you are reading it. “Show latest” accepts pending updates. Relative timestamps continue ticking independently.
- Before/after previews display the recorded changed fragments, not necessarily the complete cell. “Open this cell” resolves its target from the recorded change rather than trusting a browser-supplied path.
- TeX navigation resolves an exact label, stable key, or object ID against the current buffer. If it cannot resolve the selector, it opens the file and reports that limitation instead of guessing a section.

Agent colours are deterministic per session. Idle connections collapse into a disclosure. Entrance fades are short and disabled under reduced-motion preferences. Input highlighting is lightweight and runs locally; no notebook content is sent to a third-party service.

The dashboard is served by the primary MCP window. After deploying extension changes, reload that owning window when safe for its kernels, then refresh the browser page. Reloading a secondary window alone does not update the primary’s loaded modules.
