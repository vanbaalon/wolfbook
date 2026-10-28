'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process');
const {gitReviewAuthors}=require('../../tex/reviewGit');
const {ReviewSession}=require('../../tex/reviewSession');
function repo(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wpaper-review-authors-')),file=path.join(dir,'paper.tex');
 const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','Baseline');git('config','user.email','baseline@example.test');
 const commit=(text,name)=>{fs.writeFileSync(file,text);git('add','paper.tex');git('-c',`user.name=${name}`,'-c',`user.email=${name.toLowerCase()}@example.test`,'commit','-qm',`Update by ${name}`);};
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,file,commit,git};
}
test('Git attribution distinguishes two contributors and does not invent a deletion author',async t=>{
 const r=repo(t),before='First old sentence.\nSecond old sentence.\nRemoved sentence.\n';r.commit(before,'Baseline');
 r.commit(before.replace('First old','First new'),'Alice');const after='First new sentence.\nSecond new sentence.\n';r.commit(after,'Bob');
 const hunks=[{id:'first',verb:'change',ourRange:{startLine:1,endLine:2}},
  {id:'second',verb:'change',ourRange:{startLine:2,endLine:3}}, {id:'removed',verb:'del',ourRange:{startLine:3,endLine:3}}];
 const result=await gitReviewAuthors({file:r.file,before,after,hunks});
 assert.equal(result.authors.first.name,'Alice');assert.equal(result.authors.second.name,'Bob');
 assert.equal(result.authors.removed.scope,'update');assert.equal(result.authors.removed.contributors.length,2);
 assert.equal(result.author.contributors.length,2);
 assert.equal(await gitReviewAuthors({file:r.file,before,after:after+'Uncommitted agent prose.\n',hunks}),null);
 assert.equal(await gitReviewAuthors({file:r.file,before:'Not a historical source.\n',after,hunks}),null);
});
test('one-commit Git deletion identifies its author, not the deleted line writer',async t=>{
 const r=repo(t),before='Remaining sentence.\nRemoved old sentence.\n',after='Remaining sentence.\n';
 r.commit(before,'Baseline');r.commit(after,'Alice');
 const result=await gitReviewAuthors({file:r.file,before,after,hunks:[{id:'delete',verb:'del',ourRange:{startLine:2,endLine:2}}]});
 assert.equal(result.authors.delete.name,'Alice');assert.equal(result.authors.delete.contributors[0].email,'alice@example.test');
});
test('Git authors survive saved review restoration and section grouping',()=>{
 const s=new ReviewSession({file:'/tmp/paper.tex',baseText:'Old sentence.\n'});s.noteBatch({source:'disk'});s.update({currentText:'New sentence.\n'});
 const id=s.hunks[0].id;s.gitAuthors.set(id,{name:'Alice',source:'git',contributors:[{name:'Alice',commit:'a'.repeat(40)}]});
 const restored=ReviewSession.restore(s.serialize()),payload=restored.payload();
 assert.equal(payload.groups[0].hunks[0].author.name,'Alice');assert.equal(payload.groups[0].hunks[0].source,'git');
});
