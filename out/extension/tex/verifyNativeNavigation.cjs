#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const os = require('node:os');

async function main() {
  if (![3, 4].includes(process.argv.length)) throw Error('usage: verifyNativeNavigation.cjs WLATEX_CHECKOUT [MAGNIFICATION]');
  const magnification = Number(process.argv[3] || 1000);
  assert.ok([1000, 1200].includes(magnification));
  const checkout = path.resolve(__dirname, '../../..');
  const root = path.resolve(process.argv[2]);
  const { NativeCompiler, NativeSourceSession } = require(path.join(root, 'integrations/wpaper'));
  const adapter = path.join(checkout, 'out/extension/tex/nativeMap.js');
  const { NativeMap } = require(adapter);
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'wpaper-native-navigation-'));
  const project = path.join(run, 'project');
  await fs.mkdir(project);
  const entry = path.join(project, 'paper.tex');
  const text = `\\mag=${magnification}\n\\documentclass{article}\n\\begin{document}\nAlpha\n\\end{document}\n`;
  await fs.writeFile(entry, text);
  const labBinary = path.join(root, 'target/debug/wlatex-lab');
  const compiler = new NativeCompiler({ labBinary,
    nativeBinary: path.join(root, 'native-lab/target/release/wlatex-native-lab'), cache: path.join(run, 'cache') });
  const source = new NativeSourceSession({ labBinary });
  try {
    await source.open('paper.tex', text);
    const captured = await source.capture();
    const report = await compiler.compile({ main: entry, root: project, generation: 1 });
    assert.equal(report.success, true);
    await source.publish(report, captured);
    const view = await source.readPages([1]);
    assert.equal(view.pages[0].header.magnification, magnification);
    const options = { nativeSource: source, generation: { pdfHash: report.build.pdf_hash, projectDir: project } };
    const map = new NativeMap({ ...options, nativeView: view });
    const rows = map.lineRows(entry, 4);
    assert.equal(rows.length, 1);
    const xml = execFileSync('pdftotext', ['-bbox', report.pdf, '-'], { encoding: 'utf8' });
    const word = /<word xMin="([^"]+)" yMin="([^"]+)" xMax="([^"]+)" yMax="([^"]+)">Alpha<\/word>/.exec(xml);
    assert.ok(word, 'Poppler did not find the expected native word');
    const [x0, y0, x1, y1] = word.slice(1).map(Number);
    assert.ok(Math.abs(rows[0].x - x0) < 0.1, 'native left edge differs from PDF');
    assert.ok(Math.abs(rows[0].x + rows[0].w - x1) < 0.1, 'native right edge differs from PDF');
    const glyph = map.glyphsForLine(entry, 4)[0];
    const x = glyph.x + glyph.w/2, y = glyph.y + glyph.boxHeight/2;
    assert.ok(x >= x0 && x <= x1 && y >= y0 && y <= y1, 'native point falls outside Poppler word');
    const inverse = map.renderToSource(1, x, y);
    assert.equal(inverse.file, entry);
    assert.equal(inverse.line, 4);
    assert.equal(inverse.generationLine, 4);
    assert.equal(inverse.column, 0);
    assert.equal(map.lineMap({ file: entry, line: 4, lines: text.split('\n') }).tokens.length, 5);
    const cursor = await map.forwardAt(entry, 4, 0);
    assert.ok(cursor.some(r => x >= r.x && x <= r.x+r.w && y >= r.y && y <= r.y+r.h));
    await source.edit('paper.tex', 0, 0, '% moved\n');
    assert.equal(map.available, false);
    const refreshed = new NativeMap({ ...options, nativeView: await source.readPages([1]) });
    const translated = refreshed.renderToSource(1, x, y);
    assert.equal(translated.line, 5);
    assert.equal(translated.column, 0);
    assert.ok((await refreshed.forwardAt(entry, 5, 0)).length > 0);
    const offset = ('% moved\n' + text).indexOf('Alpha') + 1;
    await source.edit('paper.tex', offset, offset, 'NEW');
    const inserted = new NativeMap({ ...options, nativeView: await source.readPages([1]) });
    assert.deepEqual(await inserted.forwardAt(entry, 5, 2), [], 'inserted text cannot borrow old glyph geometry');
    assert.ok((await inserted.forwardAt(entry, 5, 0)).length > 0, 'surviving source still maps');
    const { makeVscodeStub } = require(path.join(checkout, 'out/extension/kernel/tests/_stub-vscode.js'));
    const stub = makeVscodeStub();
    stub.Position = class { constructor(line, character) { this.line=line; this.character=character; } };
    stub.Range = class { constructor(start, end) { this.start=start; this.end=end; } };
    stub.Selection = stub.Range;
    stub.TextEditorRevealType = { InCenterIfOutsideViewport:0 };
    const editedText = source.files.get('paper.tex').text;
    const doc = { uri:{ fsPath:entry }, version:3, lineCount:editedText.split('\n').length,
      getText:() => editedText, lineAt:i => ({ text:editedText.split('\n')[i] }) };
    const editor = { document:doc, revealRange() {} };
    stub.workspace.openTextDocument = async () => doc;
    stub.window.showTextDocument = async () => editor;
    const originalLoad = Module._load;
    Module._load = function (name, ...args) { return name === 'vscode' ? stub : originalLoad.call(this, name, ...args); };
    let TexViewer;
    try { ({ TexViewer } = require(path.join(checkout, 'out/extension/tex/texViewer.js'))); }
    finally { Module._load = originalLoad; }
    const state = { root:entry, map:inserted, sourceAhead:true };
    const viewer = { root:entry, panel:{}, coord:{ roots:new Map([[entry,state]]) },
      _openedPdfHash:report.build.pdf_hash, _openedGeneration:1, _tracePaused:true, _post() {}, _rememberCursor() {},
      _postEditSelection() {}, _jumpToNativeSource:TexViewer.prototype._jumpToNativeSource };
    const secondGlyph = inserted.glyphsForLine(entry, 5).find(g => g.hit.preferred_source?.location.start.column_utf16 === 4);
    assert.ok(secondGlyph, 'surviving second character follows inserted text');
    await TexViewer.prototype._jumpToSource.call(viewer, { generation:1, page:1,
      xBp:secondGlyph.x+secondGlyph.w/2, yTopBp:secondGlyph.y+secondGlyph.boxHeight/2 });
    assert.equal(editor.selection.start.line, 4);
    assert.equal(editor.selection.start.character, 4);
    assert.equal(editor.selection.end.character, 4);
    process.stdout.write(JSON.stringify({ result: 'PASS', run, magnification,
      adapter_sha256: createHash('sha256').update(await fs.readFile(adapter)).digest('hex'),
      viewer_sha256: createHash('sha256').update(await fs.readFile(path.join(checkout, 'out/extension/tex/texViewer.js'))).digest('hex'),
      native_pdf_geometry_checked_with_poppler: true, native_inverse_column_verified: true,
      native_column_map_verified: true, stale_view_invalidated: true, edited_view_translated: true,
      native_inverse_viewer_handler_verified: true, native_cursor_worker_admission: true, inserted_source_has_no_old_geometry: true }, null, 2) + '\n');
  } finally { await Promise.all([compiler.close(), source.close()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
