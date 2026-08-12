'use strict';
/**
 * Wolfslide AI co-designer — the thin LLM planner (Stage 3c).
 *
 * Maps a natural-language instruction on the SELECTED blocks into a small, validated
 * PLAN of design verbs (+ occasional prose edits). It reuses the Oberon model transport
 * (roles + provider adapters) but NOT the quest/charm lifecycle — this is a single-shot,
 * sub-second, preview-first call. The webview applies the returned plan to a STAGED deck
 * and shows a badged preview the user accepts or rejects; the model never writes directly.
 *
 * The pure helpers (buildMessages / extractJson / parsePlan / validatePlan) carry no
 * `vscode` / provider dependency so they are unit-testable in plain Node
 * (test/wslide/slideai-unit.js). `planFromInstruction` lazy-requires the Oberon config +
 * provider so requiring this module for tests never pulls the VS Code API.
 */

// The design verbs the planner may emit (must mirror WSLIDE_VERBS in wslide-editor.html).
const VERB_OPS = ['align', 'distribute', 'matchSize', 'snapToGrid', 'centerOnCanvas', 'stack', 'tidy'];
// Block types whose text CONTENT is the user's authorship and must never be reworded.
// (Restyling — colour/size/etc. — IS allowed on them; only content rewrites are refused.)
const PROTECTED_TYPES = ['math', 'eval', 'code', 'image', 'shape', 'arrow'];
// CSS properties a styleEdit may set (camelCase — applied as inline style / a preset).
const STYLE_KEYS = [
  'color', 'background', 'backgroundColor', 'fontSize', 'fontWeight', 'fontStyle', 'fontFamily',
  'textAlign', 'textDecoration', 'textTransform', 'lineHeight', 'letterSpacing', 'padding',
  'borderRadius', 'border', 'borderColor', 'borderWidth', 'borderStyle', 'opacity', 'boxShadow',
  'textShadow', 'whiteSpace',
];
const MAX_TEXT_LEN = 6000;

const SYSTEM_PROMPT = [
  'You are Wolfslide\'s on-canvas design assistant. The user has SELECTED one or more blocks on a',
  'slide (a 1920×1080 canvas) and given a short instruction. Return a small PLAN that satisfies it,',
  'as STRICT JSON, nothing else. A plan combines three kinds of edit: geometry VERBS, prose',
  'textEdits, and styleEdits (colour/size/etc.).',
  '',
  'Hard rules:',
  '- Scope is the selection ONLY. Never invent blocks or touch ids that were not provided.',
  '- ACT on the instruction. Only return all-empty arrays if it truly cannot be expressed with the',
  '  operations below — otherwise always propose the edits that satisfy it.',
  '- Do NOT reword math, eval, code, image, or shape blocks (their CONTENT is the user\'s authorship);',
  '  but you MAY restyle/move/resize any block, including those.',
  '- Keep it minimal: emit only what the instruction asks for.',
  '',
  'Geometry VERBS (op → params) — apply to blocks with position:"absolute" (free-placed) only:',
  '- align { edge: left|hcenter|right|top|vcenter|bottom, toCanvas?: bool }',
  '- distribute { axis: h|v }              (needs 3+ blocks)',
  '- matchSize { dim: w|h|wh, refId?: id } (others take the reference block\'s size)',
  '- snapToGrid { grid?: number }',
  '- centerOnCanvas { axis: both|h|v }',
  '- stack { axis: v|h, gap?: number }     (needs 2+ blocks)',
  '- tidy { grid?: number, gap?: number }  (snap + align + evenly stack — the "make it look good" combo)',
  'Each verb may include "ids":[…] to scope it; omit ids to apply to the whole selection.',
  '',
  'styleEdits — set CSS on blocks (works on ANY block, absolute or flow). Use for colour, background,',
  'font size/weight/style, alignment, padding, rounding, opacity, etc. Values are CSS strings',
  '(e.g. "blue", "#1e40af", "48px", "bold", "center"). Allowed keys: ' + STYLE_KEYS.join(', ') + '.',
  'Examples: "make it blue" → styleEdits:[{id, style:{color:"blue"}}]; "bigger bold heading" →',
  'styleEdits:[{id, style:{fontSize:"56px", fontWeight:"700"}}]; "give it a light blue background" →',
  'styleEdits:[{id, style:{background:"#dbeafe"}}].',
  '',
  'textEdits — rewrite the rich-text content of a text/heading/box/list block only.',
  '',
  'Respond with JSON of exactly this shape:',
  '{ "verbs": [ { "op": "tidy", "params": {}, "ids": ["b1"] } ],',
  '  "textEdits": [ { "id": "b3", "content": "<p>new rich text</p>" } ],',
  '  "styleEdits": [ { "id": "b1", "style": { "color": "blue" } } ],',
  '  "changelog": "one short human sentence describing what you did" }',
  'Use [] for any list you don\'t need. changelog is plain language, never JSON.',
].join('\n');

