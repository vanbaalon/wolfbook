// PDF.js range transport over the existing webview message channel.
(function (root) {
    class PdfRanges {
        constructor(send, timeoutMs = 5000) { this.send=send; this.timeoutMs=timeoutMs; this.active=new Map(); }
        create(pdfjs, descriptor) {
            const owner=this, { token,length }=descriptor;
            if (typeof token !== 'string' || !Number.isSafeInteger(length) || length<=0 || this.active.has(token))
                throw Error('Invalid PDF resource descriptor');
            class Transport extends pdfjs.PDFDataRangeTransport {
                constructor() {
                    super(length,new Uint8Array(),true);
                    this.pending=new Map(); this.sequence=0; this.receivedBytes=0; this.lastActivity=Date.now();
                    this.failure=new Promise((_,reject) => { this.reject=reject; });
                    this.failure.catch(() => {});
                }
                requestDataRange(begin,end) {
                    if (this.closed) return;
                    const request=++this.sequence; this.lastActivity=Date.now();
                    const pending={begin,end,retries:0};
                    const expired=()=>{
                        if(this.closed || this.pending.get(request)!==pending)return;
                        if(pending.retries++ === 0) {
                            pending.timer=setTimeout(expired,owner.timeoutMs);
                            owner.send({ type:'pdfRangeRequest',token,request,begin,end });
                        } else this.fail(Error('PDF byte request timed out'));
                    };
                    pending.timer=setTimeout(expired,owner.timeoutMs);
                    this.pending.set(request,pending);
                    owner.send({ type:'pdfRangeRequest',token,request,begin,end });
                }
                receive(message) {
                    const pending=this.pending.get(message.request);
                    if (!pending || this.closed) return;
                    clearTimeout(pending.timer); this.pending.delete(message.request); this.lastActivity=Date.now();
                    try {
                        if (message.error) throw Error(message.error);
                        const raw=atob(message.data);
                        if (message.begin!==pending.begin || raw.length!==pending.end-pending.begin)
                            throw Error('PDF byte response mismatch');
                        const bytes=new Uint8Array(raw.length);
                        for (let i=0; i<raw.length; i++) bytes[i]=raw.charCodeAt(i);
                        this.receivedBytes+=bytes.length;
                        this.onDataRange(pending.begin,bytes);
                    } catch (error) { this.fail(error); }
                }
                fail(error) { this.reject(error); this.abort(); }
                abort() {
                    if (this.closed) return;
                    this.closed=true;
                    for (const item of this.pending.values()) clearTimeout(item.timer);
                    this.pending.clear(); owner.active.delete(token);
                    owner.send({ type:'pdfRangeRelease',token });
                }
            }
            const transport=new Transport();
            this.active.set(token,transport);
            return transport;
        }
        receive(message) { this.active.get(message.token)?.receive(message); }
    }
    if (typeof module !== 'undefined' && module.exports) module.exports={ PdfRanges };
    else root.WPaperPdfRanges=PdfRanges;
})(globalThis);
