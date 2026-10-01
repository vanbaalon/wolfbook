#!/usr/bin/env node
'use strict';

// measure-reopen.cjs — what a second `open` (a settled build landing) costs
// the webview's main thread, on a real paper.
//
//   node out/extension/kernel/tests/webview/measure-reopen.cjs gen1.pdf [gen2.pdf]
//        [--page 20] [--range] [--hashes] [--no-live] [--window 5000] [--latency 2]
//        [--json out.json] [--cpu 4]
//
// It loads the shipped panel exactly as harness.cjs does (the host's own
// _html, headless Chrome), opens gen1.pdf as generation 1, scrolls to --page,
// waits until the panel is idle (text sweep done, no long task for 1 s), then
// posts generation 2 (gen2.pdf, or the same bytes) with the fields
// TexViewer.refresh() sends, and records for --window ms after that post:
//   - long tasks (PerformanceObserver 'longtask') and rAF gaps,
//   - a main-thread CPU profile (CDP Profiler), summarised by self time,
//   - when the visible page's canvas was replaced, when `opened`, the
//     `timing` marks, and when `textLayerDone` was posted.
//
// --range      emulate the native lane's byte-range transport (pdfRange /
//              pdfRangeRequest answered from Node, --latency ms per answer)
//              instead of pdfBase64.
// --hashes     send nativePageHashes (per-page text hashes from pdftotext —
//              an emulation of the engine's page hashes), so unchanged pages
//              are retained as the native lane allows.
// --cpu N      throttle the page's CPU N× for the second open (a slower machine).
// --no-live    send live:false (a classic, non-live compile) instead of live:true.
//
// Headless only; never opens a window.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { hostHtml, serve, loadPlaywright, chromePath, CLIENT } = require('./harness.cjs');

function args() {
    const a = process.argv.slice(2);
    const o = { pdfs: [], page: 20, range: false, hashes: false, live: true, window: 5000, latency: 2, json: null, cpu: 1 };
    for (let i = 0; i < a.length; i++) {
        const k = a[i];
        if (k === '--page') o.page = Number(a[++i]);
        else if (k === '--range') o.range = true;
        else if (k === '--hashes') o.hashes = true;
        else if (k === '--no-live') o.live = false;
        else if (k === '--window') o.window = Number(a[++i]);
        else if (k === '--latency') o.latency = Number(a[++i]);
        else if (k === '--json') o.json = a[++i];
        else if (k === '--cpu') o.cpu = Number(a[++i]);
        else o.pdfs.push(k);
    }
    if (!o.pdfs.length) { console.error('usage: measure-reopen.cjs gen1.pdf [gen2.pdf] [--page N] [--range] [--hashes] [--no-live]'); process.exit(2); }
    return o;
}

function pageHashes(pdf) {
    const n = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }))[1]);
    const out = [];
    for (let p = 1; p <= n; p++) {
        const text = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), '-layout', pdf, '-'], { encoding: 'utf8' });
        out.push(crypto.createHash('sha256').update(text).digest('hex'));
    }
    return out;
}

function summariseProfile(profile, top = 15) {
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const self = new Map();
    const { samples, timeDeltas } = profile;
    for (let i = 0; i < samples.length; i++) {
        const dt = (timeDeltas[i + 1] ?? 0) / 1000;           // the sample's own interval, ms
        self.set(samples[i], (self.get(samples[i]) || 0) + dt);
    }
    const agg = new Map();
    let total = 0, idle = 0;
    for (const [id, ms] of self) {
        const cf = byId.get(id).callFrame;
        const name = cf.functionName || '(anonymous)';
        if (name === '(idle)') { idle += ms; continue; }
        total += ms;
        const where = cf.url ? `${path.basename(cf.url.split('?')[0])}:${cf.lineNumber + 1}` : '';
        const key = `${name} ${where}`.trim();
        agg.set(key, (agg.get(key) || 0) + ms);
    }
    return { busyMs: total, idleMs: idle,
        top: [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, ms]) => ({ fn: k, ms: +ms.toFixed(1) })) };
}

