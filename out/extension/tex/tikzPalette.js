'use strict';
// THE PICTURE EDITOR'S PALETTE: what each tool and catalogue item writes.
//
// Every item is data plus a builder. `kind` says how the viewer collects its
// geometry: `drag` (two points), `point` (one click), `points` (clicks ended
// by a double-click), `edge` (a node, then another), `insert` (catalogue text
// with • placeholders, placed at the end of the picture). Builders take
// picture coordinates in the picture's units (cm unless the picture scales)
// and return source lines. `needs` is what the preamble must load; `feynman`
// items go inside the picture's feynman environment.
//
// The catalogue's organisation follows KtikZ's Insert menu (KtikZ, by Florian
// Hackenberger and Glad Deschrijver — https://github.com/fhackenberger/ktikz;
// inspiration only, no code or data was taken). Feynman items write
// tikz-feynman (Joshua Ellis); super Dynkin items use WPaper's own styles
// following the conventions of Kac and of Frappat, Sciarrino and Sorba.
// See ACKNOWLEDGEMENTS.md.

const { num } = require('./tikzModel');

const at = p => `(${num(p[0])},${num(p[1])})`;
const nodeText = s => String(s ?? '').trim();

/** A drawn line between two points with extra options. */
const drag = (id, label, icon, build, extra = {}) => ({ id, label, icon, kind: 'drag', build, ...extra });
const point = (id, label, icon, build, extra = {}) => ({ id, label, icon, kind: 'point', names: true, build, ...extra });
const edge = (id, label, icon, build, extra = {}) => ({ id, label, icon, kind: 'edge', build, ...extra });

const FEYNMAN_EDGES = [
    ['fermion', 'Fermion'], ['anti fermion', 'Anti-fermion'], ['photon', 'Photon'], ['gluon', 'Gluon'],
    ['scalar', 'Scalar'], ['charged scalar', 'Charged scalar'], ['ghost', 'Ghost'], ['boson', 'Boson'],
    ['charged boson', 'Charged boson'], ['majorana', 'Majorana'], ['plain', 'Plain'],
];
const FEYNMAN_VERTICES = [
    ['', 'Vertex', 'feyn-vertex'], ['dot', 'Dot', 'feyn-dot'], ['empty dot', 'Empty dot', 'feyn-empty-dot'],
    ['crossed dot', 'Crossed dot', 'feyn-crossed-dot'], ['square dot', 'Square dot', 'feyn-square-dot'],
    ['blob', 'Blob', 'feyn-blob'],
];

