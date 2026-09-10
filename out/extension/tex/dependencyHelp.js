// dependencyHelp.js — turn missing TeX prerequisites into installation help.
//
// Pure Node: compileService uses this without VS Code, and the headless tests
// pin the wording users see on machines where TeX is only partly installed.

const path = require('path');

const URLS = Object.freeze({
    miktex: 'https://miktex.org/howto/install-miktex',
    texlive: 'https://tug.org/texlive/quickinstall.html',
    mactex: 'https://tug.org/mactex/',
});

function setupUrl(platform, manager) {
    if (manager === 'texlive') return URLS.texlive;
    if (manager === 'miktex' || platform === 'win32') return URLS.miktex;
    return platform === 'darwin' ? URLS.mactex : URLS.texlive;
}

const INSTALLABLE_TEX_FILE_EXTENSIONS = new Set([
    '.sty', '.cls', '.clo', '.def', '.fd', '.tfm', '.map', '.enc',
    '.bst', '.bbx', '.cbx', '.lbx',
]);

function platformName(platform = process.platform) {
    if (platform === 'win32') return 'Windows';
    if (platform === 'darwin') return 'macOS';
    return 'Linux';
}

function toolLabel(tool) {
    if (tool === 'latexmk') return 'latexmk';
    if (tool === 'pdflatex') return 'pdfLaTeX';
    if (tool === 'xelatex') return 'XeLaTeX';
    if (tool === 'lualatex') return 'LuaLaTeX';
    return tool;
}

/** A command required by WPaper is not callable from the extension host. */
function missingToolIssue(tool, opts = {}) {
    const platform = opts.platform || process.platform;
    const manager = opts.manager || null;
    const label = toolLabel(tool);
    const isRunner = tool === 'latexmk';
    return {
        kind: isRunner ? 'missing-latexmk' : 'missing-engine',
        key: `tool:${tool}:${manager || 'unknown'}`,
        tool,
        platform,
        manager,
        summary: `${label} was not found on PATH. WPaper cannot compile this paper until it is installed and visible to VS Code.`,
        helpUrl: setupUrl(platform, manager),
    };
}