async function main() {
    const o = args();
    const bytes = o.pdfs.map(p => fs.readFileSync(p));
    const gen2 = bytes[1] || bytes[0];
    const hashes = o.hashes ? o.pdfs.map(pageHashes) : null;
    const pageCount = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [o.pdfs[o.pdfs.length - 1]], { encoding: 'utf8' }))[1]);

    let indexHtml = '';
    const server = await serve(() => indexHtml);
    const origin = `http://127.0.0.1:${server.address().port}`;
    indexHtml = hostHtml(origin);
    const { pw } = loadPlaywright();
    const exe = chromePath();
    const browser = await pw.chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e)));

    // The host side of the range transport: bytes read and encoded here, off
    // the page's thread, as the extension host does.
    const files = new Map();
    await page.exposeBinding('__hostRange', async (_src, token, begin, end) => {
        const buf = files.get(token);
        await new Promise(r => setTimeout(r, o.latency));
        return buf.subarray(begin, end).toString('base64');
    });
    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(() => window.__all && window.__all.some(m => m.type === 'ready'));
    await page.evaluate(() => {
        const arr = window.__posted, push = arr.push.bind(arr);
        arr.push = (m) => {
            if (m && m.type === 'pdfRangeRequest') {
                window.__hostRange(m.token, m.begin, m.end).then(data =>
                    window.postMessage({ type: 'pdfRange', token: m.token, request: m.request, begin: m.begin, data }, '*'));
            }
            return push(m);
        };
    });

    const openMsg = (generation, buf, pageHash, live) => {
        const msg = { type: 'open', base: `${origin}/pdfjs`, generation,
            pdfHash: crypto.createHash('sha256').update(buf).digest('hex'),
            nativePageHashes: pageHash || null, pages: pageCount, live,
            revealPage: undefined, revealFrac: undefined, restoreView: null, bookmarks: [],
            navigationOwner: 'editor', semanticReveal: null };
        if (o.range) {
            const token = crypto.randomUUID();
            files.set(token, buf);
            msg.pdfRange = { token, length: buf.length };
            msg.pdfBase64 = null;
        } else msg.pdfBase64 = buf.toString('base64');
        return msg;
    };

    // --- generation 1, scrolled to the page, idle ---------------------------
    const m1 = openMsg(1, bytes[0], hashes && hashes[0], false);
    await page.evaluate(m => window.postMessage(m, '*'), m1);
    await page.waitForFunction(() => window.__all.some(m => m.type === 'textLayerDone' && m.generation === 1), null, { timeout: 120000 });
    await page.evaluate(n => {
        const w = document.querySelector(`.page[data-page="${n}"]`);
        document.querySelector('main').scrollTop = w.offsetTop - 10;
    }, o.page);
    await page.waitForFunction(n => !!document.querySelector(`.page[data-page="${n}"] canvas:not(.txdl-overlay)`), o.page, { timeout: 30000 });
    // Idle: no long task for a whole second.
    await page.evaluate(() => new Promise(resolve => {
        let last = performance.now();
        new PerformanceObserver(list => { for (const e of list.getEntries()) last = Math.max(last, e.startTime + e.duration); })
            .observe({ type: 'longtask' });
        const check = () => (performance.now() - last > 1000 ? resolve() : setTimeout(check, 100));
        setTimeout(check, 100);
    }));
    const pagesRendered1 = await page.evaluate(() => document.querySelectorAll('.page canvas:not(.txdl-overlay)').length);

    // --- generation 2 ------------------------------------------------------
    const cdp = await context.newCDPSession(page);
    await cdp.send('Profiler.enable');
    if (o.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: o.cpu });
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    const m2 = openMsg(2, gen2, hashes && (hashes[1] || hashes[0]), o.live);
    await page.evaluate(([msg, n]) => {
        const rec = window.__measure = { longtasks: [], frames: [], canvasSwaps: [], t0: 0 };
        new PerformanceObserver(list => { for (const e of list.getEntries()) rec.longtasks.push([e.startTime, e.duration]); })
            .observe({ type: 'longtask' });
        // The visible page is repainted when its canvas is a different one;
        // a frame where it has none is a blank frame.
        const canvasOf = () => document.querySelector(`.page[data-page="${n}"] canvas:not(.txdl-overlay)`);
        const before = canvasOf();
        rec.blankFrames = 0;
        const tick = (t) => {
            rec.frames.push(t);
            const c = canvasOf();
            if (!c) rec.blankFrames++;
            else if (c !== before && !rec.canvasSwaps.length) rec.canvasSwaps.push(t);
            if (!rec.stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        window.__clearPosted();
        rec.t0 = performance.now();
        window.postMessage(msg, '*');
    }, [m2, o.page]);
    await cdp.send('Profiler.start');
    const deadline = Date.now() + Math.max(o.window, 1000);
    while (Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    const { profile } = await cdp.send('Profiler.stop');
    // Keep waiting (unprofiled) for the sweep, to time it.
    await page.waitForFunction(() => window.__posted.some(m => m.type === 'textLayerDone' && m.generation === 2), null, { timeout: 120000 }).catch(() => {});
    const r = await page.evaluate(([win]) => {
        const rec = window.__measure; rec.stop = true;
        const rel = t => +(t - rec.t0).toFixed(1);
        const inWin = rec.longtasks.filter(([s]) => s - rec.t0 <= win);
        const at = (type) => { const k = window.__posted.findIndex(m => m.type === type && m.generation === 2);
            return k >= 0 ? rel(window.__postedAt[k]) : null; };
        const gaps = []; for (let i = 1; i < rec.frames.length; i++) if (rec.frames[i] - rec.t0 <= win) gaps.push(rec.frames[i] - rec.frames[i - 1]);
        const timing = window.__posted.find(m => m.type === 'timing' && m.kind === 'open' && m.generation === 2);
        const done = window.__posted.find(m => m.type === 'textLayerDone' && m.generation === 2);
        const worker = window.__all.find(m => m.type === 'timing' && m.worker)?.worker;
        return {
            longtasks: { count: inWin.length, totalMs: +inWin.reduce((s, [, d]) => s + d, 0).toFixed(0),
                blockedOver50Ms: +inWin.reduce((s, [, d]) => s + Math.max(0, d - 50), 0).toFixed(0),
                longestMs: +Math.max(0, ...inWin.map(([, d]) => d)).toFixed(0),
                top: inWin.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, d]) => `${rel(s)}ms+${d.toFixed(0)}`) },
            frames: { count: gaps.length, maxGapMs: +Math.max(0, ...gaps).toFixed(0), gapsOver100: gaps.filter(g => g > 100).length },
            visibleCanvasSwapMs: rec.canvasSwaps.length ? rel(rec.canvasSwaps[0]) : null, blankFrames: rec.blankFrames,
            openedMs: at('opened'), textLayerDoneMs: at('textLayerDone'),
            sweepMsReported: done ? done.ms : null, sweepReusedPages: done ? done.reusedPages.length : null,
            openMarks: timing ? timing.marks : null, reusedPages: timing ? timing.reusedPages.length : null,
            transport: timing ? timing.transport : null, worker,
            textLayerMessages: window.__posted.filter(m => m.type === 'textLayer').length,
        };
    }, [o.window]);
    const prof = summariseProfile(profile);
    const out = { options: { ...o, pdfs: o.pdfs }, pagesRenderedBefore: pagesRendered1, ...r, profile: prof, pageErrors: errors.slice(0, 5) };
    if (o.json) fs.writeFileSync(o.json, JSON.stringify(out, null, 2));
    console.log(`client ${CLIENT}`);
    console.log(`${o.range ? 'range' : 'base64'}${o.hashes ? ' + page hashes' : ''}, live:${o.live}, page ${o.page}, worker ${r.worker}, pages rendered before: ${pagesRendered1}`);
    console.log(`long tasks in ${o.window} ms: ${r.longtasks.count}, total ${r.longtasks.totalMs} ms (blocking >50: ${r.longtasks.blockedOver50Ms} ms), longest ${r.longtasks.longestMs} ms; top ${r.longtasks.top.join(', ')}`);
    console.log(`frames: ${r.frames.count}, max gap ${r.frames.maxGapMs} ms, gaps >100 ms: ${r.frames.gapsOver100}`);
    console.log(`visible page repainted (new canvas on screen) at ${r.visibleCanvasSwapMs} ms, blank frames ${r.blankFrames}; opened ${r.openedMs} ms; textLayerDone ${r.textLayerDoneMs} ms (sweep ${r.sweepMsReported} ms, ${r.sweepReusedPages} reused, ${r.textLayerMessages} textLayer msgs); retained pages ${r.reusedPages}`);
    console.log(`open marks: ${(r.openMarks || []).join(', ')}`);
    console.log(`main-thread CPU in window: busy ${prof.busyMs.toFixed(0)} ms, idle ${prof.idleMs.toFixed(0)} ms; top self time:`);
    for (const t of prof.top) console.log(`  ${String(t.ms).padStart(7)} ms  ${t.fn}`);
    if (errors.length) console.log('page errors: ' + errors.slice(0, 3).join(' | '));
    await browser.close();
    server.close();
}

main().catch(e => { console.error(e && e.stack || e); process.exit(2); });