/** Build the (system,user) messages for a planner call. Pure. */
function buildMessages({ instruction, blocks, canvas }) {
  const cw = (canvas && canvas.w) || 1920, ch = (canvas && canvas.h) || 1080;
  const compact = (blocks || []).map(b => ({
    id: b.id, type: b.type,
    position: b.position || 'flow',
    x: b.x, y: b.y, w: b.w, h: b.h,
    stylePreset: b.stylePreset,
    style: b.style,
    // include prose content (truncated) so rewrites are grounded; protected types send none
    content: (PROTECTED_TYPES.indexOf(b.type) < 0 && typeof b.content === 'string')
      ? b.content.slice(0, 1200) : undefined,
  }));
  const user = [
    'Canvas: ' + cw + '×' + ch + ' px.',
    'Selected blocks (JSON):',
    JSON.stringify(compact),
    '',
    'Instruction: ' + String(instruction || '').slice(0, 1000),
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Pull the first balanced JSON object out of a model reply (handles ``` fences / prose). Pure. */
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/** Parse a model reply into a raw plan object. Throws on unrecoverable garbage. Pure. */
function parsePlan(text) {
  const json = extractJson(text);
  if (!json) throw new Error('no JSON object in model reply');
  let obj;
  try { obj = JSON.parse(json); } catch (e) { throw new Error('plan JSON parse failed: ' + e.message); }
  return {
    verbs: Array.isArray(obj.verbs) ? obj.verbs : [],
    textEdits: Array.isArray(obj.textEdits) ? obj.textEdits : [],
    styleEdits: Array.isArray(obj.styleEdits) ? obj.styleEdits : [],
    changelog: typeof obj.changelog === 'string' ? obj.changelog : '',
  };
}

/** Keep only whitelisted CSS keys with string values (drop width/height — geometry is via verbs). */
function _sanitizeStyle(style) {
  const out = {};
  if (!style || typeof style !== 'object') return out;
  for (const [k, v] of Object.entries(style)) {
    if (STYLE_KEYS.indexOf(k) < 0) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    out[k] = String(v).slice(0, 200);
  }
  return out;
}

/**
 * Sanitize a raw plan against the actual selection. Pure.
 * - verbs: keep only known ops; drop unknown ids (scope = selection); coerce params.
 * - textEdits: keep only selected, NON-protected, string-content edits, length-capped.
 * - styleEdits: keep only selected ids; whitelist CSS keys (allowed on ANY block — restyling
 *   never rewrites content).
 * @returns {{ plan: {verbs,textEdits,styleEdits,changelog}, warnings: string[] }}
 */
function validatePlan(plan, { blocks }) {
  const byId = {};
  (blocks || []).forEach(b => { if (b && b.id) byId[b.id] = b; });
  const allowed = Object.keys(byId);
  const protectedIds = new Set(allowed.filter(id => PROTECTED_TYPES.indexOf(byId[id].type) >= 0));
  const warnings = [];

  const verbs = [];
  for (const v of (plan.verbs || [])) {
    if (!v || VERB_OPS.indexOf(v.op) < 0) { warnings.push('dropped unknown verb: ' + (v && v.op)); continue; }
    let ids = Array.isArray(v.ids) ? v.ids.filter(id => byId[id]) : null;
    if (ids && ids.length === 0) ids = null;          // all filtered out → fall back to whole selection
    const params = (v.params && typeof v.params === 'object') ? v.params : {};
    if (params.refId && !byId[params.refId]) delete params.refId;
    verbs.push({ op: v.op, params, ids: ids || undefined });
  }

  const textEdits = [];
  for (const t of (plan.textEdits || [])) {
    if (!t || !byId[t.id]) { warnings.push('dropped textEdit for unknown block'); continue; }
    if (protectedIds.has(t.id)) { warnings.push('refused to reword protected block ' + t.id); continue; }
    if (typeof t.content !== 'string') { warnings.push('dropped non-string textEdit'); continue; }
    if (typeof byId[t.id].content !== 'string') { warnings.push('block ' + t.id + ' has no text content'); continue; }
    textEdits.push({ id: t.id, content: t.content.slice(0, MAX_TEXT_LEN) });
  }

  const styleEdits = [];
  for (const s of (plan.styleEdits || [])) {
    if (!s || !byId[s.id]) { warnings.push('dropped styleEdit for unknown block'); continue; }
    const style = _sanitizeStyle(s.style);
    if (!Object.keys(style).length) { warnings.push('dropped styleEdit with no allowed CSS keys'); continue; }
    styleEdits.push({ id: s.id, style });
  }

  return { plan: { verbs, textEdits, styleEdits, changelog: String(plan.changelog || '').slice(0, 240) }, warnings };
}

/**
 * Full pipeline: instruction + selection → validated plan, via the slidewright model.
 * Lazy-requires the Oberon config + provider so the pure helpers above stay Node-testable.
 * @returns {Promise<{ok:true, plan, warnings}|{ok:false, error}>}
 */
async function planFromInstruction({ instruction, blocks, canvas, timeoutMs = 30000 }) {
  if (!String(instruction || '').trim()) return { ok: false, error: 'empty instruction' };
  if (!Array.isArray(blocks) || !blocks.length) return { ok: false, error: 'no blocks selected' };

  let roles, getAdapter;
  try {
    roles = require('./oberon/config/roles');
    ({ getAdapter } = require('./oberon/providers'));
  } catch (e) {
    return { ok: false, error: 'AI provider layer unavailable: ' + (e && e.message || e) };
  }

  let binding;
  try { binding = roles.resolveRole('slidewright'); } catch (_) { binding = null; }
  if (!binding || !binding.configured) {
    return { ok: false, error: 'No AI model configured. Set an Oberon provider API key (wolfbook.oberon.providers.*) to use the design assistant.' };
  }
  const adapter = getAdapter(binding.provider);
  if (!adapter || typeof adapter.chatComplete !== 'function') {
    return { ok: false, error: 'AI provider "' + binding.provider + '" is not available' };
  }

  const req = {
    messages: buildMessages({ instruction, blocks, canvas }),
    model: binding.model,
    temperature: 0,
    maxTokens: binding.maxTokens || 1200,
    responseFormat: 'json_object',
  };
  try {
    const call = adapter.chatComplete(req, { pricing: binding.pricing });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('design assistant timed out')), timeoutMs));
    const result = await Promise.race([call, timeout]);
    const raw = parsePlan(result && result.content);
    const { plan, warnings } = validatePlan(raw, { blocks });
    if (!plan.verbs.length && !plan.textEdits.length && !plan.styleEdits.length) {
      return { ok: false, error: 'The assistant proposed no change. Try being more specific — e.g. "make the text blue", "bigger heading", "align these left", or "tidy" (geometry needs free-positioned blocks).' };
    }
    return { ok: true, plan, warnings };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  VERB_OPS, PROTECTED_TYPES, STYLE_KEYS,
  buildMessages, extractJson, parsePlan, validatePlan, planFromInstruction,
};
