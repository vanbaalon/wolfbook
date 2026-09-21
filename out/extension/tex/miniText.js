// Textarea offsets are UTF-16 with LF line endings; document offsets may use CRLF.
const wireText = text => text.replace(/\r\n?/g, '\n');
function documentOffset(text, offset) {
    let raw = 0, wire = 0;
    while (raw < text.length && wire < offset) {
        raw += text[raw] === '\r' && text[raw + 1] === '\n' ? 2 : 1;
        wire++;
    }
    return raw;
}
function wireOffset(text, offset) {
    return wireText(text.slice(0, offset)).length;
}
function documentText(text, doc, previous) {
    const crlf = doc.eol === 2 || (doc.eol == null && previous.includes('\r\n'));
    return wireText(text).replace(/\n/g, crlf ? '\r\n' : '\n');
}
module.exports = { wireText, documentOffset, wireOffset, documentText };
