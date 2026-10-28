'use strict';

const {COLORS,BACKGROUND_KEYS,KEYS,palette}=require('./local-theme-palette');
const STORE='wolfbook.localTheme.restore.v2';
const controllers=new WeakMap();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const snapshot=(o,key)=>Object.hasOwn(o,key) ? {present:true,value:o[key]} : {present:false};
function restore(o,key,entry) { if(entry?.present)o[key]=entry.value;else delete o[key]; }
function legacyPalette(colors) {
    for(const [,accent] of COLORS)for(const dark of [false,true]) {
        const candidate=palette(accent,dark);
        if(BACKGROUND_KEYS.every(k=>typeof colors[k]==='string' && colors[k].toLowerCase()===candidate[k]))
            return {accent,appearance:'auto'};
    }
    return null;
}
function themeEntries(vscode) {
    return (vscode.extensions?.all || []).flatMap(e=>e.packageJSON?.contributes?.themes || []);
}
function baseTheme(vscode,workbench,dark) {
    const uiTheme=dark ? 'vs-dark' : 'vs',themes=themeEntries(vscode);
    const matches=name=>themes.find(t=>(t.id===name || t.label===name) && t.uiTheme===uiTheme);
    const current=workbench.get('colorTheme');
    if(matches(current))return current;
    const preferred=workbench.get(dark ? 'preferredDarkColorTheme' : 'preferredLightColorTheme');
    if(matches(preferred))return preferred;
    const modern=themes.find(t=>t.uiTheme===uiTheme && /Modern/.test(t.id || t.label));
    return modern?.id || modern?.label || themes.find(t=>t.uiTheme===uiTheme)?.id ||
        (dark ? 'Dark Modern' : 'Light Modern');
}
function createController(vscode,context={}) {
    let state=context.workspaceState?.get(STORE,{}) || {},chain=Promise.resolve(),disposed=false;
    let persisted=JSON.stringify(state);
    const save=async()=>{
        const value=JSON.stringify(state);
        if(value!==persisted){await context.workspaceState?.update(STORE,state);persisted=value;}
    };
    const preferences=()=>vscode.workspace.getConfiguration('wolfbook').inspect('localTheme')?.workspaceValue;
    const workbench=()=>vscode.workspace.getConfiguration('workbench');
    const report=error=>vscode.window.showErrorMessage('Local theme: '+error.message);
    const enqueue=fn=>{const work=chain.then(()=>disposed ? undefined : fn());chain=work.catch(()=>{});return work;};
    async function applyNow() {
        if(!vscode.workspace.workspaceFolders?.length)return;
        const wb=workbench(),prefs=preferences();
        const valid=prefs && /^#[0-9a-f]{6}$/i.test(prefs.accent) && ['auto','light','dark'].includes(prefs.appearance);
        const colors={...(wb.inspect('colorCustomizations')?.workspaceValue || {})};
        // Recognise the old eleven-background presets on upgrade. They have no
        // original-colour snapshot, so reset should release their overrides.
        const legacy=!state.lastColors && legacyPalette(colors);
        if(!valid && !state.lastColors && !legacy)return;
        if(legacy) {
            state={...state,lastColors:Object.fromEntries(BACKGROUND_KEYS.map(k=>[k,colors[k]])),
                originalColors:Object.fromEntries(BACKGROUND_KEYS.map(k=>[k,{present:false}]))};
        }
        const windowConfig=vscode.workspace.getConfiguration('window');
        if(valid && prefs.appearance!=='auto' && windowConfig.get('autoDetectColorScheme',false)) {
            const current=windowConfig.inspect('autoDetectColorScheme')?.workspaceValue;
            state.originalAutoDetect=current===undefined ? {present:false} : {present:true,value:current};
            state.lastAutoDetect=false;await save();
            await windowConfig.update('autoDetectColorScheme',false,vscode.ConfigurationTarget.Workspace);
        } else if((!valid || prefs.appearance==='auto') && Object.hasOwn(state,'lastAutoDetect')) {
            if(windowConfig.inspect('autoDetectColorScheme')?.workspaceValue===state.lastAutoDetect)
                await windowConfig.update('autoDetectColorScheme',state.originalAutoDetect?.present ? state.originalAutoDetect.value : undefined,vscode.ConfigurationTarget.Workspace);
            delete state.lastAutoDetect;delete state.originalAutoDetect;
        }
        if(valid && prefs.appearance!=='auto') {
            const theme=baseTheme(vscode,wb,prefs.appearance==='dark');
            const current=wb.inspect('colorTheme')?.workspaceValue;
            if(current!==theme) {
                if(!state.lastTheme || current!==state.lastTheme)
                    state.originalTheme=current===undefined ? {present:false} : {present:true,value:current};
                state.lastTheme=theme;await save();
                await wb.update('colorTheme',theme,vscode.ConfigurationTarget.Workspace);
            }
        } else if(state.lastTheme) {
            if(wb.inspect('colorTheme')?.workspaceValue===state.lastTheme)
                await wb.update('colorTheme',state.originalTheme?.present ? state.originalTheme.value : undefined,vscode.ConfigurationTarget.Workspace);
            delete state.lastTheme;delete state.originalTheme;
        }
        const kind=vscode.window.activeColorTheme?.kind;
        const highContrast=[vscode.ColorThemeKind.HighContrast,vscode.ColorThemeKind.HighContrastLight].includes(kind);
        // Never replace a high-contrast accessibility palette with a tint.
        const dark=valid && prefs.appearance!=='auto' ? prefs.appearance==='dark' : kind===vscode.ColorThemeKind.Dark;
        const next=valid && !highContrast ? palette(prefs.accent,dark) : {};
        const originals=state.originalColors ||= {},last=state.lastColors || {};
        for(const key of new Set([...Object.keys(last),...Object.keys(next)])) {
            if(Object.hasOwn(next,key)) {
                if(!Object.hasOwn(last,key) || !same(colors[key],last[key]))originals[key]=snapshot(colors,key);
                colors[key]=next[key];
            } else {
                if(same(colors[key],last[key]))restore(colors,key,originals[key]);
                delete originals[key];
            }
        }
        state.lastColors=next;await save();
        // A notebook may apply its own background while the base theme/state
        // writes above are awaited. Rebase only our keys onto the latest value.
        const old=wb.inspect('colorCustomizations')?.workspaceValue || {},merged={...old};
        for(const key of new Set([...Object.keys(last),...Object.keys(next)])) {
            if(Object.hasOwn(colors,key))merged[key]=colors[key];else delete merged[key];
        }
        if(!same(merged,old))await wb.update('colorCustomizations',Object.keys(merged).length ? merged : undefined,vscode.ConfigurationTarget.Workspace);
    }
    const apply=()=>enqueue(applyNow);
    async function show() {
        const folder=vscode.workspace.workspaceFolders?.[0];
        if(!folder)return vscode.window.showInformationMessage('Open a workspace folder to choose a local theme.');
        const current=preferences(),title=`Local theme — ${folder.name || require('path').basename(folder.uri.fsPath)}`;
        const mode=await vscode.window.showQuickPick([
            {label:'$(color-mode) Follow VS Code',value:'auto',description:'Adapt the tint when the active theme changes'},
            {label:'$(sun) Light',value:'light',description:'Light base theme and readable dark labels'},
            {label:'$(moon) Dark',value:'dark',description:'Dark base theme and readable light labels'},
            {label:'$(discard) Use VS Code theme colours',value:'reset',description:'Restore the settings from before the local style'},
        ].map(p=>({...p,description:(p.value===current?.appearance ? '✓ current · ' : '')+p.description})),
        {title,placeHolder:'Choose this workspace’s appearance',ignoreFocusOut:true});
        if(!mode)return;
        if(mode.value==='reset') {
            await vscode.workspace.getConfiguration('wolfbook').update('localTheme',undefined,vscode.ConfigurationTarget.Workspace);
            return apply();
        }
        const pick=await vscode.window.showQuickPick([
            ...COLORS.map(([label,value])=>({label,value,description:value.toLowerCase()===current?.accent?.toLowerCase() ? '✓ current' : ''})),
            {label:'$(edit) Custom colour…',value:'custom'},
        ],{title:`${title} · ${mode.value==='auto' ? 'Follow VS Code' : mode.value==='light' ? 'Light' : 'Dark'}`,
            placeHolder:'Choose an accent; notebook backgrounds stay independent',ignoreFocusOut:true});
        if(!pick)return;
        let accent=pick.value;
        if(accent==='custom') {
            accent=await vscode.window.showInputBox({title:'Local theme — custom colour',
                prompt:'Enter an accent. Labels and decorations will adapt to the light or dark background.',
                placeHolder:'#75A86A',ignoreFocusOut:true,
                validateInput:value=>/^#[0-9a-f]{6}$/i.test(value.trim()) ? undefined : 'Use #RRGGBB, for example #75A86A.'});
            if(accent===undefined)return;accent=accent.trim();
        }
        await vscode.workspace.getConfiguration('wolfbook').update('localTheme',{accent,appearance:mode.value},vscode.ConfigurationTarget.Workspace);
        return apply();
    }
    async function start() {
        if(!preferences() && !state.lastColors && vscode.workspace.workspaceFolders?.length) {
            const legacy=legacyPalette(workbench().inspect('colorCustomizations')?.workspaceValue || {});
            if(legacy)await vscode.workspace.getConfiguration('wolfbook').update('localTheme',legacy,vscode.ConfigurationTarget.Workspace);
        }
        return apply();
    }
    return {show,apply,start,report,dispose(){disposed=true;}};
}
function register(context,vscode=require('vscode')) {
    const controller=createController(vscode,context);controllers.set(vscode,controller);
    context.subscriptions.push(controller);
    context.subscriptions.push(vscode.commands.registerCommand('wolfbook.localTheme',()=>controller.show().catch(controller.report)));
    context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(()=>controller.apply().catch(controller.report)));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e=>{
        if(e.affectsConfiguration('wolfbook.localTheme'))controller.apply().catch(controller.report);
    }));
    controller.start().catch(controller.report);
    return controller;
}
async function show(vscode=require('vscode')) {
    const controller=controllers.get(vscode) || createController(vscode);
    return controller.show();
}
module.exports={show,register,createController,palette,KEYS};
