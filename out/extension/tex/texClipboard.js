// texClipboard.js — getting a screenshot out of the system clipboard.
//
// WHY THIS EXISTS AT ALL. VS Code has no API for reading an IMAGE from the
// clipboard: `env.clipboard` is text only. The supported route is a
// `DocumentPasteEditProvider`, and when that does not fire — reported twice on
// a real machine, with a screenshot in the clipboard and ⌘V doing nothing —
// there is no second API to fall back on. So the picture is fetched from the
// operating system, using the tool every platform already ships.
//
// macOS   osascript, which can hand back the clipboard as PNG data
// Windows  powershell's System.Windows.Forms.Clipboard
// Linux    wl-paste (Wayland) or xclip (X11)
//
// PURE, with the process runner injected: the command lines and the parsing are
// the part that can be wrong, and both are testable without a clipboard.

const os = require('os');
const path = require('path');

/**
 * AppleScript hands back `«data PNGf89504E47...»` — the bytes as hex inside a
 * raw-data literal. Everything outside the hex run is decoration, and the
 * guillemets are multi-byte, so the hex is taken by shape rather than by
 * position.
 */
function parseAppleScriptData(out) {
    const text = String(out || '');
    // THE TYPE CODE ENDS IN A HEX DIGIT, AND THAT COSTS A NIBBLE.
    //
    // The literal is «data PNGf89504E47…». Grabbing "the first long run of hex"
    // starts at the **f of PNGf** — f is a hex character — so every byte comes
    // out shifted by half a byte and the PNG signature never matches. Measured:
    // 75 bytes parsed, `looksLikePng` false, feature silently dead. The four
    // characters after `data ` are the type code and are skipped by name.
    let m = /\bdata\s+[A-Za-z0-9 ]{4}([0-9A-Fa-f]+)/.exec(text);
    if (!m) m = /([0-9A-Fa-f]{32,})/.exec(text);
    if (!m) return null;
    let hex = m[1];
    if (hex.length % 2) hex = hex.slice(0, -1);
    const buf = Buffer.from(hex, 'hex');
    return buf.length ? buf : null;
}

/** Is this actually a PNG? Cheap, and it keeps a stray string out of a file. */
function looksLikePng(buf) {
    return !!buf && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 &&
        buf[2] === 0x4e && buf[3] === 0x47;
}

/**
 * How to ask this platform for the clipboard image.
 *
 * @param {string} platform  process.platform
 * @param {string} tmpFile   somewhere the shell-out may write, when it must
 * @returns {{cmd:string, args:string[], via:'stdout-hex'|'file'}|null}
 */
function clipboardImageCommand(platform, tmpFile) {
    if (platform === 'darwin') {
        return {
            cmd: 'osascript',
            args: ['-e', 'the clipboard as «class PNGf»'],
            via: 'stdout-hex',
        };
    }
    if (platform === 'win32') {
        // -STA is REQUIRED: the clipboard is a single-threaded-apartment API and
        // powershell's default MTA returns nothing at all rather than failing.
        const ps = [
            'Add-Type -AssemblyName System.Windows.Forms;',
            '$i=[System.Windows.Forms.Clipboard]::GetImage();',
            'if($i -ne $null){',
            `$i.Save('${tmpFile.replace(/'/g, "''")}',`,
            '[System.Drawing.Imaging.ImageFormat]::Png); Write-Output "ok" }',
        ].join(' ');
        return { cmd: 'powershell', args: ['-NoProfile', '-STA', '-Command', ps], via: 'file' };
    }
    // Linux: Wayland first, then X11. Both write the bytes to stdout.
    return { cmd: 'sh', args: ['-c',
        `wl-paste --type image/png 2>/dev/null || xclip -selection clipboard -t image/png -o 2>/dev/null`],
    via: 'stdout-binary' };
}

/** Where a shell-out may drop a temporary PNG — never inside the project. */
function tempPngPath() {
    return path.join(os.tmpdir(), `wolfbook-clip-${process.pid}-${Date.now()}.png`);
}

/**
 * The clipboard's image, or null.
 *
 * @param {{run:(cmd:string,args:string[])=>{status:number,stdout:Buffer|string},
 *          readFile:(p:string)=>Buffer, exists:(p:string)=>boolean,
 *          unlink:(p:string)=>void, platform?:string, tmp?:string}} deps
 * @returns {Buffer|null}
 */
function readClipboardImage(deps) {
    const platform = deps.platform || process.platform;
    const tmp = deps.tmp || tempPngPath();
    const spec = clipboardImageCommand(platform, tmp);
    if (!spec) return null;
    let res;
    try { res = deps.run(spec.cmd, spec.args); } catch (_) { return null; }
    if (!res || (res.status !== 0 && res.status != null && spec.via !== 'stdout-binary')) {
        // An empty clipboard is not an error worth reporting: on macOS
        // osascript exits non-zero when the clipboard holds no PNG at all,
        // which is the ordinary case for a text paste.
        return null;
    }
    if (spec.via === 'stdout-hex') {
        const buf = parseAppleScriptData(res.stdout);
        return looksLikePng(buf) ? buf : null;
    }
    if (spec.via === 'stdout-binary') {
        const buf = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(String(res.stdout || ''), 'binary');
        return looksLikePng(buf) ? buf : null;
    }
    try {
        if (!deps.exists(tmp)) return null;
        const buf = deps.readFile(tmp);
        deps.unlink(tmp);
        return looksLikePng(buf) ? buf : null;
    } catch (_) { return null; }
}

module.exports = {
    readClipboardImage, clipboardImageCommand, parseAppleScriptData,
    looksLikePng, tempPngPath,
};
