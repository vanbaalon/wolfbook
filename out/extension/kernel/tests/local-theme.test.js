'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createController,register}=require('../../local-theme');
const {palette,COLORS,BACKGROUND_KEYS,KEYS,contrast}=require('../../local-theme-palette');
function fixture({prefs,colors={},globalColors={'editor.wordHighlightBorder':'#336699'},theme,kind=1,saved={}}={}) {
 const local={workbench:{colorCustomizations:structuredClone(colors)},wolfbook:{},window:{}},writes=[],picks=[],events={},commands={};
 if(prefs)local.wolfbook.localTheme=prefs;if(theme)local.workbench.colorTheme=theme;
 const themes=[{id:'Light Modern',uiTheme:'vs'},{id:'Dark Modern',uiTheme:'vs-dark'},
  {id:'My Light',uiTheme:'vs'},{id:'My Dark',uiTheme:'vs-dark'}];
 const global={workbench:{colorCustomizations:globalColors,colorTheme:kind===1 ? 'Light Modern' : 'Dark Modern',
  preferredLightColorTheme:'My Light',preferredDarkColorTheme:'My Dark'},wolfbook:{},window:{autoDetectColorScheme:false}};
 const config=section=>({
  get:(key,fallback)=>local[section]?.[key] ?? global[section]?.[key] ?? fallback,
  inspect:key=>({workspaceValue:local[section]?.[key],globalValue:global[section]?.[key]}),
  update:async(key,value,target)=>{
   assert.equal(target,2,'every write stays in this workspace');writes.push({section,key,value:structuredClone(value),target});
   if(value===undefined)delete local[section][key];else local[section][key]=structuredClone(value);
   if(section==='workbench'&&key==='colorTheme') {
    const chosen=themes.find(t=>t.id===(value || global.workbench.colorTheme));
    if(chosen)vscode.window.activeColorTheme.kind=chosen.uiTheme==='vs' ? 1 : 2;
   }
  },
 });
 const subscribe=key=>fn=>{events[key]=fn;return {dispose:()=>delete events[key]};};
 const vscode={ColorThemeKind:{Light:1,Dark:2,HighContrast:3,HighContrastLight:4},ConfigurationTarget:{Workspace:2},
  extensions:{all:[{packageJSON:{contributes:{themes}}}]},
  workspace:{workspaceFolders:[{name:'Project',uri:{fsPath:'/project'}}],getConfiguration:config,
   onDidChangeConfiguration:subscribe('configuration')},
  commands:{registerCommand:(id,fn)=>{commands[id]=fn;return {dispose:()=>delete commands[id]};}},
  window:{activeColorTheme:{kind},onDidChangeActiveColorTheme:subscribe('theme'),
   showQuickPick:async(items)=>{picks.push(items);const next=answers.shift();return items.find(item=>item.value===next);},
   showInputBox:async options=>{inputOptions=options;return input;},
   showInformationMessage:async()=>{},showErrorMessage:message=>{throw Error(message);}},
 };
 let answers=[],input,inputOptions;
 const context={subscriptions:[],workspaceState:{get:(key,fallback)=>structuredClone(saved[key] ?? fallback),
  update:async(key,value)=>{saved[key]=structuredClone(value);}}};
 const controller=createController(vscode,context);
 return {controller,vscode,context,local,global,saved,writes,picks,events,commands,
  answer:(...values)=>{answers=values;},input:value=>{input=value;},inputOptions:()=>inputOptions};
}

test('all presets and extreme custom accents keep label/decorations contrast in light and dark',()=>{
 const accents=[...COLORS.map(c=>c[1]),'#000000','#ffffff','#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff'];
 for(const accent of accents)for(const dark of [false,true]) {
  const p=palette(accent,dark),surfaces=['editor.background','sideBar.background','activityBar.background','tab.inactiveBackground','list.hoverBackground'];
  const selected=new Set(['list.activeSelectionForeground','list.activeSelectionIconForeground','button.foreground','badge.foreground','activityBarBadge.foreground']);
  for(const key of KEYS.filter(k=>/foreground$/i.test(k)||k.startsWith('terminal.ansi'))) {
   if(selected.has(key))continue;
   for(const bg of surfaces)assert.ok(contrast(p[key],p[bg])>=4.5,`${accent}/${dark}/${key}/${bg} must meet 4.5:1`);
  }
  for(const [fg,bg] of [['button.foreground','button.background'],['badge.foreground','badge.background'],
   ['activityBarBadge.foreground','activityBarBadge.background'],['list.activeSelectionForeground','list.activeSelectionBackground']])
   assert.ok(contrast(p[fg],p[bg])>=4.5,`${accent}/${dark}/${fg} is readable`);
  for(const bg of surfaces)assert.ok(contrast(p.focusBorder,p[bg])>=3,'focus outline meets 3:1');
  assert.ok(!KEYS.some(k=>k.startsWith('notebook.')),'notebook backgrounds remain independent');
 }
 assert.throws(()=>palette('red',false),/six-digit/);
});