const ITEMS = [
    // Draw
    drag('line', 'Line', 'tz-line', ({ a, b }) => [`\\draw ${at(a)} -- ${at(b)};`], { section: 'draw' }),
    drag('arrow', 'Arrow', 'tz-arrow', ({ a, b }) => [`\\draw[->] ${at(a)} -- ${at(b)};`], { section: 'draw' }),
    drag('rect', 'Rectangle', 'tz-rect', ({ a, b }) => [`\\draw ${at(a)} rectangle ${at(b)};`], { section: 'draw' }),
    drag('circle', 'Circle (from its centre)', 'tz-circle', ({ a, b }) => {
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return r > 0 ? [`\\draw ${at(a)} circle (${num(r)});`] : null;
    }, { section: 'draw' }),
    drag('ellipse', 'Ellipse (from its centre)', 'tz-ellipse', ({ a, b }) => {
        const rx = Math.abs(b[0] - a[0]), ry = Math.abs(b[1] - a[1]);
        return rx > 0 && ry > 0 ? [`\\draw ${at(a)} ellipse (${num(rx)} and ${num(ry)});`] : null;
    }, { section: 'draw' }),
    drag('bezier', 'Curve', 'tz-bezier', ({ a, b }) => {
        const dx = b[0] - a[0], dy = b[1] - a[1], k = 0.35;
        const c1 = [a[0] + dx / 3 - dy * k, a[1] + dy / 3 + dx * k], c2 = [a[0] + 2 * dx / 3 - dy * k, a[1] + 2 * dy / 3 + dx * k];
        return [`\\draw ${at(a)} .. controls ${at(c1)} and ${at(c2)} .. ${at(b)};`];
    }, { section: 'draw' }),
    drag('grid', 'Grid', 'tz-grid', ({ a, b }) => [`\\draw[step=0.5, gray!40, very thin] ${at(a)} grid ${at(b)};`], { section: 'draw' }),
    { id: 'polyline', label: 'Polyline (double-click ends it)', icon: 'tz-polyline', kind: 'points', section: 'draw',
        build: ({ points }) => points.length > 1 ? [`\\draw ${points.map(at).join(' -- ')};`] : null },
    // Nodes
    point('text', 'Text', 'tz-text', ({ a, name, text }) => [`\\node (${name}) at ${at(a)} {${nodeText(text)}};`], { section: 'nodes', text: true, prefix: 'n' }),
    point('circle-node', 'Circle node', 'tz-circle-node', ({ a, name, text }) => [`\\node[circle, draw] (${name}) at ${at(a)} {${nodeText(text)}};`], { section: 'nodes', prefix: 'n' }),
    point('box-node', 'Box node', 'tz-box-node', ({ a, name, text }) => [`\\node[draw] (${name}) at ${at(a)} {${nodeText(text)}};`], { section: 'nodes', text: true, prefix: 'n' }),
    point('dot', 'Point', 'tz-dot', ({ a, name }) => [`\\node[circle, fill, inner sep=1.2pt] (${name}) at ${at(a)} {};`], { section: 'nodes', prefix: 'p' }),
    point('coordinate', 'Coordinate', 'tz-coordinate', ({ a, name }) => [`\\coordinate (${name}) at ${at(a)};`], { section: 'nodes', prefix: 'c' }),
    // Edges
    edge('edge', 'Edge', 'tz-edge', ({ from, to }) => [`\\draw (${from}) -- (${to});`], { section: 'edges' }),
    edge('edge-arrow', 'Arrow edge', 'tz-edge-arrow', ({ from, to }) => [`\\draw[->] (${from}) -- (${to});`], { section: 'edges' }),
    edge('edge-both', 'Two-headed edge', 'tz-edge-both', ({ from, to }) => [`\\draw[<->] (${from}) -- (${to});`], { section: 'edges' }),
    edge('edge-dashed', 'Dashed edge', 'tz-edge-dashed', ({ from, to }) => [`\\draw[dashed] (${from}) -- (${to});`], { section: 'edges' }),
    edge('edge-dotted', 'Dotted edge', 'tz-edge-dotted', ({ from, to }) => [`\\draw[dotted] (${from}) -- (${to});`], { section: 'edges' }),
    edge('edge-double', 'Double edge', 'tz-edge-double', ({ from, to }) => [`\\draw[double] (${from}) -- (${to});`], { section: 'edges' }),
    edge('edge-bend-left', 'Bend left', 'tz-edge-bend-left', ({ from, to }) => [`\\draw (${from}) to[bend left] (${to});`], { section: 'edges' }),
    edge('edge-bend-right', 'Bend right', 'tz-edge-bend-right', ({ from, to }) => [`\\draw (${from}) to[bend right] (${to});`], { section: 'edges' }),
    // Feynman (tikz-feynman)
    ...FEYNMAN_VERTICES.map(([style, label, icon]) => point(`feyn-${style || 'vertex'}`.replace(/ /g, '-'), label, icon,
        ({ a, name }) => [`\\vertex${style ? ` [${style}]` : ''} (${name}) at ${at(a)}${style ? ' {}' : ''};`],
        { section: 'feynman', feynman: true, needs: { feynman: true }, prefix: 'v' })),
    point('feyn-particle', 'Particle label', 'feyn-particle', ({ a, name, text }) => [`\\vertex (${name}) at ${at(a)} {\\(${nodeText(text) || 'e^{-}'}\\)};`],
        { section: 'feynman', feynman: true, needs: { feynman: true }, prefix: 'v', text: true }),
    ...FEYNMAN_EDGES.map(([style, label]) => edge(`feyn-${style.replace(/ /g, '-')}`, label, `feyn-${style.replace(/ /g, '-')}`,
        ({ from, to, momentum }) => [`\\diagram* { (${from}) -- [${style}${momentum ? `, momentum=\\(${momentum}\\)` : ''}] (${to}) };`],
        { section: 'feynman', feynman: true, needs: { feynman: true } })),
    // Super Dynkin diagrams (WPaper styles)
    point('dynkin-even', 'Even root ○', 'dyn-even', ({ a, name }) => [`\\node[dynkin even] (${name}) at ${at(a)} {};`], { section: 'dynkin', needs: { dynkin: true }, prefix: 'r' }),
    point('dynkin-iso', 'Odd isotropic root ⊗ (grey)', 'dyn-iso', ({ a, name }) => [`\\node[dynkin iso] (${name}) at ${at(a)} {};`], { section: 'dynkin', needs: { dynkin: true }, prefix: 'r' }),
    point('dynkin-iso-white', 'Odd isotropic root ⊗ (white)', 'dyn-iso-white', ({ a, name }) => [`\\node[dynkin iso white] (${name}) at ${at(a)} {};`], { section: 'dynkin', needs: { dynkin: true }, prefix: 'r' }),
    point('dynkin-odd', 'Odd non-isotropic root ●', 'dyn-odd', ({ a, name }) => [`\\node[dynkin odd] (${name}) at ${at(a)} {};`], { section: 'dynkin', needs: { dynkin: true }, prefix: 'r' }),
    edge('dynkin-single', 'Single bond', 'dyn-single', ({ from, to }) => [`\\draw (${from}) -- (${to});`], { section: 'dynkin', needs: { dynkin: true } }),
    edge('dynkin-double', 'Double bond, arrow →', 'dyn-double', ({ from, to }) => [`\\draw[dynkin double] (${from}) -- (${to});`], { section: 'dynkin', needs: { dynkin: true } }),
    edge('dynkin-double-reversed', 'Double bond, arrow ←', 'dyn-double-rev', ({ from, to }) => [`\\draw[dynkin double reversed] (${from}) -- (${to});`], { section: 'dynkin', needs: { dynkin: true } }),
    edge('dynkin-triple', 'Triple bond, arrow →', 'dyn-triple', ({ from, to }) => [`\\draw[dynkin triple] (${from}) -- (${to});`], { section: 'dynkin', needs: { dynkin: true } }),
    edge('dynkin-triple-reversed', 'Triple bond, arrow ←', 'dyn-triple-rev', ({ from, to }) => [`\\draw[dynkin triple reversed] (${from}) -- (${to});`], { section: 'dynkin', needs: { dynkin: true } }),
    edge('dynkin-indefinite', 'Indefinite bond (dashed)', 'dyn-indefinite', ({ from, to }) => [`\\draw[dynkin indefinite] (${from}) -- (${to});`], { section: 'dynkin', needs: { dynkin: true } }),
];

