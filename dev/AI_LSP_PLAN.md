# AI-Driven AILSP Plan

## 1. Goal
Build an AI-driven completion and code-intelligence layer ("AILSP") for Wolfbook that is faster and more notebook-aware than classic LSP, while keeping deterministic fallback behavior.

Key objective:
- Replace or minimize dependence on a separate LSP kernel process for completion/hover-like assistance.
- Use notebook context + project symbols + Wolfram built-in metadata to produce better completion ranking.

## 2. Constraint: Data Redistribution and Copyright
We should avoid shipping Wolfram internal data files directly inside the extension package if license/copyright terms are unclear.

Working assumption:
- Do not include Wolfram data files in the distributable extension.
- Read and transform data from the user's locally installed Wolfram product at runtime (first run), then cache derived indexes locally.

## 3. Data Sources for AILSP
### 3.1 Local Wolfram installation (first-run extraction)
Primary source candidates:
- LSPServer data files under local Wolfram installation (for built-ins/options metadata).
- Any additional public metadata available via local kernel queries.

Expected locations (platform dependent):
- macOS examples:
  - /Applications/Wolfram.app/...
  - /Applications/Wolfram 3.app/...
  - /Applications/Wolfram Engine.app/...

### 3.2 Live notebook/project context
- Global symbols currently known in notebook/kernel session.
- Recently evaluated expressions and symbol usage frequencies.
- Symbols from current workspace .wl/.m files.
- Local lexical scope near cursor.

### 3.3 Optional online/AI-only context
- None required for baseline operation.
- AI reranking should work offline-disabled (fallback to deterministic ranking).

## 4. First-Run Index Generation (No Bundled Wolfram Data)
### 4.1 Trigger
Run index generation on first extension activation where:
- AILSP index cache is missing, or
- Cache schema version is outdated, or
- Wolfram installation version changed.

### 4.2 Steps
1. Discover installed Wolfram kernels/products.
2. Select a source product path (prefer configured system kernel product root).
3. Locate source metadata files.
4. Parse/normalize into extension-owned JSON indexes.
5. Save indexes under extension global storage path.
6. Mark cache metadata with source version + hash + schema version.

### 4.3 Cache layout (example)
- <globalStorage>/ailsp/index-v1/builtins.json
- <globalStorage>/ailsp/index-v1/options.json
- <globalStorage>/ailsp/index-v1/symbol-relations.json
- <globalStorage>/ailsp/index-v1/meta.json

### 4.4 Regeneration policy
Regenerate when:
- Wolfram product version changed.
- Source file checksum changed.
- Extension AILSP schema version changed.
Manual command:
- Wolfbook: Rebuild AILSP Index

## 5. AILSP Runtime Architecture
### 5.1 Retrieval layer (deterministic, low-latency)
Build candidate set from:
- Built-in symbol index (from first-run cache).
- Option index keyed by current function context.
- Notebook global symbol cache.
- Workspace symbol index.
- Current-document lexical symbols.

Target latency:
- <= 20 ms for initial candidate list.

### 5.2 Ranking layer
Stage A (deterministic scoring):
- Prefix/fuzzy score.
- Context match (function call, option position, rule context, pattern context).
- Recency/frequency boosts from notebook activity.
- Popularity priors.

Stage B (AI reranking, optional):
- AI reranks top N (for example top 30 -> top 10).
- Strict timeout budget (for example 80-120 ms).
- If timeout/failure: keep deterministic order.

### 5.3 Hover/Info behavior
- Primary info path remains kernel-driven Information[...] for high-fidelity docs.
- AILSP cache can provide quick summary previews while kernel is busy.

## 6. Feature Set by Phase
### Phase 1: Deterministic completion engine (no AI)
- Build first-run index generator.
- Implement local completion provider using cached metadata + notebook symbols.
- Keep existing LSP path behind feature flag.

### Phase 2: AI reranking
- Add optional AI reranking for top candidates.
- Add guardrails, timeout, and fallback.

### Phase 3: AI contextual suggestions
- Snippet-level suggestions informed by notebook intent.
- Option/value recommendations based on nearby code patterns.

### Phase 4: LSP minimization
- Disable LSP completion by default when AILSP quality is sufficient.
- Keep LSP optional for users who still want full language-server behavior.

## 7. Settings and Flags
Proposed settings:
- wolfbook.ailsp.enabled (bool)
- wolfbook.ailsp.aiRerankEnabled (bool)
- wolfbook.ailsp.maxRerankCandidates (int)
- wolfbook.ailsp.rerankTimeoutMs (int)
- wolfbook.ailsp.rebuildOnWolframVersionChange (bool)
- wolfbook.ailsp.preferKernelInformation (bool)

Feature compatibility flag:
- wolfbook.lsp.serverEnabled remains available during migration.

## 8. UX and Commands
New commands:
- Wolfbook: Rebuild AILSP Index
- Wolfbook: Show AILSP Status
- Wolfbook: Open AILSP Cache Folder

Status output should include:
- Cache schema version
- Source Wolfram version/path
- Last build time
- Candidate latency metrics
- AI rerank usage/fallback stats

## 9. Reliability and Safety
- Never block typing on AI responses.
- Hard timeouts for all AI calls.
- Deterministic fallback always available.
- If no Wolfram source metadata found, still provide notebook/workspace symbol completion.
- Log build/parse failures with actionable recovery messages.

## 10. Evaluation Metrics
Track and compare vs current LSP baseline:
- Completion latency (p50/p95)
- Acceptance rate (% accepted suggestions)
- Keystrokes saved
- Error rate/timeouts
- Startup overhead

Success criteria (initial):
- Faster perceived completion than LSP.
- Equal or higher acceptance rate in notebook-heavy workflows.
- No regressions in core editing responsiveness.

## 11. Open Legal/Policy Check
Before public release:
- Confirm whether derived JSON indexes generated from local Wolfram installation are acceptable to store locally.
- Confirm what metadata (if any) can be redistributed in sample/test fixtures.
- Document policy in README and release notes.

## 12. Implementation Notes for Current Codebase
Likely integration points:
- out/extension/extension.js: completion provider registration and feature flags.
- out/extension/execution/global-symbols.js: reuse live symbol knowledge.
- out/extension/tools/index.js: optional AI helper tooling and status reporting.

Migration strategy:
- Ship AILSP behind opt-in setting first.
- Collect telemetry/feedback.
- Flip default once quality and stability targets are met.
