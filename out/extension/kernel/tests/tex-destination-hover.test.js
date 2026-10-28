'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseAux } = require('../../tex/auxLabels');
const client = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
const begin = client.indexOf('async function destinationPreview(');
const end = client.indexOf('\nasync function showPdfLinkPreview(', begin);
assert(begin > 0 && end > begin);

async function main() {
    const Module = require('module');
    const { makeVscodeStub } = require('./_stub-vscode');
    const original = Module._load;
    const stub = makeVscodeStub();
    let TexViewer;
    try {
        Module._load = function(name, ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
        ({ TexViewer } = require('../../tex/texViewer'));
    } finally { Module._load = original; }
    const posted = [];
    const owner = { panel: {}, root: 'paper.tex', shownGeneration: 1,
        coord: { roots: new Map([['paper.tex', { generation: { generation: 1 } }]]) },
        _chips: { destinations: [{ destination: 'equation.20' }] },
        _labelChips: () => [], _mmaChips: () => [], _copyFormat: () => 'command',
        _paperCellBoundaries: TexViewer.prototype._paperCellBoundaries,
        _post: m => posted.push(m) };
    await TexViewer.prototype._postLabels.call(owner);
    assert.equal(posted[0].type, 'labels');
    assert.equal(posted[0].destinations[0].destination, 'equation.20', 'destination index crosses the actual labels message');
    owner.shownGeneration = 0;
    await TexViewer.prototype._postLabels.call(owner);
    assert.equal(posted[1].destinations.length, 0, 'do not ship coordinates from a different compile');
    const labels = parseAux('\\newlabel{eq:a}{{20}{7}{}{equation.20}{}}\n' +
        '\\newlabel{app:a}{{A}{8}{}{appendix.A}{}}').labels;
    assert.equal(labels.get('eq:a').destination, 'equation.20');
    assert.equal(labels.get('app:a').destination, 'appendix.A');
    const temp = fs.mkdtempSync(path.join(require('os').tmpdir(),'wb-hover-live-'));
    try {
        const file = path.join(temp,'paper.tex');
        fs.writeFileSync(path.join(temp,'paper.aux'),'\\newlabel{eq:matrix}{{2.14}{6}{}{equation.2.14}{}}\n');
        const equation = {kind:'display-equation',label:'eq:matrix',sourceRange:{file,startLine:2,endLine:6}};
        const exact = [{page:6,x:110,y:120,w:320,h:45}];
        const viewer = Object.create(TexViewer.prototype);
        viewer.root=file; viewer.shownGeneration=1;
        viewer._projectModels=()=>new Map([[file,{objects:[equation]}]]);
        viewer._textReady=()=>false; viewer._log=()=>{};
        viewer.objectRects=()=>exact;
        const st = {files:[file],generation:{generation:1,outDir:temp,root:file,passesLimited:true},
            map:{available:true,lineRows:()=>[],objectRenderBoxes:()=>({rects:exact})}};
        viewer._labelChips(st);
        const target=viewer._chips.destinations.find(d=>d.destination==='equation.2.14');
        assert.ok(target,'one-pass live builds retain the equation destination index');
        assert.deepEqual(target.target,exact,'live hover retains tight matrix bounds');
        assert.equal(target.printed,null,'unconverged printed numbers remain suppressed');
    } finally { fs.rmSync(temp,{recursive:true,force:true}); }
    let crops = 0;
    const rect = { page: 7, x: 80, y: 100, w: 420, h: 50 };
    const entries = ['equation.20', 'equation.19', 'figure.1', 'table.1', 'appendix.A'].map((destination, i) => ({
        destination, title: destination, kind: i === 4 ? 'section-heading' : 'display-equation',
        target: [{ ...rect, y: 100 + i * 60 }],
    }));
    const doc = {
        getDestination: async dest => dest === 'missing' ? null : [6, { name: 'XYZ' }, 0, 700],
        getPage: async () => ({ getViewport: () => ({ width: 595, height: 842,
            convertToViewportPoint: (x, y) => [x, 842 - y] }) }),
    };
    const state = { doc, generation: 1, labels: { generation: 1, destinations: entries } };
    const context = vm.createContext({ state, Map, Set, JSON, Number,
        cropFragment: async o => { crops++; return { dataUrl: 'data:image/png;base64,test', rects: o.rects }; } });
    vm.runInContext('let pdfPreviewDocument=null, pdfPreviewLabels=null; const pdfPreviewCache=new Map();\n' +
        client.slice(begin, end), context);
    const resolve = dest => context.destinationPreview(dest);
    // No source text, textItems, chips, or inkMatching exist in this context.
    // A merged paragraph and split text therefore resolve identically.
    const a = await resolve('equation.20');
    const b = await resolve('equation.19');
    assert.equal(a.title, 'equation.20'); assert.equal(b.title, 'equation.19');
    assert.notEqual(a.shot.rects[0].y, b.shot.rects[0].y);
    await Promise.all([resolve('figure.1'), resolve('figure.1')]);
    assert.equal(crops, 3, 'deduplicate simultaneous crops');
    assert.match((await resolve('appendix.A')).note, /Heading and opening/);
    assert.equal((await resolve('table.1')).title, 'table.1');
    assert.match((await resolve([6, { name: 'FitH' }, 500])).note, /Destination-page excerpt/);
    state.labels = { generation: 0, destinations: entries };
    const unresolved = await resolve('equation.20');
    assert.match(unresolved.note, /Exact equation bounds unavailable/, 'stale mappings not used');
    assert.equal(unresolved.shot,null,'missing equation geometry must never show a page-wide crop');
    state.labels = { generation: 1, destinations: [{ ...entries[0], target: [rect, { ...rect, page: 8 }] }] };
    assert.match((await resolve('equation.20')).note, /First target page/);
    state.labels = { generation: 1, destinations: [entries[0], { ...entries[0], target: [{ ...rect, y: 500 }] }] };
    assert.match((await resolve('equation.20')).note, /Exact equation bounds unavailable/, 'ambiguous aliases are not guessed');
    await assert.rejects(resolve('missing'), /Destination unavailable/);
    const oldPage = doc.getPage;
    doc.getDestinations = async () => ({'cite.first':[6,{name:'XYZ'},0,700],
        'cite.second':[6,{name:'XYZ'},0,650],'cite.third':[6,{name:'XYZ'},0,600]});
    doc.getPage = async () => ({getViewport:()=>({width:595,height:842,
        convertToViewportPoint:(x,y)=>[x,842-y]}),getTextContent:async()=>({items:[
        {str:'[1] Author',transform:[10,0,0,10,80,690],width:100},
        {str:'Title and publication',transform:[10,0,0,10,95,675],width:300},
        {str:'[2] Unrelated next reference',transform:[10,0,0,10,80,640],width:400},
        {str:'[3] Another reference',transform:[10,0,0,10,80,590],width:400},
    ]})});
    const citation = await resolve('cite.first');
    assert.equal(citation.citation,true);
    assert.equal(citation.heading,'Citation');
    assert.equal(citation.shot.rects[0].x,80,'trim bibliography margins');
    assert.equal(citation.shot.rects[0].w,315);
    assert.ok(citation.shot.rects[0].y+citation.shot.rects[0].h<192,'exclude the second and third references');
    doc.getPage = oldPage;
    context.cropFragment = async () => { state.generation++; return { dataUrl: 'old' }; };
    assert.equal(await resolve('uncached'), null, 'recompile during crop discards old result');
    const nodes = [];
    const node = tag => {
        const n = { tag, style: {}, children: [], attrs: {}, offsetWidth: 220, offsetHeight: 90,
            setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {},
            appendChild(c) { this.children.push(c); } };
        nodes.push(n); return n;
    };
    context.document = { createElement: node, createElementNS: (_, tag) => node(tag), body: node('body') };
    context.window = { innerWidth: 800, innerHeight: 600 };
    context.clearTimeout = () => {};
    const cardStart = client.indexOf('function showDestinationCard(');
    vm.runInContext(client.slice(cardStart, client.indexOf("\nwindow.addEventListener('keydown'", cardStart)), context);
    context.showDestinationCard({ title: 'eq:long-machine-label', heading: 'Equation 16',
        note: 'Target preview · p.7', shot: { dataUrl: 'image', w: 160, h: 30 } },
    { getBoundingClientRect: () => ({ left: 750, top: 550, bottom: 570 }) });
    assert.equal(nodes.find(n => n.tag === 'img').style.width, '160px', 'short equations are never enlarged');
    assert.equal(nodes.find(n => n.tag === 'img').style.height, '30px', 'natural aspect ratio is reserved before decode');
    assert.equal(nodes.some(n => n.tag === 'small'), false, 'normal previews have no redundant footer');
    assert.equal(nodes.find(n => n.tag === 'button').attrs['aria-label'], 'Open target');
    assert(nodes.some(n => n.tag === 'svg'), 'navigation is a vector icon');
    nodes.length=0;
    state.scale=2;
    context.showDestinationCard({title:'Citation',heading:'Citation',citation:true,
        shot:{dataUrl:'image',w:400,h:45}},
        {getBoundingClientRect:()=>({left:20,top:100,bottom:120})});
    assert.equal(nodes.find(n=>n.tag==='img').style.width,'680px','citations use a readable wider preview instead of shrinking to 380px');
    const cancelled = [], removed = [];
    const scrollContext = vm.createContext({
        clearTimeout: id => cancelled.push(id),
        document:{querySelectorAll:()=>[{remove:()=>removed.push(true)}]},
    });
    const dismissStart = client.indexOf('function dismissPreviewsOnScroll(');
    const hideStart = client.indexOf('function hideChipPreview(');
    vm.runInContext('let pdfHoverTimer=11,pdfCloseTimer=12,hoveredPdfLink={},pdfHoverPoint={x:10,y:20},previewSeq=4;\n'+
        client.slice(dismissStart,client.indexOf('\nfunction showDestinationCard(',dismissStart))+
        client.slice(hideStart,client.indexOf('/** Scroll a hunk',hideStart)),scrollContext);
    scrollContext.dismissPreviewsOnScroll();
    assert.deepEqual(cancelled,[11,12],'scroll cancels delayed hover and close timers');
    assert.equal(removed.length,1,'visible popup disappears without pointer movement');
    assert.equal(vm.runInContext('previewSeq',scrollContext),5,'late crop cannot resurrect the popup');
    assert.equal(vm.runInContext('hoveredPdfLink',scrollContext),null);
    assert.equal(vm.runInContext('pdfHoverPoint',scrollContext),null,'page rerender cannot reopen under a stationary pointer');
    assert.match(client,/main\.addEventListener\('scroll', \(\) => \{\s*dismissPreviewsOnScroll\(\)/,
        'keyboard, scrollbar, touch and programmatic scrolling all dismiss previews');
    console.log('destination hover: labels, merged text independence, all target kinds, cache, fallback, generation races OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
