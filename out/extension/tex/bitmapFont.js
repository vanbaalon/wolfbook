// METAFONT-only fonts (e.g. bbm10) have PK bitmaps, rather than a PFB/OTF
// outline. Turn their actual black pixels into paths for the live renderer.
// The PDF producer uses the same 600-dpi bitmap scaled to the font size.
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function decodePk(data) {
    let at = 0;
    const take = n => {
        if (n < 0 || at + n > data.length) throw Error('short PK font');
        const part = data.subarray(at, at + n); at += n; return part;
    };
    const u = n => [...take(n)].reduce((v, b) => v * 256 + b, 0);
    const s = n => { const v = u(n); return v >= 2 ** (n * 8 - 1) ? v - 2 ** (n * 8) : v; };
    if (u(1) !== 247 || u(1) !== 89) throw Error('not a PK font');
    take(u(1) + 16); // comment, design size, checksum and resolutions
    const glyphs = new Map();
    while (at < data.length) {
        const flag = u(1);
        if (flag === 245) return glyphs;
        if (flag === 246) continue;
        if (flag >= 240 && flag <= 243) { take(u(flag - 239)); continue; }
        if (flag === 244) { take(4); continue; }
        if (flag >= 247) throw Error('invalid PK command');
        const form = flag & 7, dyn = flag >> 4;
        if (dyn > 14) throw Error('invalid PK packing');
        const packet = form < 4 ? (form * 256 + u(1)) : form < 7 ? ((form & 3) * 65536 + u(2)) : u(4);
        const code = u(form === 7 ? 4 : 1);
        const advance = u(form === 7 ? 4 : 3) / 2 ** 20;
        take(form < 4 ? 1 : form < 7 ? 2 : 8); // pixel escapement(s)
        const size = form < 4 ? 1 : form < 7 ? 2 : 4;
        const width = u(size), height = u(size), hoff = s(size), voff = s(size);
        const raster = take(packet - (form < 4 ? 8 : form < 7 ? 13 : 28));
        if (width * height > 1000000) throw Error('PK glyph too large');
        const rows = [];
        if (dyn === 14) {
            if (raster.length * 8 < width * height) throw Error('short PK bitmap');
            for (let y = 0; y < height; y++) {
                const row = new Uint8Array(width);
                for (let x = 0; x < width; x++) {
                    const bit = y * width + x;
                    row[x] = (raster[bit >> 3] >> (7 - (bit & 7))) & 1;
                }
                rows.push(row);
            }
        } else if (width && height) {
            let nibbleAt = 0;
            const nibble = () => {
                if (nibbleAt >= raster.length * 2) throw Error('short PK runs');
                const b = raster[nibbleAt >> 1];
                return nibbleAt++ % 2 ? b & 15 : b >> 4;
            };
            const packed = (depth = 0) => {
                if (depth > 16) throw Error('invalid PK repeat');
                const i = nibble();
                if (i === 0) {
                    let zeros = 0, v = 0;
                    while (!v) { v = nibble(); if (++zeros > 8) throw Error('invalid PK run'); }
                    for (let j = 0; j < zeros; j++) v = v * 16 + nibble();
                    return [v - 15 + (13 - dyn) * 16 + dyn, null];
                }
                if (i <= dyn) return [i, null];
                if (i < 14) return [(i - dyn - 1) * 16 + nibble() + dyn + 1, null];
                const repeat = i === 14 ? packed(depth + 1)[0] : 1;
                const [length, more] = packed(depth + 1);
                if (more != null) throw Error('nested PK repeat');
                return [length, repeat];
            };
            let x = 0, black = !!(flag & 8), repeat = 0;
            const row = new Uint8Array(width);
            while (rows.length < height) {
                let [length, rep] = packed();
                if (rep != null) repeat = rep;
                if (!(length > 0 && Number.isSafeInteger(length))) throw Error('invalid PK run');
                while (length > 0 && rows.length < height) {
                    const count = Math.min(length, width - x);
                    row.fill(black ? 1 : 0, x, x + count);
                    x += count; length -= count;
                    if (x === width) {
                        for (let n = 0; n <= repeat && rows.length < height; n++) rows.push(row.slice());
                        x = 0; repeat = 0;
                    }
                }
                black = !black;
            }
        }
        glyphs.set(code, { width, height, hoff, voff, advance, rows });
    }
    throw Error('PK font has no end');
}

function outline(glyph, unitsPerEm) {
    const path = [];
    for (let y = 0; y < glyph.rows.length; y++) {
        const row = glyph.rows[y];
        for (let x = 0; x < row.length;) {
            if (!row[x]) { x++; continue; }
            const begin = x;
            while (x < row.length && row[x]) x++;
            const left = begin - glyph.hoff, top = glyph.voff + 1 - y;
            path.push(`M${left} ${top}h${x - begin}v-1h${begin - x}z`);
        }
    }
    return { units_per_em: unitsPerEm, advance: glyph.advance * unitsPerEm, path: path.join('') };
}

async function texTool(name, args) {
    const mac = `/Library/TeX/texbin/${name}`;
    const executable = process.platform === 'darwin' && await fs.access(mac).then(() => true, () => false) ? mac : name;
    try { return (await run(executable, args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })).stdout.trim(); }
    catch (error) { if (name === 'kpsewhich' && error.code === 1) return ''; throw error; }
}

class BitmapFonts {
    constructor({ tool = texTool } = {}) { this.tool = tool; this.fonts = new Map(); }
    async outlines(font, codes) {
        if (!font || font.kind !== 'tfm' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(font.name) ||
            !(font.size_sp > 0 && font.design_size_sp > 0)) throw Error('not a bitmap font');
        const dpi = Math.round(600 * font.size_sp / font.design_size_sp);
        if (dpi < 1 || dpi > 10000) throw Error('invalid bitmap resolution');
        const key = `${font.name}@${dpi}`;
        let job = this.fonts.get(key);
        if (!job) {
            job = (async () => {
                const args = [`--dpi=${dpi}`, '--format=pk', `${font.name}.pk`];
                let file = await this.tool('kpsewhich', args);
                if (!file) {
                    await this.tool('mktexpk', ['--mfmode', 'ljfour', '--bdpi', '600', '--mag', `${dpi}/600`, '--dpi', String(dpi), font.name]);
                    file = await this.tool('kpsewhich', args);
                }
                if (!file) throw Error('bitmap font unresolved');
                if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw Error('PK font too large');
                return decodePk(await fs.readFile(file));
            })();
            if (this.fonts.size >= 256) this.fonts.delete(this.fonts.keys().next().value);
            this.fonts.set(key, job);
            job.catch(() => { if (this.fonts.get(key) === job) this.fonts.delete(key); });
        }
        const glyphs = await job, units = font.size_sp / 65536 * dpi / 72.27;
        return Object.fromEntries(codes.map(code => [code, glyphs.has(code) ? outline(glyphs.get(code), units) : null]));
    }
}

module.exports = { BitmapFonts, decodePk, outline };
