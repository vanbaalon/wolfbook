'use strict';
// Real compiler/cache/ship regression: the TeX bytes stay identical while an
// external writer replaces a nested PNG. No original paper is touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { makeVscodeStub, withVscodeStub } = require('./_stub-vscode');
const ext = process.env.WPAPER_EXT_ROOT || path.resolve(__dirname,'../../../..');
const tex = name => path.join(ext,'out/extension/tex',name);
const { snapshotSources, loadGeneration } = require(tex('compileService'));
let mode;
const stub = makeVscodeStub({ workspace:{ textDocuments:[],
    getConfiguration:()=>({ get:(key,fallback)=>({ mapEngine:mode === 'Pro' ? 'wlatex' : 'off',
        engine:'pdflatex', wlatexDirectory:process.env.WPAPER_NATIVE_TEST_DIR,
        liveSinglePass:false, compileTimeoutMs:60000 }[key] ?? fallback) }) } });
const { RenderCoordinator } = withVscodeStub(()=>require(tex('renderUi')),stub);
const { TexViewer } = withVscodeStub(()=>require(tex('texViewer')),stub);
function png(color) {
    const chunk = (name, data) => {
        const bytes = Buffer.concat([Buffer.from(name),data]); let crc = 0xffffffff;
        for (const value of bytes) { crc ^= value; for (let i=0;i<8;i++) crc = crc & 1 ? (crc>>>1)^0xedb88320 : crc>>>1; }
        const head = Buffer.alloc(4), tail = Buffer.alloc(4);
        head.writeUInt32BE(data.length); tail.writeUInt32BE((crc^0xffffffff)>>>0);
        return Buffer.concat([head,bytes,tail]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(32,0); header.writeUInt32BE(32,4); header[8]=8; header[9]=2;
    const pixels = Buffer.alloc(32*97);
    for (let y=0;y<32;y++) for (let x=0;x<32;x++) pixels.set(color,y*97+1+x*3);
    return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
let standard = true;
try { execFileSync('latexmk',['--version'],{stdio:'ignore'}); } catch (_) { standard=false; }
for (const selected of ['standard','Pro']) test(`${selected}: an externally replaced image rebuilds and ships without changing TeX`,
    { skip:selected === 'standard' ? !standard : !process.env.WPAPER_NATIVE_TEST_DIR },async () => {
        mode=selected;
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wpaper-image-refresh-'));
        const root=path.join(dir,'paper.tex'), image=path.join(dir,'figures','plot.png');
        fs.mkdirSync(path.dirname(image)); fs.writeFileSync(image,png([230,30,30]));
        const source='\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nExternal figure: \\includegraphics[width=4cm]{figures/plot}\n\\end{document}\n';
        fs.writeFileSync(root,source);
        const output={appendLine:()=>{}};
        const coord=new RenderCoordinator({},output), doc={uri:stub.Uri.file(root)};
        // These previews are independent of the settled PDF being tested.
        coord._previewFirstOpen=()=>{}; coord._warmLiveAfterSettle=()=>{};
        const viewer=new TexViewer({extensionUri:stub.Uri.file(ext)},coord,{}), posted=[];
        viewer.root=root; viewer._webviewReady=true;
        viewer.panel={ title:'',webview:{ asWebviewUri:u=>u,postMessage:m=>{posted.push(m);return Promise.resolve(true);} } };
        viewer.syncFromEditor=()=>{}; viewer._postEditAnchor=async()=>{};
        try {
            coord.rootFor(doc); coord.invalidateAsset(root,image);
            let st=await coord.build(doc,{quiet:true});
            assert.equal(st.generation?.ok,true,st.lastError);
            assert.equal(st.generation.runner,selected === 'Pro' ? 'wlatex' : 'latexmk');
            const first=st.generation, oldBytes=fs.readFileSync(first.pdfPath);
            await viewer.refresh();
            const opens=()=>posted.filter(m=>m.type==='open');
            assert.equal(opens().length,1);
            // Atomic rename, the usual agent/plot-generator save pattern.
            fs.writeFileSync(image+'.new',png([30,40,230])); fs.renameSync(image+'.new',image);
            coord.invalidateAsset(root,image);
            assert.equal(coord.isCurrent(st,snapshotSources([root])),false);
            st=await coord.build(doc,{live:true,quiet:true});
            assert.equal(st.generation.ok,true,st.lastError);
            assert.notEqual(st.generation.generation,first.generation);
            assert.notEqual(st.generation.pdfHash,first.pdfHash,'the replacement image changes the PDF');
            assert.notDeepEqual(fs.readFileSync(st.generation.pdfPath),oldBytes);
            assert.equal(st.sourceAhead,false,'the automatic build clears the stale state');
            await viewer.refresh();
            assert.equal(opens().length,2,'the changed PDF actually crosses to the viewer');
            if (selected === 'Pro') assert.notDeepEqual(opens()[0].nativePageHashes,opens()[1].nativePageHashes,
                'the image page cannot reuse the old rendered canvas');
            const latest=st.generation;
            await coord.build(doc,{live:true,quiet:true});
            assert.equal(st.generation,latest,'unchanged inputs still reuse the generation');
            assert.equal(fs.readFileSync(root,'utf8'),source);
            if (selected === 'standard') {
                assert.ok(loadGeneration(root,{sourceFiles:[root]}),'the fresh PDF restores normally');
                fs.writeFileSync(image,png([20,220,40]));
                assert.equal(loadGeneration(root,{sourceFiles:[root]}),null,'an image edit while closed invalidates the persisted cache');
            }
        } finally {
            viewer.panel=null;
            const lane=coord.roots.get(root)?.nativeLane;
            coord.dispose(); if (lane) await lane.close();
            fs.rmSync(dir,{recursive:true,force:true});
        }
    });
