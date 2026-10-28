'use strict';
const {VirtualNotebooks}=require('../nb-import/virtual');
class ReadNotebookFileTool {
 constructor(vscode,reader=new VirtualNotebooks()){this.vscode=vscode;this.reader=reader;}
 async prepareInvocation(options){return {invocationMessage:'Read virtual notebook: '+(options.input?.file || options.input?.virtual_notebook_id || '')};}
 async invoke(options,token){
  const v=this.vscode;
  try {
   const input=options.input || {},snapshot=await this.reader.load(input,v.workspace.workspaceFolders?.[0]?.uri.fsPath,token);
   return new v.LanguageModelToolResult([new v.LanguageModelTextPart(JSON.stringify(this.reader.project(snapshot,input)))]);
  }catch(error){return new v.LanguageModelToolResult([new v.LanguageModelTextPart(JSON.stringify({ok:false,read_only:true,error:error.message}))]);}
 }
}
module.exports={ReadNotebookFileTool};
