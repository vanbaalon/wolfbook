'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const texDir = process.env.WPAPER_EXT_ROOT
    ? path.join(process.env.WPAPER_EXT_ROOT,'out','extension','tex') : path.resolve(__dirname,'../../tex');
const { compile } = require(path.join(texDir,'compileService'));
const { GlyphMap } = require(path.join(texDir,'glyphMap'));
const { withVscodeStub } = require('./_stub-vscode');
const { TexViewer } = withVscodeStub(() => require(path.join(texDir,'texViewer')));
let toolchain = true;
try { for (const command of ['latexmk','lualatex']) execFileSync(command,['--version'],{stdio:'ignore'}); }
catch (_) { toolchain = false; }

test('saving identical live ink refreshes source paths instead of reusing the deleted build copy', { skip:!toolchain }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'wpaper-source-cache-'));
    const root = path.join(dir,'paper.tex'), child = path.join(dir,'sections','body.tex');
    fs.mkdirSync(path.dirname(child));
    const disk = '\\documentclass{article}\n\\begin{document}\nSaved opening.\n\n\\input{sections/body}\n\\end{document}\n';
    const typed = disk.replace('Saved','Unsaved'), typedChild = 'Changed child paragraph.\n';
    fs.writeFileSync(root,disk); fs.writeFileSync(child,'Child paragraph.\n');
    const options = { root,sourceFiles:[root,child],engine:'lualatex',glyphMap:true,timeoutMs:30000,
        outDir:path.join(dir,'build') };
    try {
        const live = await compile({ ...options, overlay:new Map([[root,typed],[child,typedChild]]) });
        assert.equal(live.ok,true,JSON.stringify(live.diagnostics));
        assert.ok(live.glyphMapHash);
        const previous = new GlyphMap({ generation:live });
        const liveGlyphs = fs.readFileSync(live.glyphMapPath), liveMeta = fs.readFileSync(live.glyphMapMetaPath);
        assert.ok(previous.lineRows(root,3).length);
        assert.ok(previous.lineRows(child,1).length);
        fs.writeFileSync(root,typed); fs.writeFileSync(child,typedChild);
        const saved = await compile(options);
        assert.equal(saved.ok,true,JSON.stringify(saved.diagnostics));
        assert.equal(saved.overlayDir,null);
        assert.ok(!fs.existsSync(live.overlayDir), 'saving removes the private build sources');
        assert.deepEqual(fs.readFileSync(saved.glyphMapPath),liveGlyphs, 'printed glyph geometry is unchanged');
        assert.notDeepEqual(fs.readFileSync(saved.glyphMapMetaPath),liveMeta, 'the same glyphs now come from real files');
        assert.notEqual(saved.glyphMapHash,live.glyphMapHash, 'cache identity includes the source paths and font metadata');
        // This is the coordinator's reuse gate: its decision must not admit
        // the raw document whose file table still names _wblive.
        const map = new GlyphMap({ generation:saved,
            glyphDoc:saved.glyphMapHash === live.glyphMapHash ? previous.gm : null });
        const viewer = Object.create(TexViewer.prototype);
        for (const [file,line] of [[root,3],[child,1]]) {
            const row = map.lineRows(file,line)[0];
            assert.ok(row, 'forward search uses the original source file');
            const hit = viewer._resolvePoint({ map },{ page:row.page,xBp:row.x + row.w/2,yTopBp:row.y + row.h/2 });
            assert.equal(hit.file,file,'right-click opens the actual project file');
            assert.ok(fs.existsSync(hit.file),'the editor target exists after the private copy has been removed');
        }
        assert.ok(![...map._pathByFileId.values()].some(f => f.includes('_wblive')));
        const unchanged = await compile({ ...options,force:true });
        assert.equal(unchanged.ok,true);
        assert.equal(unchanged.glyphMapHash,saved.glyphMapHash,'unchanged source paths and glyphs still permit efficient reuse');
    } finally { fs.rmSync(dir,{ recursive:true,force:true }); }
});
