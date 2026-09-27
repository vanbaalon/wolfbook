// tex-figure.js — a figure's picture width and caption, as source edits.
//
// Pure (no DOM); the edit card's figure bar uses it on the card's own text,
// so a width or caption change reaches the source as the card's typing does
// (and with WLaTeX the page re-typesets as it changes). Moving a figure is
// the host's (texStructure.js), since it edits outside the card's block.

function readGroup(s, i, open = '{', close = '}') {
    while (/\s/.test(s[i] || '')) i++;
    if (s[i] !== open) return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === open) depth++;
        else if (s[j] === close && --depth === 0) return { start: i, body: s.slice(i + 1, j), end: j + 1 };
    }
    return null;
}

/**
 * A figure's parts in `fig` (its source): the first \includegraphics
 * (`{ start, end, options, file, width }`, width as a fraction of \linewidth /
 * \textwidth / \columnwidth when it is one), the caption (`{ start, end, text }`
 * of its argument), and the placement ([htbp]).
 */
function figureParts(fig) {
    const out = { graphics: null, caption: null, placement: null };
    const place = /^\\begin\s*\{[^}]*\}\s*(\[[^\]]*\])/.exec(fig);
    if (place) out.placement = place[1];
    const g = /\\includegraphics\s*(\[([^\]]*)\])?\s*\{([^}]*)\}/.exec(fig);
    if (g) {
        const options = g[2] || '';
        const w = /(?:^|,)\s*width\s*=\s*([\d.]*)\s*\\(linewidth|textwidth|columnwidth|hsize)/.exec(options);
        out.graphics = { start: g.index, end: g.index + g[0].length, options, file: g[3],
            width: w ? (w[1] === '' ? 1 : Number(w[1])) : null, unit: w ? w[2] : null };
    }
    const c = /\\caption\s*(\[[^\]]*\])?/.exec(fig);
    if (c) {
        const arg = readGroup(fig, c.index + c[0].length);
        if (arg) out.caption = { start: arg.start + 1, end: arg.end - 1, text: arg.body };
    }
    return out;
}

/** The figure with its (first) picture at `fraction` of the line width: width= set, scale/height dropped. */
function setFigureWidth(fig, fraction) {
    const p = figureParts(fig);
    if (!p.graphics) return fig;
    const f = Math.max(0.05, Math.min(1, Math.round(fraction * 100) / 100));
    const unit = p.graphics.unit || 'linewidth';
    const width = `width=${f === 1 ? '' : f}\\${unit}`;
    const kept = p.graphics.options.split(',').map(o => o.trim()).filter(o => o && !/^(width|height|scale|totalheight)\s*=/.test(o));
    const opts = [width, ...kept].join(',');
    const call = `\\includegraphics[${opts}]{${p.graphics.file}}`;
    return fig.slice(0, p.graphics.start) + call + fig.slice(p.graphics.end);
}

/** The figure with `caption` as its caption (added after the picture when it has none). */
function setCaption(fig, caption) {
    const p = figureParts(fig);
    if (p.caption) return fig.slice(0, p.caption.start) + caption + fig.slice(p.caption.end);
    const at = p.graphics ? p.graphics.end : fig.search(/\\end\s*\{/);
    const indent = /\n([ \t]*)\\includegraphics/.exec(fig)?.[1] ?? '  ';
    return fig.slice(0, at) + `\n${indent}\\caption{${caption}}` + fig.slice(at);
}

export { figureParts, setFigureWidth, setCaption };