test('picker offers automatic, light and dark variants; explicit dark picks a matching base syntax theme',async()=>{
 const f=fixture();f.answer('dark','#D68CA9');await f.controller.show();
 assert.deepEqual(f.picks[0].map(p=>p.value),['auto','light','dark','reset']);
 assert.deepEqual(f.local.wolfbook.localTheme,{accent:'#D68CA9',appearance:'dark'});
 assert.equal(f.local.workbench.colorTheme,'My Dark');
 assert.equal(f.local.workbench.colorCustomizations['editor.background'],palette('#D68CA9',true)['editor.background']);
 assert.equal(f.global.workbench.colorTheme,'Light Modern');
 assert.equal(f.local.workbench.colorCustomizations['editor.wordHighlightBorder'],undefined,'inherited overrides are never materialised');
});

test('explicit light preserves an existing matching theme rather than replacing its syntax colours',async()=>{
 const f=fixture({prefs:{accent:'#6B9CCD',appearance:'light'},theme:'My Light'});await f.controller.apply();
 assert.equal(f.local.workbench.colorTheme,'My Light');assert.ok(!f.writes.some(w=>w.key==='colorTheme'));
});

test('automatic mode follows theme changes, is idempotent, and suspends tints for both high contrast variants',async()=>{
 const f=fixture({prefs:{accent:'#A18BC7',appearance:'auto'},colors:{'notebook.editorBackground':'#abcdef'}});
 await f.controller.apply();let n=f.writes.length;await f.controller.apply();assert.equal(f.writes.length,n);
 f.vscode.window.activeColorTheme.kind=2;await f.controller.apply();
 assert.equal(f.local.workbench.colorCustomizations['editor.background'],palette('#A18BC7',true)['editor.background']);
 for(const kind of [3,4]) {
  f.vscode.window.activeColorTheme.kind=kind;await f.controller.apply();
  assert.deepEqual(f.local.workbench.colorCustomizations,{'notebook.editorBackground':'#abcdef'});
 }
 f.vscode.window.activeColorTheme.kind=1;await f.controller.apply();
 assert.equal(f.local.workbench.colorCustomizations['editor.background'],palette('#A18BC7',false)['editor.background']);
 assert.ok(!f.writes.some(w=>w.key==='colorTheme'),'auto never pins a base theme');
});

test('reset restores originals and a previous workspace base theme across extension reloads',async()=>{
 const original={'editor.foreground':'#123456','notebook.editorBackground':'#F0E8E0','otherExtension.color':'#112233'};
 const f=fixture({prefs:{accent:'#75A86A',appearance:'light'},colors:original,theme:'My Dark',kind:2});
 await f.controller.apply();
 const reloaded=createController(f.vscode,f.context);
 f.local.wolfbook.localTheme={accent:'#75A86A',appearance:'dark'};await reloaded.apply();
 f.answer('reset');await reloaded.show();
 assert.equal(f.local.workbench.colorTheme,'My Dark');assert.deepEqual(f.local.workbench.colorCustomizations,original);
 assert.equal(f.local.wolfbook.localTheme,undefined);
});

test('reset keeps manual edits made after a local style and releases an originally inherited base theme',async()=>{
 const f=fixture({prefs:{accent:'#65ABA5',appearance:'dark'}});await f.controller.apply();
 f.local.workbench.colorCustomizations['editor.foreground']='#123abc';
 f.local.workbench.colorCustomizations['editor.wordHighlightBorder']='#fefefe';
 f.answer('reset');await f.controller.show();
 assert.deepEqual(f.local.workbench.colorCustomizations,{'editor.foreground':'#123abc','editor.wordHighlightBorder':'#fefefe'});
 assert.equal(f.local.workbench.colorTheme,undefined);
});

