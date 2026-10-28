const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BitmapFonts, decodePk, outline } = require('../../tex/bitmapFont');
const { NativeBuildLane } = require('../../tex/nativeCompileService');

const integer = (v, n) => { const b = Buffer.alloc(n); b.writeUIntBE(v < 0 ? v + 2 ** (n * 8) : v, 0, n); return b; };
function pk({ form = 0, packed = false } = {}) {
    const raster = Buffer.from(packed ? [0x22, 0xf1, 0x10] : [0b10101000]);
    const size = form < 4 ? 1 : form < 7 ? 2 : 4;
    const body = Buffer.concat([integer(65, form === 7 ? 4 : 1), integer(2 ** 19, form === 7 ? 4 : 3),
        Buffer.alloc(form < 4 ? 1 : form < 7 ? 2 : 8), integer(3, size), integer(packed ? 3 : 2, size),
        integer(-1, size), integer(2, size), raster]);
    const packet = body.length - (form === 7 ? 4 : 1);
    return Buffer.concat([Buffer.from([247, 89, 0]), Buffer.alloc(16),
        Buffer.from([(packed ? 13 * 16 + 8 : 14 * 16) | form]),
        integer(packet, form < 4 ? 1 : form < 7 ? 2 : 4), body, Buffer.from([245])]);
}

test('PK bitmap rows cross byte boundaries and all packet sizes keep signed offsets', () => {
    for (const form of [0, 4, 7]) {
        const glyph = decodePk(pk({ form })).get(65);
        assert.deepEqual(glyph.rows.map(row => [...row]), [[1, 0, 1], [0, 1, 0]]);
        assert.equal(glyph.hoff, -1);
        const result = outline(glyph, 100);
        assert.equal(result.advance, 50);
        assert.equal(result.units_per_em, 100);
        assert.equal(result.path, 'M1 3h1v-1h-1zM3 3h1v-1h-1zM2 2h1v-1h-1z');
    }
});

test('PK packed runs continue across rows and repeat the completed row', () => {
    for (const form of [0, 4, 7]) assert.deepEqual(decodePk(pk({ form, packed: true })).get(65).rows.map(row => [...row]),
        [[1, 1, 0], [0, 1, 0], [0, 1, 0]]);
});

test('truncated and invalid PK inputs fail rather than drawing missing pixels', () => {
    const data = pk();
    for (let n = 0; n < data.length; n++) assert.throws(() => decodePk(data.subarray(0, n)));
    assert.throws(() => decodePk(Buffer.from('not a font')));
    const invalid = Buffer.from(data); invalid[19] = 255;
    assert.throws(() => decodePk(invalid));
});

test('bitmap lookups share one asynchronous load, match the PDF DPI, and cache across typing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-pk-test-'));
    const file = path.join(dir, 'font.pk'); fs.writeFileSync(file, pk());
    const calls = [];
    const fonts = new BitmapFonts({ tool: async (name, args) => { calls.push([name, args]); return file; } });
    const font = { kind: 'tfm', name: 'bbm10', size_sp: 717619, design_size_sp: 655360 };
    try {
        const [a, b] = await Promise.all([fonts.outlines(font, [65]), fonts.outlines(font, [65, 66])]);
        assert.deepEqual(a[65], b[65]);
        assert.equal(b[66], null);
        await fonts.outlines(font, [65]);
        assert.deepEqual(calls, [['kpsewhich', ['--dpi=657', '--format=pk', 'bbm10.pk']]]);
        assert.ok(Math.abs(a[65].units_per_em - font.size_sp / 65536 * 657 / 72.27) < 1e-9);
        await assert.rejects(fonts.outlines({ ...font, name: '../bad' }, [65]));
        await assert.rejects(fonts.outlines({ ...font, name: '--help' }, [65]));
        await assert.rejects(fonts.outlines({ ...font, design_size_sp: 0 }, [65]));
        assert.equal(calls.length, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing bitmap is generated once in the TeX cache; failed loads can retry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-pk-test-'));
    const file = path.join(dir, 'font.pk'); fs.writeFileSync(file, pk());
    const calls = []; let fails = true, ready = false;
    const fonts = new BitmapFonts({ tool: async (name, args) => {
        calls.push([name, args]);
        if (fails) throw Error('temporarily unavailable');
        if (name === 'mktexpk') { ready = true; return ''; }
        return ready ? file : '';
    } });
    const font = { kind: 'tfm', name: 'bbm10', size_sp: 655360, design_size_sp: 655360 };
    try {
        await assert.rejects(fonts.outlines(font, [65])); fails = false;
        assert.ok((await fonts.outlines(font, [65]))[65].path);
        await fonts.outlines(font, [65]);
        assert.deepEqual(calls.map(c => c[0]), ['kpsewhich', 'kpsewhich', 'mktexpk', 'kpsewhich']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the native lane records the exact font definition and uses bitmaps only for unresolved TFM fonts', async () => {
    const lane = Object.create(NativeBuildLane.prototype);
    lane.session = { interactive: {}, outlines: async () => ({ vector: true }) };
    const font = { definition_digest: 'bitmap', kind: 'tfm', name: 'bbm10', size_sp: 655360, design_size_sp: 655360 };
    lane._rememberLiveFonts({ fonts: { bitmap: { file: null }, vector: { file: 'cmr10.pfb' } },
        txdl: { fonts: [font, { ...font, definition_digest: 'vector', name: 'cmr10' }] } });
    lane._rememberLiveFonts({ txdl: { fonts: [{ ...font, definition_digest: 'vector', name: 'cmr10' }] } });
    let bitmapCalls = 0;
    lane._bitmapFonts = { outlines: async (definition, gids) => {
        bitmapCalls++; assert.equal(definition.file, null); assert.deepEqual(gids, [49]); return { bitmap: true };
    } };
    assert.deepEqual(await lane.outlines('bitmap', [49]), { bitmap: true });
    assert.deepEqual(await lane.outlines('vector', [49]), { vector: true });
    assert.deepEqual(await lane.outlines('unknown', [49]), { vector: true });
    assert.equal(bitmapCalls, 1);
});
