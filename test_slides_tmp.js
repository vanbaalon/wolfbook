const se=require('./out/extension/slideExporter');
const fs=require('fs'),os=require('os'),path=require('path'),{execFile}=require('child_process');
const deck=JSON.parse(fs.readFileSync('/Users/k0959535/Dropbox/MY/Talks/2026/KCL_NMES/WBapr.wslide','utf8'));

const N=parseInt(process.argv[2]);
const h=se.exportDeckPdf({...deck,slides:deck.slides.slice(0,N)},'/Users/k0959535/Dropbox/MY/Talks/2026/KCL_NMES');
const tmpH=path.join(os.tmpdir(),'wslide_t'+N+'.html');
const tmpU=path.join(os.tmpdir(),'wslide_u'+N+'_'+Date.now());
const out='/tmp/udd_n'+N+'.pdf';
fs.writeFileSync(tmpH,h,'utf8');
fs.mkdirSync(tmpU,{recursive:true});
execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions',
   '--run-all-compositor-stages-before-draw','--no-pdf-header-footer',
   '--print-to-pdf-no-header','--user-data-dir='+tmpU,
   '--print-to-pdf='+out,'file://'+tmpH],
  {timeout:90000},(e,so,se2)=>{
    fs.unlink(tmpH,()=>{});
    fs.rm(tmpU,{recursive:true,force:true},()=>{});
    if(!e && fs.existsSync(out)){
      console.log('N='+N+': OK '+fs.statSync(out).size+' bytes');
    } else {
      console.log('N='+N+': FAIL');
    }
  });