/** Mutually exclusive option groups for the Style section. */
const STYLE_GROUPS = {
    width: ['ultra thin', 'very thin', 'thin', 'semithick', 'thick', 'very thick', 'ultra thick'],
    dash: ['solid', 'dashed', 'dotted', 'dash dot', 'densely dashed', 'loosely dashed'],
    arrows: ['-', '->', '<-', '<->', '-{Stealth}', '{Stealth}-{Stealth}', '-|', '|-|'],
};
const COLORS = ['black', 'red', 'blue', 'green!60!black', 'orange', 'violet', 'gray', 'white'];

/**
 * Curated colour sets for the Style section. A colour is written by name
 * (`wpIndigo`, fills as tints `wpIndigo!25`) and defined once in the preamble
 * (`\definecolor{wpIndigo}{HTML}{4F46E5}`). Sources, credited in
 * ACKNOWLEDGEMENTS.md: the Tailwind CSS palette (Tailwind Labs, MIT), the
 * Okabe–Ito colour-universal-design palette (M. Okabe and K. Ito, 2002) and
 * Nord (Arctic Ice Studio / Sven Greb, MIT).
 */
const COLOR_SETS = [
    { id: 'modern', label: 'Modern', colors: [
        ['wpIndigo', '4F46E5'], ['wpViolet', '7C3AED'], ['wpSky', '0EA5E9'], ['wpTeal', '14B8A6'], ['wpEmerald', '10B981'],
        ['wpLime', '84CC16'], ['wpAmber', 'F59E0B'], ['wpCoral', 'F97360'], ['wpRose', 'F43F5E'], ['wpFuchsia', 'D946EF'],
        ['wpSlate', '475569'], ['wpInk', '0F172A']] },
    { id: 'okabe-ito', label: 'Colour-blind safe (Okabe–Ito)', colors: [
        ['wpOIOrange', 'E69F00'], ['wpOISky', '56B4E9'], ['wpOIGreen', '009E73'], ['wpOIYellow', 'F0E442'],
        ['wpOIBlue', '0072B2'], ['wpOIVermilion', 'D55E00'], ['wpOIPurple', 'CC79A7'], ['wpOIBlack', '000000']] },
    { id: 'nord', label: 'Nord (cool)', colors: [
        ['wpNordFrost1', '8FBCBB'], ['wpNordFrost2', '88C0D0'], ['wpNordFrost3', '81A1C1'], ['wpNordFrost4', '5E81AC'],
        ['wpNordRed', 'BF616A'], ['wpNordOrange', 'D08770'], ['wpNordYellow', 'EBCB8B'], ['wpNordGreen', 'A3BE8C'],
        ['wpNordPurple', 'B48EAD'], ['wpNordNight', '2E3440']] },
    { id: 'pastel', label: 'Pastel', colors: [
        ['wpPastelBlue', 'A5C8FF'], ['wpPastelMint', 'A8E6CF'], ['wpPastelLemon', 'FDFD96'], ['wpPastelPeach', 'FFCBA4'],
        ['wpPastelPink', 'FFB3C6'], ['wpPastelLilac', 'CDB4DB'], ['wpPastelSage', 'B5CDA3'], ['wpPastelSand', 'E9DCC9']] },
];
const COLOR_HEX = new Map(COLOR_SETS.flatMap(set => set.colors));

