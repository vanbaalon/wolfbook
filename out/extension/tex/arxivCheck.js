// arxivCheck.js — build a prepared arXiv package the way arXiv will.
//
// The package from arxivPack.js is written to a temporary folder and compiled
// there with the compiler 00README.json names, twice (for references), with
// no BibTeX or makeindex run — arXiv takes the .bbl and .ind as given — and no
// shell escape. What comes back says whether it built, how many pages, and
// the first TeX error with its line. Shared by WPaper and the WLaTeX desktop.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function run(bin, args, cwd, env, ms) {
    return new Promise((resolve) => {
        execFile(bin, args, { cwd, env, timeout: ms, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
            resolve({ code: error ? (error.code ?? 1) : 0, killed: !!(error && error.killed), stdout: String(stdout || '') });
        });
    });
}

/** The TeX Live year of the installed TeX, from `tex --version`. */
async function texliveYear(env = process.env) {
    const r = await run('tex', ['--version'], os.tmpdir(), withTexPath(env), 10000);
    const m = /TeX Live (\d{4})/.exec(r.stdout);
    return m ? Number(m[1]) : null;
}

function withTexPath(env) {
    const extra = process.platform === 'darwin' ? ['/Library/TeX/texbin', '/usr/local/texlive/2025/bin/universal-darwin'] : [];
    return { ...env, PATH: [...extra, env.PATH || ''].filter(Boolean).join(path.delimiter) };
}

/**
 * @param {Array<{name:string,data:Buffer}>} files  from prepareArxiv
 * @param {string} main       the top-level .tex
 * @param {string} compiler   pdflatex | xelatex | latex
 * @returns {Promise<{ok:boolean, pages:number|null, error:string|null, line:number|null, file:string|null}>}
 */
async function checkBuild(files, main, compiler, { env = process.env, timeoutMs = 180000 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-check-'));
    try {
        for (const f of files) {
            const target = path.join(dir, f.name);
            if (!target.startsWith(dir + path.sep)) continue;
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, f.data);
        }
        const bin = ['pdflatex', 'xelatex', 'latex'].includes(compiler) ? compiler : 'pdflatex';
        const args = ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', '-file-line-error', main];
        let last = null;
        for (let pass = 0; pass < 2; pass++) {
            last = await run(bin, args, dir, withTexPath(env), timeoutMs);
            if (last.code !== 0) break;
        }
        const job = main.replace(/\.tex$/i, '');
        let log = '';
        try { log = fs.readFileSync(path.join(dir, `${job}.log`), 'latin1'); } catch (_) { log = last ? last.stdout : ''; }
        const pages = /Output written on .*?\((\d+) pages?/.exec(log);
        const err = /^(?:(\.?\/?[^:\n]+):(\d+): |! )(.+)$/m.exec(log);
        // TeX wraps its log at 79 columns: the message continues on the next
        // lines until a blank one or TeX's own help.
        if (err) {
            const rest = log.slice(err.index + err[0].length + 1).split('\n');
            let text = err[3];
            for (const l of rest.slice(0, 4)) {
                if (!l.trim() || /^(See the|Type |l\.\d|\s*\.\.\.)/.test(l)) break;
                text += l;
            }
            err[3] = text;
        }
        const ok = !!last && last.code === 0 && !!pages;
        return {
            ok,
            pages: pages ? Number(pages[1]) : null,
            error: ok ? null : (last && last.killed ? 'the build ran over its time limit' : (err ? err[3].trim() : 'the build failed')),
            line: !ok && err && err[2] ? Number(err[2]) : null,
            file: !ok && err && err[1] ? err[1].replace(/^\.\//, '') : null,
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Prepare the paper and build the package as arXiv will. With no declared
 * engine and pdflatex failing, xelatex is tried; the one that builds is what
 * 00README.json names.
 *
 * @param {object} o  prepareArxiv's inputs, without `engine` / `texliveYear`
 * @returns {Promise<{result: {files, report}, check: object|null}>}
 */
async function prepareAndCheck(o, { onStep = () => {} } = {}) {
    const { prepareArxiv, chooseEngine } = require('./arxivPack');
    const year = await texliveYear().catch(() => null);
    const first = chooseEngine(o.read(o.main));
    onStep(`collecting what the paper uses (${first})`);
    const result = prepareArxiv({ ...o, engine: first, texliveYear: year });
    if (result.report.errors.length) return { result, check: null };
    onStep(`building it as arXiv will (${result.report.compiler}, twice)`);
    const check = await checkBuild(result.files, o.main, result.report.compiler);
    if (!check.ok && first === 'pdflatex') {
        onStep('pdflatex did not build it: trying xelatex');
        const again = prepareArxiv({ ...o, engine: 'xelatex', texliveYear: year });
        const second = again.report.errors.length ? null : await checkBuild(again.files, o.main, 'xelatex');
        if (second && second.ok) {
            again.report.warnings.push(`pdflatex does not build it (${check.error}); xelatex does, and 00README.json names it`);
            return { result: again, check: second };
        }
    }
    return { result, check };
}

module.exports = { checkBuild, texliveYear, prepareAndCheck };
