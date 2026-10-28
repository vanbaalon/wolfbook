'use strict';
// Run explicitly with WPAPER_WEBVIEW_SPEC=<absolute path to this file>
// and WPAPER_NATIVE_TEST_DIR=<WLaTeX checkout/runtime directory>.
const { fixtureTex } = require('./tex-webview-bugs.spec.cjs');
const fs = require('fs'), path = require('path'), os = require('os');
const PARA = fixtureTex.split('\n').slice(6,9).join('\n');
const tests = [{
    id:'review-ink-parity',
    name:'real standard, Pro and Pro fallback PDFs identify added/replaced ink and removed text',
    async run(t) {
        const { TexViewer } = require('../../../tex/texViewer');
        const { compile, snapshotSources } = require('../../../tex/compileService');
        const { NativeBuildLane } = require('../../../tex/nativeCompileService');
        const { NativeMap } = require('../../../tex/nativeMap');
        const { RenderMap } = require('../../../tex/renderMap');
        const { changedRanges } = require('../../../tex/reviewRender');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-review-parity-')), root = path.join(dir,'paper.tex');
        fs.writeFileSync(root, fixtureTex);
        const lane = new NativeBuildLane(root, process.env.WPAPER_NATIVE_TEST_DIR);
        const captures = process.env.WPAPER_REVIEW_CAPTURE_DIR || os.tmpdir();
        try {
            const standard = await compile({ root, sourceFiles:[root], engine:'xelatex', outDir:path.join(dir,'standard'), timeoutMs:20000 });
            t.assert(standard.ok, `standard compiler: ${JSON.stringify(standard.diagnostics)}`);
            const native = await lane.compile({ root, sourceFiles:[root], sourceSnapshotHash:snapshotSources([root]), nativePages:[1], timeoutMs:20000 });
            t.assert(native.ok, `Pro compiler: ${JSON.stringify(native.diagnostics)}`);
            const nativeMap = new NativeMap({ generation:native, nativeView:native.nativeView, nativeSource:native.nativeSource });
            const standardMap = new RenderMap({ generation:standard });
            let generation = 10;
            for (const mode of ['standard','pro','pro-fallback']) {
                generation++;
                const map = mode === 'pro' ? nativeMap : standardMap, gen = mode === 'pro' ? native : standard;
                await t.post({ type:'engine', state:mode === 'standard' ? 'off' : 'live' });
                await t.open(generation, { pdfBase64:fs.readFileSync(gen.pdfPath).toString('base64'), pages:1 });
                await t.post({ type:'nativeMapState', generation, available:mode === 'pro' });
                const rects = [7,8,9].flatMap(line => map.lineRows(root,line));
                t.assert(rects.length > 0, 'the compiler supplies paragraph geometry');
                for (const example of [
                    { id:'replace', verb:'change', before:PARA.replace('velocity','speed'), selected:'velocity' },
                    { id:'add', verb:'add', before:'', selected:'paragraph' },
                    { id:'remove-sentence', verb:'change', before:PARA + '\nThis sentence was removed.', removed:true },
                    { id:'remove-block', verb:'del', before:'A whole paragraph was removed.', removed:true },
                ]) {
                    const hunk = { id:example.id, verb:example.verb, theirText:example.before,
                        ourText:example.verb === 'del' ? '' : PARA, ourRange:{ startLine:7,endLine:10 },
                        theirRange:{ startLine:7,endLine:10 }, rects:example.verb === 'del' ? [{ ...rects[0],caret:true,w:0 }] : rects,
                        startLine:7, beforeLine:7, endLine:10, name:'paragraph',
                        lines:example.verb === 'del' ? 1 : 3, changedWords:example.removed ? 4 : 1 };
                    hunk.words = { ours:changedRanges(hunk,'after'), theirs:changedRanges(hunk,'before') };
                    const messages = [], v = Object.create(TexViewer.prototype);
                    const session = { file:root, _lastText:fixtureTex, hunks:[hunk] };
                    const revision = `${mode}-${example.id}`;
                    Object.assign(v, { root, panel:{}, shownGeneration:generation, coord:{ roots:new Map([[root,{ map,files:[root] }]]) },
                        _review:{ sessionFor:() => session }, _textOf:() => fixtureTex, _displayMatchesSource:() => true,
                        _reviewRenderRevision:() => revision, _post:m => messages.push(m), _log:m => { throw Error(m); } });
                    await t.clear();
                    await t.post({ type:'review', session:{ file:root,renderRevision:revision,pending:1,focus:null,generation,
                        groups:[{ id:'parity',at:1,hunks:[hunk] }] } });
                    if (hunk.verb !== 'del') {
                        const request = await t.waitPosted('reviewPageMap', m => m.id === hunk.id);
                        t.assert(mode === 'pro' ? request.items.length === 0 : request.items.length > 0,
                            `${mode} chooses source origins or measured PDF characters from the displayed map`);
                        await v._reviewPageMarks(request);
                        t.assert(messages.length === 1, 'the actual host maps the correction');
                        if (example.removed) t.assert(messages[0].marks.length === 0, 'remaining text is not marked as added');
                        else t.assert(messages[0].marks.length > 0, `${mode} resolves actual changed ink`);
                        await t.post(messages[0]);
                    }
                    if (example.removed) {
                        await t.waitFor(id => document.querySelectorAll('.rremoved').length === 1 &&
                            document.querySelector('.rremoved').dataset.reviewHunk === id, hunk.id, { what:'the current removal marker' });
                        t.assert(await t.eval(() => document.querySelectorAll('.runderline,.rinkfill').length) === 0,
                            'deletions do not paint unchanged remaining words green');
                        const leftmost = await t.toClient(1,Math.min(...rects.map(r => r.x)),0);
                        const placement = await t.eval(left => {
                            const b = document.querySelector('.rremoved').getBoundingClientRect();
                            const r = document.querySelector('.rband').getBoundingClientRect();
                            return { clear:b.right <= left || b.bottom <= r.top,
                                badge:{ left:b.left,right:b.right,top:b.top,bottom:b.bottom },
                                row:{ left:r.left,top:r.top,bottom:r.bottom } };
                        }, leftmost.x);
                        await t.page.screenshot({ path:path.join(captures,`wpaper-${mode}-${example.id}.png`) });
                        t.assert(placement.clear, `the removal label does not cover remaining paragraph ink: ${mode}/${example.id} ${JSON.stringify(placement)}`);
                        await t.page.locator('.rremoved').click();
                        await t.waitPosted('reviewAction', m => m.action === 'show' && m.id === hunk.id);
                        const removedText = await t.eval(() => [...document.querySelectorAll('#reviewdiff .was mark')].map(m => m.textContent).join(' '));
                        t.assert(removedText.includes('removed'), 'clicking reveals exactly the removed source while the rendered snapshot loads');
                    } else {
                        await t.waitFor(() => document.querySelectorAll('.runderline').length > 0, null, { what:'verified green ink' });
                        t.assert(await t.eval(() => document.querySelector('.runderline').title) ===
                            (example.verb === 'add' ? 'Added text' : 'Replacement text'), 'addition/replacement semantics are explicit');
                        if (example.verb === 'change') {
                            const totalWidth = await t.eval(() => [...document.querySelectorAll('.runderline')].reduce((a,e) => a + e.getBoundingClientRect().width,0));
                            const expected = messages[0].marks.reduce((a,m) => a + m.w,0) * await t.pxPerBp();
                            t.near(totalWidth,expected,3,'only the changed word is underlined, without the remaining paragraph');
                        }
                        await t.page.screenshot({ path:path.join(captures,`wpaper-${mode}-${example.id}.png`) });
                    }
                }
            }
        } finally { await lane.close(); fs.rmSync(dir, { recursive:true,force:true }); }
    },
}, {
    id:'review-map-ready',
    name:'Pro map readiness replaces fallback character measurements and rejects their late answers',
    async run(t) {
        await t.post({ type:'engine',state:'live' });
        const w = t.word('velocity'), rects = [{ page:1,x:w.x,y:w.y,w:w.w,h:w.h }];
        await t.post({ type:'review', session:{ file:'paper.tex',generation:1,renderRevision:'ready',pending:1,focus:null,
            groups:[{ id:'ready',at:1,hunks:[{ id:'word',verb:'change',theirText:'speed',ourText:'velocity',rects,startLine:7,
                words:{ ours:[{line:0,col:0,len:8}],theirs:[{line:0,col:0,len:5}] } }] }] } });
        const fallback = await t.waitPosted('reviewPageMap', m => m.id === 'word');
        t.assert(fallback.items.length > 0, 'a Pro badge without a native map still measures the fallback PDF');
        await t.clear();
        await t.post({ type:'nativeMapState',generation:1,available:true });
        const native = await t.waitPosted('reviewPageMap', m => m.id === 'word');
        t.assert(native.requestId !== fallback.requestId && native.items.length === 0, 'ready origins trigger a fresh exact request');
        await t.post({ ...fallback,type:'reviewPageMarks',marks:rects });
        t.assert(await t.eval(() => document.querySelectorAll('.runderline').length) === 0, 'a late fallback answer is discarded');
        await t.post({ ...native,type:'reviewPageMarks',marks:rects });
        await t.waitFor(() => document.querySelectorAll('.runderline').length === 1, null, { what:'the current exact mark' });
    },
}];
module.exports = { fixtureTex, tests };
