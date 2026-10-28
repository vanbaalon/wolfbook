'use strict';

// Receipts describe the outcome, not the unchanged manuscript's label inventory.
// The transport stores the original JSON before applying this projection.
function paperReceipt(tool, data) {
    if (!/^paper_(previewEdit|applyEdit)$/.test(tool) || !data || data.details_handle ||
        (!data.transaction_id && !data.operation_id)) return null;
    const out={...data};
    delete out.before; delete out.after; delete out.object; delete out.howToApply;
    const brief=value=>{
        if (typeof value === 'string') return value.length > 300 ? value.slice(0,300)+'…' : value;
        if (Array.isArray(value)) return value.slice(0,3).map(brief);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,brief(v)]));
        return value;
    };
    const counts=delta=>({introduced:delta?.introduced?.length || 0,resolved:delta?.resolved?.length || 0});
    const references=value=>{
        if (!value) return value;
        const {before,after,...delta}=value;
        return {...brief(delta),counts:{unresolved:counts(value.unresolved),duplicates:counts(value.duplicates)}};
    };
    if (out.warningDelta) {out.warningDelta_counts=counts(out.warningDelta);out.warningDelta=brief(out.warningDelta);}
    if (out.referenceDelta) out.referenceDelta=references(out.referenceDelta);
    if (out.verification) {
        out.verification={...out.verification,references:references(out.verification.references)};
        if (out.verification.parse) {
            const parse=out.verification.parse;
            out.verification.parse={...brief(parse),introduced_count:parse.introducedWarnings?.length || 0,
                resolved_count:parse.resolvedWarnings?.length || 0};
        }
        if (out.verification.latex) {
            const {diagnostics,...latex}=out.verification.latex;
            out.verification.latex={...brief(latex),diagnostic_count:diagnostics?.length || 0,
                ...(Array.isArray(latex.errors) ? {error_count:latex.errors.length} : {})};
        }
    }
    // A large batch must never push its mutation/verification IDs into a preview.
    if (out.edits) {out.edits_truncated=out.edits.length > 3;out.edits=brief(out.edits);}
    if (out.diff) {out.diff_truncated=out.diff.length > 3;out.diff=brief(out.diff);}
    return out;
}

function paperMessage(tool, data, failed = false) {
    if (data.message || data.reason || typeof data.error === 'string') return data.message || data.reason || data.error;
    if (tool === 'paper_listenComments') {
        if (data.state === 'waiting') return 'Waiting for comments.';
        if (data.state === 'comments') return `${data.comments?.length || 0} comment(s) ready.`;
        return `Comment listener: ${data.state || 'context ready'}.`;
    }
    if (tool === 'paper_previewEdit') return `Preview ready: ${data.editCount || 0} edit(s).`;
    if (tool === 'paper_applyEdit') return `Paper edit: ${data.state || (failed ? 'failed' : 'completed')}.`;
    return `${tool}: ${failed ? 'failed' : 'ready'}.`;
}
module.exports={paperReceipt,paperMessage};
