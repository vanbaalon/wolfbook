'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ReviewRevisionCache}=require('../../tex/reviewRevision');
const {renderTextKey}=require('../../tex/renderChange');
const {sha256}=require('../../tex/texModel');
const {withVscodeStub}=require('./_stub-vscode');
const {TexViewer}=withVscodeStub(()=>require('../../tex/texViewer'));

test('thousands of glyph/preload checks normalize each unchanged session text once',()=>{
    const text='Paragraph and $x^2$.\n'.repeat(25000),sessions=new Map([
        ['/root/main.tex',{baseText:text,_lastText:text+'New sentence.'}],
        ['/root/include.tex',{baseText:'Included content.',_lastText:'Included content.'}],
    ]);
    let normalized=0;
    const cache=new ReviewRevisionCache(text=>{normalized++;return sha256(renderTextKey(text));});
    const viewer=Object.assign(Object.create(TexViewer.prototype),{root:'/root/main.tex',_reviewRevisionCache:cache,
        coord:{roots:new Map([['/root/main.tex',{sourceRevision:4,files:[...sessions.keys()]}]])},_review:{sessionFor:file=>sessions.get(file)}});
    const revision=viewer._reviewRenderRevision('/root/main.tex');assert.equal(normalized,3);
    for(let i=0;i<3000;i++)assert.equal(viewer._reviewRenderRevision('/root/main.tex'),revision);
    assert.equal(normalized,3,'current() checks do no full-text work');
    sessions.get('/root/include.tex').baseText='Accepted included content.';
    assert.notEqual(viewer._reviewRenderRevision('/root/main.tex'),revision);assert.equal(normalized,4);
});

test('source, baseline, pending text, file set, session replacement and root changes invalidate revisions',()=>{
    const cache=new ReviewRevisionCache(),s={baseText:'Old.',_lastText:'New.'},peer={baseText:'Peer.'};
    const map=new Map([['main',s],['peer',peer]]);let files=['main','peer'],source=1,root='root';
    const rev=()=>cache.revision(root,source,files,file=>map.get(file),'main');
    let previous=rev();
    for(const change of [()=>{source++;},()=>{s.baseText='Accepted.';},()=>{s._lastText='Later.';},()=>{files=['main'];},
        ()=>{root='other-root';},()=>{map.set('main',{baseText:'Replacement.',_lastText:'Replacement.'});}]){
        change();const next=rev();assert.notEqual(next,previous);previous=next;
    }
    assert.equal(cache.revision(root,1,files,file=>map.get(file),'missing'),null);
});

test('blank-line whitespace stays render-neutral but literals and catcodes remain significant',()=>{
    const cache=new ReviewRevisionCache(),s={baseText:'Text\n\nEnd',_lastText:'Text\n\nEnd'};
    const revision=()=>cache.revision('root',0,['main'],()=>s,'main');
    const initial=revision();s._lastText='Text\n   \nEnd';assert.equal(revision(),initial);
    for(const before of ['\\begin{verbatim}\n \n\\end{verbatim}', '\\obeyspaces\n \ntext', '\\catcode`x=12\n \ntext']){
        s._lastText=before;const old=revision();s._lastText=before.replace('\n \n','\n  \n');assert.notEqual(revision(),old);
    }
});
