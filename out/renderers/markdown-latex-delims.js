// Wolfbook — accept LaTeX's native math delimiters in notebook markdown cells.
//
// VS Code's built-in notebook markdown renderer only recognises $…$ and $$…$$.
// Text written with LaTeX's own delimiters — \( … \) inline and \[ … \] display —
// is not treated as math: markdown eats the backslashes and the formula appears
// as literal text, e.g. "(F(w,\bar w)\to f(w))".
//
// That form arrives constantly: pasted from papers and .tex sources, and emitted
// by LLMs, which overwhelmingly prefer \( \) / \[ \]. Rather than asking every
// author and agent to remember a house style, translate the delimiters here.
//
// THE WOLFRAM TRAP
//   \[Alpha], \[Rule], \[CapitalOmega]… are Wolfram *named characters* and are
//   everywhere in this ecosystem. A naive \[ → $$ rewrite would corrupt them.
//   The discriminator is the CLOSING delimiter: display math closes with an
//   escaped \], a named character closes with a plain ]. Requiring \] separates
//   the two cleanly, so \[Alpha] is left untouched.
//
// Code is never rewritten: fenced blocks and inline spans are masked out first.

/**
 * @param {string} src raw markdown
 * @returns {string} markdown with \(…\) → $…$ and \[…\] → $$…$$
 */
function convertLatexDelimiters(src) {
    // Odd indices of this split are code regions — leave them exactly as authored.
    const parts = String(src).split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) continue;
        parts[i] = parts[i]
            // Display first, so a \[ … \] block containing parentheses is not
            // half-consumed by the inline rule.
            .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => '$$' + body + '$$')
            .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => '$' + body + '$');
    }
    return parts.join('');
}

export const activate = () => ({
    extendMarkdownIt(md) {
        // Run immediately after `normalize`, i.e. before block/inline parsing,
        // so the built-in math plugin sees ordinary $ / $$ math.
        md.core.ruler.after('normalize', 'wolfbook_latex_delims', (state) => {
            if (state.src && state.src.indexOf('\\') !== -1) {
                state.src = convertLatexDelimiters(state.src);
            }
        });
    },
});
