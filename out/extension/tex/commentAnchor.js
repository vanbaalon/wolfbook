'use strict';

const crypto = require('crypto');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
function uniqueOffset(text, quote) {
    if (!quote) return {state:'missing'};
    const start = text.indexOf(quote);
    if (start < 0) return {state:'missing'};
    if (text.indexOf(quote, start + 1) >= 0) return {state:'ambiguous'};
    return {state:'unique', start, end:start + quote.length};
}

// A semantic cell may detach while its exact quoted text remains addressable.
// Old line numbers describe provenance; they never authorize a write.
function resolveCommentAnchor(file, text, comment, version) {
    const quote = comment.selection?.quote || comment.cell?.source || '';
    const found = uniqueOffset(text, quote);
    if (found.state !== 'unique') return {status:found.state, editable_span:null,
        reason:found.state === 'ambiguous' ? 'The exact quote occurs more than once.' : 'The exact quote is absent from the current source.'};
    const line = lineAt(text, found.start), endLine = lineAt(text, found.end - 1);
    const oldLine = (comment.cell?.line || 1) + (comment.selection?.lineOffset || 0);
    const contextStart = Math.max(0, found.start - 600), contextEnd = Math.min(text.length, found.end + 600);
    const context = text.slice(contextStart, contextEnd);
    return {status:line === oldLine ? 'exact' : 'uniquely-relocated', line, endLine,
        editable_span:{comment_id:comment.id, startOffset:found.start, endOffset:found.end,
            text:quote.slice(0, 8000), truncated:quote.length > 8000, source_hash:hash(quote), buffer_version:version ?? null},
        context:{before:text.slice(contextStart, found.start), after:text.slice(found.end, contextEnd),
            truncated:contextStart > 0 || contextEnd < text.length},
        equation_labels:[...new Set([...context.matchAll(/\\(?:label|eqref|ref)\{([^{}]+)\}/g)].map(m => m[1]))].slice(0, 30)};
}

// Shrink a replacement to its actual changed range, so unchanged text within
// the supplied passage cannot swallow a reader's disjoint mini-editor draft.
function changedRange(start, before, after) {
    let prefix=0, suffix=0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    while (suffix < before.length-prefix && suffix < after.length-prefix &&
        before[before.length-1-suffix] === after[after.length-1-suffix]) suffix++;
    return {start:start+prefix, end:start+before.length-suffix,
        before:before.slice(prefix, before.length-suffix), text:after.slice(prefix, after.length-suffix)};
}
module.exports = {resolveCommentAnchor, uniqueOffset, changedRange};
