## Local workspace styles

Run **Wolfbook: Local Theme…** from the Command Palette, or choose **Local theme…** in Notebook Settings. Choose **Follow VS Code**, **Light**, or **Dark**, then an accent colour. Each accent has a matching light and dark palette for labels, Git decorations, diagnostics, badges, terminal text and focus indicators.

Follow VS Code adapts whenever the active theme changes. High-contrast themes keep their accessibility palette. Light and Dark choose a matching installed base theme and pin this workspace’s appearance; switching back to Follow VS Code restores the previous automatic colour-scheme setting. Notebook background settings remain independent. Existing background-only presets migrate to Follow VS Code.

**Use VS Code theme colours** restores the previous workspace colours and base theme; unrelated notebook/extension overrides and later manual edits are preserved. These choices affect Workspace settings only. The portable setting is `wolfbook.localTheme`, for example `{ "accent": "#A18BC7", "appearance": "auto" }`.

The extension uses VS Code’s [theme colour tokens](https://code.visualstudio.com/api/references/theme-color) and [workspace theme settings](https://code.visualstudio.com/docs/configure/themes). Syntax colours come from the base theme and any user-authored token rules.


https://github.com/microsoft/vscode/wiki/Semantic-Highlighting-Overview


Themes don't support background styling
https://github.com/microsoft/vscode/issues/3429

## BrentonWL

// {
// 	//
// 	// default color of Slot should be an error
// 	//
// 	"scope": ["keyword.other.Slot", "keyword.other.SlotSequence"],
// 	"settings": {
// 		"foreground": "#ff0000"
// 	}
// },


{
    "name": "Undocumented",
    "scope": "support.function.undocumented",
    "settings": {
        //
        // the idea is to make it almost the same as unrecognized
        //
        "foreground": "#eeeeee"
    }
},