test('returning from explicit dark to Follow VS Code restores the previous workspace theme',async()=>{
 const f=fixture({prefs:{accent:'#65ABA5',appearance:'dark'},theme:'My Light'});await f.controller.apply();
 f.answer('auto','#65ABA5');await f.controller.show();
 assert.equal(f.local.workbench.colorTheme,'My Light');
 assert.equal(f.local.workbench.colorCustomizations['editor.background'],palette('#65ABA5',false)['editor.background']);
});

test('cancelling either picker or custom input leaves settings completely untouched',async()=>{
 for(const answers of [[],['light'],['dark','custom']]) {
  const f=fixture();f.answer(...answers);await f.controller.show();assert.deepEqual(f.writes,[]);
 }
});

test('custom accents are validated and trimmed and use readable variants',async()=>{
 const f=fixture();f.answer('light','custom');f.input('  #FF00FF  ');await f.controller.show();
 assert.equal(f.inputOptions().validateInput('red'),'Use #RRGGBB, for example #75A86A.');
 assert.equal(f.inputOptions().validateInput('#abcdef'),undefined);
 assert.equal(f.local.wolfbook.localTheme.accent,'#FF00FF');
 assert.equal(f.local.workbench.colorCustomizations['editor.foreground'],palette('#FF00FF',false)['editor.foreground']);
});

test('old background-only presets migrate to automatic styles and reset releases old tints',async()=>{
 const p=palette('#D68CA9',false),legacy=Object.fromEntries(BACKGROUND_KEYS.map(k=>[k,p[k]]));
 const f=fixture({colors:{...legacy,'notebook.editorBackground':'#aabbcc'},kind:2});await f.controller.start();
 assert.deepEqual(f.local.wolfbook.localTheme,{accent:'#D68CA9',appearance:'auto'});
 assert.equal(f.local.workbench.colorCustomizations['editor.background'],palette('#D68CA9',true)['editor.background']);
 f.answer('reset');await f.controller.show();assert.deepEqual(f.local.workbench.colorCustomizations,{'notebook.editorBackground':'#aabbcc'});
});

test('an untouched workspace and an empty window get no style writes on activation',async()=>{
 const f=fixture();await f.controller.start();assert.deepEqual(f.writes,[]);
 f.vscode.workspace.workspaceFolders=[];await f.controller.start();await f.controller.show();assert.deepEqual(f.writes,[]);
});

test('activation wires the command, active theme and local-setting events and disposes cleanly',async()=>{
 const f=fixture({prefs:{accent:'#939393',appearance:'auto'}});
 const registered=register(f.context,f.vscode);await registered.apply();
 assert.equal(typeof f.commands['wolfbook.localTheme'],'function');
 f.vscode.window.activeColorTheme.kind=2;f.events.theme();await registered.apply();
 assert.equal(f.local.workbench.colorCustomizations['editor.background'],palette('#939393',true)['editor.background']);
 f.local.wolfbook.localTheme={accent:'#6B9CCD',appearance:'auto'};
 f.events.configuration({affectsConfiguration:key=>key==='wolfbook.localTheme'});await registered.apply();
 assert.equal(f.local.workbench.colorCustomizations['editor.background'],palette('#6B9CCD',true)['editor.background']);
 f.context.subscriptions.forEach(d=>d.dispose());let count=f.writes.length;await registered.apply();assert.equal(f.writes.length,count);
});


test('explicit variants pin only this workspace when OS colour detection is enabled, then restore it',async()=>{
 const f=fixture({prefs:{accent:'#6B9CCD',appearance:'dark'}});f.global.window.autoDetectColorScheme=true;
 await f.controller.apply();assert.equal(f.local.window.autoDetectColorScheme,false);assert.equal(f.global.window.autoDetectColorScheme,true);
 f.answer('auto','#6B9CCD');await f.controller.show();assert.equal(f.local.window.autoDetectColorScheme,undefined);
});

test('a concurrent notebook/background settings write is preserved when the style applies',async()=>{
 const f=fixture({prefs:{accent:'#A18BC7',appearance:'auto'}}),save=f.context.workspaceState.update;
 f.context.workspaceState.update=async(...args)=>{await save(...args);f.local.workbench.colorCustomizations['notebook.editorBackground']='#ffeedd';};
 await f.controller.apply();assert.equal(f.local.workbench.colorCustomizations['notebook.editorBackground'],'#ffeedd');
});

test('Wolfbook defaults no longer pin unknown symbols to a light-only blue',()=>{
 const config=require('../../../../package.json').contributes.configurationDefaults;
 assert.equal(config['editor.tokenColorCustomizations'],undefined);
});