/** Extract the missing filename from the usual TeX error shapes. */
function missingFileFromMessage(message) {
    const m = /\bFile\s+[`'"]?([^`'"\s]+)[`'"]?\s+not found\b/i.exec(String(message || ''));
    return m ? m[1].replace(/[.,;:]$/, '') : null;
}

function missingFileKind(filename) {
    switch (path.extname(filename || '').toLowerCase()) {
        case '.sty': return 'LaTeX package';
        case '.cls': case '.clo': return 'document class';
        case '.bst': case '.bbx': case '.cbx': case '.lbx': return 'bibliography style';
        case '.fd': case '.tfm': case '.map': case '.enc': return 'TeX font support file';
        default: return 'TeX support file';
    }
}

/**
 * Find an installable TeX dependency in parsed compiler diagnostics.
 * Missing project inputs (.tex/.bib/images) are deliberately excluded: a TeX
 * package manager cannot restore the user's own files.
 */
function missingTexFileIssue(diagnostics, opts = {}) {
    for (const d of diagnostics || []) {
        if (!d || d.kind !== 'missing-file') continue;
        const filename = missingFileFromMessage(d.message);
        if (!filename || !INSTALLABLE_TEX_FILE_EXTENSIONS.has(path.extname(filename).toLowerCase())) continue;
        const manager = opts.manager || inferManager(opts.output);
        const packageHint = path.basename(filename, path.extname(filename));
        const kind = missingFileKind(filename);
        return {
            kind: 'missing-tex-file',
            key: `file:${filename.toLowerCase()}:${manager || 'unknown'}`,
            filename,
            packageHint,
            fileKind: kind,
            platform: opts.platform || process.platform,
            manager,
            summary: `${kind} “${filename}” is missing. Install the TeX package that provides it, then compile again.`,
            helpUrl: setupUrl(opts.platform || process.platform, manager),
        };
    }
    return null;
}

function inferManager(output) {
    const s = String(output || '');
    if (/MiKTeX/i.test(s)) return 'miktex';
    if (/TeX Live/i.test(s)) return 'texlive';
    return null;
}

function enginePackage(tool) {
    if (tool === 'xelatex') return 'xetex';
    if (tool === 'lualatex') return 'luatex';
    return 'pdftex';
}

/** Detailed, copyable instructions for the WPaper output channel. */
function formatDependencyHelp(issue) {
    if (!issue) return '';
    const lines = [
        '',
        'WPAPER SETUP REQUIRED',
        issue.summary,
        '',
    ];
    const windows = issue.platform === 'win32';

    if (issue.kind === 'missing-latexmk' || issue.kind === 'missing-engine') {
        if (windows) {
            if (!issue.manager) {
                lines.push(
                    'Recommended on Windows:',
                    '  1. Install MiKTeX: https://miktex.org/howto/install-miktex',
                    '  2. In MiKTeX Console > Packages, install “latexmk”.',
                    '  3. In MiKTeX Console > Settings > General, set missing packages to “Always”.',
                    '  4. Restart every VS Code window so the updated PATH is inherited.',
                    '',
                    'Alternative: install TeX Live for Windows:',
                    '  https://tug.org/texlive/quickinstall.html',
                    '  TeX Live includes the Windows support programs needed by its scripts.',
                );
            } else if (issue.manager === 'miktex') {
                lines.push(
                    'MiKTeX was detected:',
                    issue.tool === 'latexmk'
                        ? '  Open MiKTeX Console > Packages, search for “latexmk”, and install it.'
                        : `  Open MiKTeX Console > Packages and install/repair the component providing “${issue.tool}”.`,
                    '  In Settings > General, set missing packages to “Always”, apply updates, then restart VS Code.',
                );
            } else {
                lines.push(
                    'TeX Live was detected. Open PowerShell and run:',
                    issue.tool === 'latexmk'
                        ? '  tlmgr install latexmk'
                        : `  tlmgr install ${enginePackage(issue.tool)}`,
                    'Then restart every VS Code window so the updated PATH is inherited.',
                );
            }
        } else {
            lines.push(
                `${platformName(issue.platform)} needs a TeX distribution containing ${issue.tool}.`,
                issue.platform === 'darwin'
                    ? 'Install or update MacTeX, then restart VS Code: https://tug.org/mactex/'
                    : 'Install or update TeX Live with your system package manager, then restart VS Code.',
            );
        }
    } else if (issue.kind === 'missing-tex-file') {
        if (windows) {
            lines.push(
                'If you use MiKTeX:',
                `  Open MiKTeX Console > Packages and search for “${issue.packageHint}” or “${issue.filename}”.`,
                '  Install the matching package. You can also enable automatic missing-package installation',
                '  in MiKTeX Console > Settings > General.',
                '',
                'If you use TeX Live, find the exact package first in PowerShell:',
                `  tlmgr search --global --file "/${issue.filename.replace(/\./g, '\\.')}"`,
                'Then install the package name printed by that search:',
                '  tlmgr install <package-name>',
                '',
                'Restart VS Code after changing a TeX installation or PATH, then compile again.',
            );
        } else {
            lines.push(
                'With TeX Live, find and install the package with:',
                `  tlmgr search --global --file "/${issue.filename.replace(/\./g, '\\.')}"`,
                '  tlmgr install <package-name>',
                'With MiKTeX, search for the filename in MiKTeX Console > Packages.',
            );
        }
    }
    lines.push('', `Detected platform: ${platformName(issue.platform)}.`, '');
    return lines.join('\n');
}

module.exports = {
    URLS,
    INSTALLABLE_TEX_FILE_EXTENSIONS,
    inferManager,
    missingToolIssue,
    missingFileFromMessage,
    missingFileKind,
    missingTexFileIssue,
    formatDependencyHelp,
};