/**
 * The colour definitions a style value needs: a palette colour (`wpTeal`,
 * `wpTeal!25`) or a custom one (`#12ab34` becomes `wpC12AB34`). Returns
 * `{value, needs}` with the value to write.
 */
function colorValue(value) {
    if (value == null) return { value, needs: null };
    const custom = /^#([0-9a-fA-F]{6})$/.exec(value);
    if (custom) { const name = `wpC${custom[1].toUpperCase()}`; return { value: name, needs: { colors: [[name, custom[1].toUpperCase()]] } }; }
    const base = String(value).split('!')[0];
    return COLOR_HEX.has(base) ? { value, needs: { colors: [[base, COLOR_HEX.get(base)]] } } : { value, needs: null };
}

/** A Style action as `{key, value, replaces}` for tikzModel.setOptionEdit. */
function styleOption(group, value) {
    if (group === 'color') return { key: 'color', value, replaces: ['draw'] };
    if (group === 'fill') return value ? { key: 'fill', value, replaces: [] } : { key: 'fill', value: null, replaces: [] };
    if (group === 'opacity') return { key: 'opacity', value: value === 1 ? null : value, replaces: [] };
    const all = STYLE_GROUPS[group];
    if (!all) return null;
    const replaces = all.filter(k => k !== value);
    if (group === 'width') replaces.push('line width');
    if (group === 'dash') replaces.push('dash pattern');
    // Plain lines and solid strokes are the absence of the option.
    const bare = (group === 'dash' && value === 'solid') || (group === 'arrows' && value === '-');
    return { key: value, value: bare ? null : true, replaces };
}

