// Only host-admitted immutable PDFs can be read. Requests never contain paths.
const fs = require('fs');
const { randomUUID } = require('crypto');
class PdfRangeStore {
    constructor() { this.files = new Map(); }
    open(file) {
        const fd = fs.openSync(file, 'r');
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) throw Error('Invalid PDF resource');
            const token = randomUUID();
            this.files.set(token, { fd, length:stat.size });
            return { token, length:stat.size };
        } catch (error) { fs.closeSync(fd); throw error; }
    }
    read(message) {
        const { token, request, begin, end } = message;
        try {
            const file = this.files.get(token);
            if (!file) throw Error('PDF resource has been released');
            if (!Number.isSafeInteger(request) || request < 1 || !Number.isSafeInteger(begin) ||
                !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > file.length)
                throw Error('Invalid PDF byte range');
            const bytes = Buffer.allocUnsafe(end-begin);
            let offset = 0;
            while (offset < bytes.length) {
                const count = fs.readSync(file.fd, bytes, offset, bytes.length-offset, begin+offset);
                if (!count) throw Error('PDF resource was truncated');
                offset += count;
            }
            return { type:'pdfRange', token, request, begin, data:bytes.toString('base64') };
        } catch (error) { return { type:'pdfRange', token, request, error:error.message }; }
    }
    release(token) {
        const file = this.files.get(token);
        if (!file) return;
        this.files.delete(token);
        fs.closeSync(file.fd);
    }
    close() { for (const token of this.files.keys()) this.release(token); }
}
module.exports = { PdfRangeStore };
