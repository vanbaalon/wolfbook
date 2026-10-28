'use strict';

// Comparison-only TeX tokens. Source bytes and offsets are never rewritten.
// Ordinary text spaces collapse; ordinary math spaces disappear. Explicit
// spacing, word boundaries, text inside math, and verbatim remain meaningful.
const MATH_ENVS = new Set(['math','displaymath','equation','equation*','align','align*',
    'alignat','alignat*','flalign','flalign*','gather','gather*','multline','multline*',
    'eqnarray','eqnarray*']);
const RAW_ENVS = new Set(['verbatim','verbatim*','Verbatim','BVerbatim','LVerbatim',
    'lstlisting','minted','alltt']);
const TEXT_COMMANDS = new Set(['text','textrm','textnormal','textup','textit','textsl',
    'textsc','textbf','textmd','textsf','texttt','mbox','hbox','operatorname']);

function contentTokens(value, opts = {}) {
    const text = String(value ?? '').replace(/\r\n?/g, '\n');
    const tokens = [], groups = [], envs = [];
    let math = !!opts.math, delimiter = null, textGroup = false, literalSpaces = !!opts.literalSpaces;
    let line = 0, col = 0, at = 0;
    const advance = end => {
        const chunk = text.slice(at, end), last = chunk.lastIndexOf('\n');
        if (last < 0) col += chunk.length;
        else { line += chunk.split('\n').length - 1; col = chunk.length - last - 1; }
        at = end;
    };
    const emit = (key, end, space = false) => {
        const previous = tokens[tokens.length - 1];
        if (space && (!previous || previous.space)) { advance(end); return; }
        // A comment consumes its newline, joining the words on either side.
        if (key.startsWith('text:') && previous?.key.startsWith('text:') &&
            previous.joinNext && !space) {
            previous.parts ||= [{word:previous.word,line:previous.line,col:previous.col}];
            previous.parts.push({word:text.slice(at,end),line,col});
            previous.word += text.slice(at,end);
            previous.key += key.slice(5); previous.end = end;
            previous.endLine=line;
            previous.len = end - previous.start; previous.joinNext = false;
        } else tokens.push({ key, word: space ? ' ' : text.slice(at,end),
            start:at, end, line, endLine:line+text.slice(at,end).split('\n').length-1,
            col, len:end-at, math, space, literal:key.startsWith('literal:'), literalSpaces });
        advance(end);
    };
    if (opts.literal) { emit('literal:'+text,text.length); return tokens; }
    while (at < text.length) {
        const c = text[at];
        if (c === '%') {
            const nl = text.indexOf('\n',at), end = nl < 0 ? text.length : nl + 1;
            advance(end);
            while (at < text.length && /[ \t]/.test(text[at])) advance(at+1);
            if (tokens.length) tokens[tokens.length-1].joinNext = true;
            continue;
        }
        if (/\s/.test(c)) {
            let end = at+1; while (end < text.length && /\s/.test(text[end])) end++;
            if (literalSpaces) emit('literal:'+text.slice(at,end),end);
            else if (math) advance(end);
            else emit('space',end,true);
            continue;
        }
        if (c === '\\') {
            const command = /^\\([A-Za-z@]+|[^\n])/.exec(text.slice(at));
            if (!command) { emit('char:\\',at+1); continue; }
            const name = command[1], end = at+command[0].length;
            if (name === 'verb') {
                let start = end; if (text[start] === '*') start++;
                const stop = text[start] && text.indexOf(text[start],start+1);
                emit('literal:'+text.slice(at,stop >= start ? stop+1 : end),stop >= start ? stop+1 : end);
                continue;
            }
            if (name === 'begin' || name === 'end') {
                const env = /^\s*\{([^{}]+)\}/.exec(text.slice(end));
                if (env) {
                    const finish = end+env[0].length, envName = env[1];
                    if (name === 'begin' && RAW_ENVS.has(envName)) {
                        const close = '\\end{'+envName+'}', stop = text.indexOf(close,finish);
                        const rawEnd = stop < 0 ? text.length : stop+close.length;
                        emit('literal:'+text.slice(at,rawEnd),rawEnd); continue;
                    }
                    emit('command:'+name+'{'+envName+'}',finish);
                    if (name === 'begin') { envs.push({name:envName,math}); if (MATH_ENVS.has(envName)) math=true; }
                    else {
                        const prior = envs.pop();
                        if (prior) math=prior.math;
                        else if (MATH_ENVS.has(envName)) math=false;
                    }
                    continue;
                }
            }
            emit('command:'+name,end);
            if (name === '(' || name === '[') { delimiter=name; math=true; }
            else if (name === ')' || name === ']') { delimiter=null; math=false; }
            if (TEXT_COMMANDS.has(name)) textGroup=true;
            // Unexpanded macros may make whitespace significant. Keep it
            // rather than silently hiding an edit in such a region.
            if (name === 'obeyspaces' || name === 'obeylines' || name === 'catcode') literalSpaces=true;
            if (/^[A-Za-z@]+$/.test(name)) {
                while (at < text.length && /\s/.test(text[at])) advance(at+1);
            }
            continue;
        }
        if (c === '$') {
            const mark = text[at+1] === '$' ? '$$' : '$';
            emit('delimiter:'+mark,at+mark.length);
            if (delimiter === mark) { math=false; delimiter=null; }
            else { math=true; delimiter=mark; }
            continue;
        }
        if (c === '{') {
            emit('char:{',at+1); groups.push({math,literalSpaces});
            if (textGroup) math=false;
            textGroup=false; continue;
        }
        if (c === '}') {
            emit('char:}',at+1); const prior=groups.pop();
            if (prior) { math=prior.math; literalSpaces=prior.literalSpaces; }
            continue;
        }
        textGroup=false;
        if (math || c === '~') {
            const char=String.fromCodePoint(text.codePointAt(at)); emit('char:'+char,at+char.length);
        } else {
            const word=/^[^\s\\{}$%~]+/.exec(text.slice(at))[0]; emit('text:'+word,at+word.length);
        }
    }
    return tokens;
}

function contentKey(tokens) {
    let start=0,end=tokens.length;
    while (start<end && tokens[start].space) start++;
    while (end>start && tokens[end-1].space) end--;
    return JSON.stringify(tokens.slice(start,end).map(t=>t.key));
}

function tokensInLines(tokens,startLine,endLine) {
    if (endLine<=startLine) return [];
    const first=startLine-1, last=endLine-1;
    let lo=0,hi=tokens.length;
    while (lo<hi) { const mid=(lo+hi)>>>1; if (tokens[mid].endLine<first) lo=mid+1; else hi=mid; }
    const start=lo;
    while (lo<tokens.length && tokens[lo].line<last) lo++;
    return tokens.slice(start,lo);
}

module.exports = { contentTokens, contentKey, tokensInLines };
