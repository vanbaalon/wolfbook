'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const texDir = process.env.WPAPER_EXT_ROOT
    ? path.join(process.env.WPAPER_EXT_ROOT,'out/extension/tex') : path.resolve(__dirname,'../../../tex');
const { compile } = require(path.join(texDir,'compileService'));
const { GlyphMap } = require(path.join(texDir,'glyphMap'));
const { NativeMap } = require(path.join(texDir,'nativeMap'));
const { NativeBuildLane } = require(path.join(texDir,'nativeCompileService'));
const { scanTex } = require(path.join(texDir,'texScanner'));
const { buildModel } = require(path.join(texDir,'texModel'));
const { withVscodeStub } = require('../_stub-vscode');
const { TexViewer } = withVscodeStub(() => require(path.join(texDir,'texViewer')));

const fixtureTex = String.raw`\documentclass{article}
\usepackage{amsmath}
\numberwithin{equation}{section}
\begin{document}
\setcounter{section}{2}\setcounter{equation}{60}
\begin{align}
 \psi^{\rm D}_{h,\dot h}(z,\bar z)
 &=[z]^{\{-h-s,-\dot h-\dot s\}},
 \label{eq:reference-J1-diagonal}\\
 \psi^{\rm C}_{h,\dot h}(z,\bar z)
 &=[\lambda^2-1]^{\{s,\dot s\}}
   [z-\lambda]^{\{h-s,\dot h-\dot s\}}
   [1-\lambda z]^{\{-h-s,-\dot h-\dot s\}},
 \label{eq:reference-J1-companion}
\end{align}
\end{document}
`;

const tests = [{ id:'align-label-order', name:'actual LuaLaTeX and Pro align labels appear beside the matching equation number in Shift mode',
    async run(t) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(),'wpaper-label-order-'));
        const file = path.join(dir,'paper.tex'); fs.writeFileSync(file,fixtureTex);
        const model = buildModel(scanTex(fixtureTex,{ file }),{ file });
        let lane;
        try {
            for (const [index, mode] of ['lualatex', ...(process.env.WPAPER_NATIVE_TEST_DIR ? ['native'] : [])].entries()) {
                if (mode === 'native') lane = new NativeBuildLane(file,process.env.WPAPER_NATIVE_TEST_DIR);
                const g = mode === 'native'
                    ? await lane.compile({ sourceFiles:[file],nativePages:[1],timeoutMs:60000 })
                    : await compile({ root:file,sourceFiles:[file],engine:'lualatex',glyphMap:true,
                        outDir:path.join(dir,'build'),timeoutMs:30000 });
                assert.equal(g.ok,true,JSON.stringify(g.diagnostics));
                const generation = index + 2;
                const xml = execFileSync('pdftotext',['-bbox',g.pdfPath,'-'],{ encoding:'utf8' });
                const W = Number(xml.match(/<page width="([\d.]+)"/)[1]);
                const words = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
                    .map(m => ({ x:+m[1],y:+m[2],w:+m[3]-m[1],h:+m[4]-m[2],str:m[5] }));
                const numbers = ['(2.61)','(2.62)'].map(str => words.find(w => w.str === str));
                assert.ok(numbers.every(Boolean), 'both actual equation numbers print');
                const map = mode === 'native'
                    ? new NativeMap({ generation:g,nativeView:g.nativeView,nativeSource:g.nativeSource })
                    : new GlyphMap({ generation:g });
                const viewer = Object.create(TexViewer.prototype), posted = [];
                Object.assign(viewer,{ root:file,panel:{},shownGeneration:generation,
                    coord:{ roots:new Map([[file,{ files:[file],map,generation:{ ...g,generation,pageSize:{ widthBp:W } } }]]) },
                    _projectModels:() => new Map([[file,model]]), _textReady:() => false,
                    objectRects:(_f,a,b) => map.rangeRows(file,a,b), _paperCellBoundaries:() => [],
                    _mmaChips:() => [], _copyFormat:() => 'command', _post:m => posted.push(m),
                    _log:m => { throw Error(m); } });
                await viewer._postLabels();
                const labels = posted.find(m => m.type === 'labels');
                await t.post({ type:'open',base:'/pdfjs',pdfBase64:fs.readFileSync(g.pdfPath).toString('base64'),
                    generation,pages:g.pageCount });
                await t.waitPosted('opened', m => m.generation === generation);
                if (mode === 'native') await t.post({ type:'engine',state:'live',keyMs:18 });
                await t.page.keyboard.down('Shift');
                await t.post(labels);
                const names = ['eq:reference-J1-diagonal','eq:reference-J1-companion'];
                await t.waitFor(names => names.every(name => document.querySelector(`.lbc[data-name="${name}"]`)),names,
                    { what:'both equation labels in Shift mode' });
                const boxes = await t.eval(names => names.map(name => {
                    const node = document.querySelector(`.lbc[data-name="${name}"]`);
                    return { y:parseFloat(node.style.top), h:node.offsetHeight };
                }),names);
                t.assert(boxes[0].y < boxes[1].y, `${mode}: diagonal is above companion`);
                const k = await t.pxPerBp();
                for (let i=0;i<2;i++) t.assert(Math.abs(boxes[i].y/k - numbers[i].y) < numbers[i].h,
                    `${mode}: ${names[i]} stays level with ${numbers[i].str}`);
                await t.clear();
                await t.page.locator(`.lbc[data-name="${names[0]}"]`).click();
                await t.waitPosted('copyLabel',m => m.name === names[0] && m.cmd === 'eqref');
                await t.page.mouse.move(30,20);
                await t.page.screenshot({ path:`/tmp/wpaper-align-label-order-${mode}.png` });
                await t.page.keyboard.up('Shift');
            }
        } finally { if (lane) await lane.close(); fs.rmSync(dir,{ recursive:true,force:true }); }
    },
}];
module.exports = { fixtureTex,tests };