/** The KtikZ-style Insert catalogue: sections of snippets with • placeholders. */
const CATALOGUE = [
    ['Paths', [
        ['Line to', '\\draw (•,•) -- (•,•);'], ['Horizontal then vertical', '\\draw (•,•) -| (•,•);'],
        ['Closed polygon', '\\draw (•,•) -- (•,•) -- (•,•) -- cycle;'], ['Curve with controls', '\\draw (•,•) .. controls (•,•) and (•,•) .. (•,•);'],
        ['Curve with angles', '\\draw (•,•) to[out=•,in=•] (•,•);'], ['Arc', '\\draw (•,•) arc [start angle=•, end angle=•, radius=•];'],
        ['Rounded rectangle', '\\draw[rounded corners=•] (•,•) rectangle (•,•);'], ['Parabola', '\\draw (•,•) parabola (•,•);'],
        ['Sine', '\\draw (•,•) sin (•,•) cos (•,•);'], ['Grid', '\\draw[step=•] (•,•) grid (•,•);'],
    ]],
    ['Draw and fill', [
        ['Fill', '\\fill[•] (•,•) rectangle (•,•);'], ['Fill and draw', '\\filldraw[fill=•, draw=•] (•,•) circle (•);'],
        ['Shade', '\\shade[left color=•, right color=•] (•,•) rectangle (•,•);'], ['Clip', '\\clip (•,•) rectangle (•,•);'],
        ['Line width', '\\draw[line width=•] (•,•) -- (•,•);'], ['Dash pattern', '\\draw[dash pattern=on • off •] (•,•) -- (•,•);'],
        ['Arrow tips', '\\draw[-{Stealth[length=•]}] (•,•) -- (•,•);'], ['Double line', '\\draw[double, double distance=•] (•,•) -- (•,•);'],
    ]],
    ['Nodes', [
        ['Node', '\\node[•] (•) at (•,•) {•};'], ['Node on a path', '\\draw (•,•) -- node[above] {•} (•,•);'],
        ['Node with label', '\\node[draw, label=above:•] (•) at (•,•) {•};'], ['Node with pin', '\\node[pin=•:•] at (•,•) {•};'],
        ['Anchored node', '\\node[anchor=•] at (•,•) {•};'], ['Minimum size', '\\node[draw, minimum size=•] at (•,•) {•};'],
        ['Two-line node', '\\node[align=center] at (•,•) {• \\\\ •};'],
    ]],
    ['Positioning and coordinates', [
        ['Relative move', '\\draw (•,•) -- ++(•,•);'], ['Polar coordinate', '\\draw (0,0) -- (•:•);'],
        ['Named anchor', '\\draw (•.north) -- (•.south);'], ['Midway point', '\\draw (•,•) -- node[midway, sloped, above] {•} (•,•);'],
        ['Calc (needs calc)', '\\draw ($(•)!0.5!(•)$) circle (•);'],
    ]],
    ['Loops and repeats', [
        ['Foreach', '\\foreach \\x in {•,•,...,•} { \\draw (\\x,0) circle (•); }'], ['Foreach pairs', '\\foreach \\x/\\y in {•/•, •/•} { \\node at (\\x,\\y) {•}; }'],
    ]],
    ['Scopes and styles', [
        ['Scope', '\\begin{scope}[•]\n  •\n\\end{scope}'], ['Shifted scope', '\\begin{scope}[shift={(•,•)}]\n  •\n\\end{scope}'],
        ['Style', '\\tikzset{•/.style={•}}'],
    ]],
    ['Transformations (options)', [
        ['Shift', '\\draw[shift={(•,•)}] •;'], ['Rotate', '\\draw[rotate=•] •;'], ['Rotate around', '\\draw[rotate around={•:(•,•)}] •;'],
        ['Scale', '\\draw[scale=•] •;'], ['Slant', '\\draw[xslant=•] •;'],
    ]],
    ['Plots', [
        ['Function', '\\draw[domain=•:•, samples=•, smooth] plot (\\x, {•});'], ['Coordinates', '\\draw plot[mark=*] coordinates {(•,•) (•,•) (•,•)};'],
    ]],
    ['Decorations', [
        ['Snake', '\\draw[decorate, decoration={snake, amplitude=•, segment length=•}] (•,•) -- (•,•);'],
        ['Coil', '\\draw[decorate, decoration={coil, aspect=•}] (•,•) -- (•,•);'],
        ['Brace', '\\draw[decorate, decoration={brace, amplitude=•}] (•,•) -- (•,•) node[midway, above] {•};'],
        ['Arrow mid-way', '\\draw[postaction={decorate}, decoration={markings, mark=at position 0.5 with {\\arrow{>}}}] (•,•) -- (•,•);'],
    ]],
    ['Matrices and trees', [
        ['Matrix of nodes', '\\matrix[matrix of nodes, column sep=•, row sep=•] { • & • \\\\ • & • \\\\ };'],
        ['Tree', '\\node {•} child {node {•}} child {node {•}};'],
    ]],
];
/** Libraries catalogue items need, by the text they use. */
function catalogueNeeds(text) {
    const libraries = [];
    if (/decoration=\{(snake|coil|zigzag)/.test(text)) libraries.push('decorations.pathmorphing');
    if (/decoration=\{brace/.test(text)) libraries.push('decorations.pathreplacing');
    if (/markings/.test(text)) libraries.push('decorations.markings');
    if (/Stealth/.test(text)) libraries.push('arrows.meta');
    if (/\$\(/.test(text)) libraries.push('calc');
    if (/matrix of nodes/.test(text)) libraries.push('matrix');
    return { tikz: true, libraries };
}

/** New-picture templates: the whole environment, and what it needs. */
const TEMPLATES = [
    { id: 'empty', label: 'Empty picture', needs: { tikz: true },
        lines: ['\\begin{tikzpicture}', '  \\draw (0,0) -- (2,0);', '\\end{tikzpicture}'] },
    { id: 'feynman', label: 'Feynman diagram (e⁺e⁻ → μ⁺μ⁻)', needs: { feynman: true }, lines: [
        '\\begin{tikzpicture}', '  \\begin{feynman}',
        '    \\vertex (a) at (0,1) {\\(e^{-}\\)};', '    \\vertex (b) at (0,-1) {\\(e^{+}\\)};',
        '    \\vertex (c) at (1.5,0);', '    \\vertex (d) at (3,0);',
        '    \\vertex (e) at (4.5,1) {\\(\\mu^{-}\\)};', '    \\vertex (f) at (4.5,-1) {\\(\\mu^{+}\\)};',
        '    \\diagram* { (a) -- [fermion] (c) };', '    \\diagram* { (c) -- [fermion] (b) };',
        '    \\diagram* { (c) -- [photon, momentum=\\(q\\)] (d) };',
        '    \\diagram* { (f) -- [fermion] (d) };', '    \\diagram* { (d) -- [fermion] (e) };',
        '  \\end{feynman}', '\\end{tikzpicture}'] },
    { id: 'dynkin', label: 'Super Dynkin diagram A(m|n)', needs: { dynkin: true }, lines: [
        '\\begin{tikzpicture}',
        '  \\node[dynkin even, label=below:$\\alpha_1$] (r1) at (0,0) {};',
        '  \\node[dynkin even, label=below:$\\alpha_2$] (r2) at (1,0) {};',
        '  \\node[dynkin iso, label=below:$\\alpha_3$] (r3) at (2,0) {};',
        '  \\node[dynkin even, label=below:$\\alpha_4$] (r4) at (3,0) {};',
        '  \\node[dynkin even, label=below:$\\alpha_5$] (r5) at (4,0) {};',
        '  \\draw (r1) -- (r2);', '  \\draw (r2) -- (r3);', '  \\draw (r3) -- (r4);', '  \\draw (r4) -- (r5);',
        '\\end{tikzpicture}'] },
    { id: 'tikzcd', label: 'Commutative diagram (tikz-cd)', needs: { packages: ['tikz-cd'] }, lines: [
        '\\begin{tikzcd}', '  A \\arrow[r, "f"] \\arrow[d, "g"\'] & B \\arrow[d, "h"] \\\\',
        '  C \\arrow[r, "k"\'] & D', '\\end{tikzcd}'] },
];

const byId = new Map(ITEMS.map(item => [item.id, item]));

module.exports = { ITEMS, byId, STYLE_GROUPS, COLORS, COLOR_SETS, colorValue, styleOption, CATALOGUE, catalogueNeeds, TEMPLATES };
