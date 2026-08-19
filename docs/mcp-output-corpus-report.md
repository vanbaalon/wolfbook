# MCP canonical-output corpus measurement

Measured 2026-08-17 with `node scripts/measure-mcp-output-corpus.js ../quests`.
The corpus contains 587 unchanged `.wb` notebooks, 11,154 cells, 4,057
outputs, and 8,141 MIME items.

| Measure | Result |
|---|---:|
| Persisted output payload | 70,222,386 bytes (~17,555,597 tokens) |
| Canonical MCP projection | 7,494,943 bytes (~1,873,736 tokens) |
| Aggregate reduction | 89.33% |
| Median per-notebook reduction | 72.53% |
| Source fidelity mismatches | 0 |
| MIME item-count mismatches | 0 |
| Plain-preview fidelity mismatches | 0 |
| First-observed / warm corpus reopen | 334.875 / 164.220 ms |
| Median JSON reopen | 0.199 ms |
| Cache cold write / cold read / warm read | 0.221 / 0.089 / 0.063 ms |

The 70% median target is met. Renderer HTML accounts for 69,093,072 bytes,
plain text for 1,051,218 bytes, and error sentinels for 78,096 bytes. The
projection retains exact source, readable plain/LaTeX previews, and a manifest
with MIME type, byte count, SHA-256, derivability and cache identity. It omits
render HTML from agent context by default. These measurements do not imply a
notebook migration: serializer input/output and offline reopening are unchanged.

The projection, render cache, and bounded result envelopes are initially behind
separate settings. This permits comparison in live workloads before changing
the default MCP view.
