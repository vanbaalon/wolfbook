'use strict';

const COLORS = [
    ['Green', '#75A86A'], ['Blue', '#6B9CCD'], ['Lavender', '#A18BC7'],
    ['Pink', '#D68CA9'], ['Peach', '#D6A075'], ['Aqua', '#65ABA5'], ['Neutral grey', '#939393'],
];
const BACKGROUND_KEYS = [
    'editor.background', 'editorGroup.emptyBackground', 'sideBar.background', 'activityBar.background',
    'panel.background', 'terminal.background', 'titleBar.activeBackground', 'titleBar.inactiveBackground',
    'editorGroupHeader.tabsBackground', 'tab.activeBackground', 'tab.inactiveBackground',
];
const rgb = value => [1,3,5].map(i=>parseInt(value.slice(i,i+2),16));
function mix(hex,base,amount) {
    const a=rgb(hex),b=rgb(base);
    return '#'+a.map((v,i)=>Math.round(v*amount+b[i]*(1-amount)).toString(16).padStart(2,'0')).join('');
}
function luminance(hex) {
    return rgb(hex).map(v=>v/255).map(v=>v<=0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4)
        .reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
}
function contrast(a,b) {
    const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);
}
function readable(color,backgrounds,dark,minimum=4.5) {
    for(let i=0;i<=100;i++) {
        const candidate=mix(dark ? '#ffffff' : '#000000',color,i/100);
        if(backgrounds.every(bg=>contrast(candidate,bg)>=minimum))return candidate;
    }
    return dark ? '#ffffff' : '#000000';
}
function palette(accent,dark) {
    if(!/^#[0-9a-f]{6}$/i.test(accent))throw Error('Use a six-digit hex colour such as #75A86A.');
    const base=dark ? '#181818' : '#ffffff';
    const main=mix(accent,base,dark ? 0.16 : 0.10);
    const side=mix(accent,base,dark ? 0.23 : 0.18);
    const bar=mix(accent,base,dark ? 0.30 : 0.26);
    const hover=mix(accent,main,dark ? 0.16 : 0.08);
    const surfaces=[main,side,bar,hover];
    const fg=readable(dark ? '#e7edf4' : '#26313c',surfaces,dark);
    const muted=readable(dark ? '#abb6c3' : '#59636f',surfaces,dark);
    const strong=readable(accent,['#ffffff'],false);
    const outline=readable(accent,surfaces,dark,3);
    const colors=Object.fromEntries(BACKGROUND_KEYS.map(key=>[key,
        ['activityBar.background','titleBar.activeBackground'].includes(key) ? bar
            : ['sideBar.background','titleBar.inactiveBackground','editorGroupHeader.tabsBackground','tab.inactiveBackground'].includes(key) ? side : main]));
    const set=(value,keys)=>keys.split(' ').forEach(key=>colors[key]=value);
    set(fg,'foreground editor.foreground sideBar.foreground sideBarTitle.foreground sideBarSectionHeader.foreground activityBar.foreground titleBar.activeForeground tab.activeForeground panelTitle.activeForeground terminal.foreground icon.foreground input.foreground dropdown.foreground quickInput.foreground menu.foreground statusBar.foreground statusBar.noFolderForeground statusBar.debuggingForeground editorLineNumber.activeForeground list.hoverForeground list.inactiveSelectionForeground list.focusForeground editorHoverWidget.foreground editorWidget.foreground');
    set(muted,'descriptionForeground disabledForeground activityBar.inactiveForeground titleBar.inactiveForeground tab.inactiveForeground tab.unfocusedActiveForeground tab.unfocusedInactiveForeground panelTitle.inactiveForeground input.placeholderForeground editorLineNumber.foreground editorGhostText.foreground');
    set(main,'input.background dropdown.background quickInput.background menu.background editorHoverWidget.background editorWidget.background');
    set(side,'sideBarSectionHeader.background statusBar.background statusBar.noFolderBackground statusBar.debuggingBackground');
    set(hover,'list.hoverBackground list.inactiveSelectionBackground list.focusBackground tab.hoverBackground toolbar.hoverBackground');
    set(strong,'list.activeSelectionBackground button.background badge.background activityBarBadge.background progressBar.background');
    set('#ffffff','list.activeSelectionForeground list.activeSelectionIconForeground button.foreground badge.foreground activityBarBadge.foreground');
    set(outline,'focusBorder input.border dropdown.border panel.border sideBar.border editorGroup.border tab.activeBorderTop list.focusOutline editor.selectionHighlightBorder');
    const semantic={
        added:readable(dark ? '#8bd49c' : '#21723a',surfaces,dark),
        modified:readable(dark ? '#e6c378' : '#795800',surfaces,dark),
        deleted:readable(dark ? '#f6a4a4' : '#ac2933',surfaces,dark),
        info:readable(dark ? '#93c5fd' : '#155fa6',surfaces,dark),
        purple:readable(dark ? '#c6b5f5' : '#7142a1',surfaces,dark),
    };
    set(semantic.added,'gitDecoration.addedResourceForeground gitDecoration.untrackedResourceForeground');
    set(semantic.modified,'gitDecoration.modifiedResourceForeground gitDecoration.stageModifiedResourceForeground editorWarning.foreground list.warningForeground problemsWarningIcon.foreground');
    set(semantic.deleted,'gitDecoration.deletedResourceForeground gitDecoration.stageDeletedResourceForeground gitDecoration.conflictingResourceForeground editorError.foreground list.errorForeground errorForeground problemsErrorIcon.foreground');
    set(semantic.info,'textLink.foreground textLink.activeForeground editorInfo.foreground problemsInfoIcon.foreground');
    set(semantic.purple,'gitDecoration.renamedResourceForeground gitDecoration.submoduleResourceForeground');
    set(muted,'gitDecoration.ignoredResourceForeground editorHint.foreground');
    set(muted,'editorCodeLens.foreground editorInlayHint.foreground breadcrumb.foreground list.deemphasizedForeground');
    set(fg,'breadcrumb.focusForeground breadcrumb.activeSelectionForeground');
    set(main,'breadcrumb.background');set(hover,'editorInlayHint.background editorBracketMatch.background');
    set(outline,'editorBracketMatch.border');
    colors['editorGutter.addedBackground']=semantic.added;
    colors['editorGutter.modifiedBackground']=semantic.info;
    colors['editorGutter.deletedBackground']=semantic.deleted;
    // ANSI colours are labels too: yellow/bright-black must remain legible on
    // a light terminal, rather than inheriting a dark theme's bright palette.
    for(const [name,value] of Object.entries({Black:muted,Red:semantic.deleted,Green:semantic.added,
        Yellow:semantic.modified,Blue:semantic.info,Magenta:semantic.purple,
        Cyan:readable(dark ? '#83d2d2' : '#087073',surfaces,dark),White:fg})) {
        colors['terminal.ansi'+name]=value;colors['terminal.ansiBright'+name]=value;
    }
    return colors;
}
const KEYS=Object.keys(palette(COLORS[0][1],false));
module.exports={COLORS,BACKGROUND_KEYS,KEYS,palette,mix,contrast};
