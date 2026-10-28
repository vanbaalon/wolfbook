'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReviewStore } = require('../../tex/reviewStore');
const { ReviewSession } = require('../../tex/reviewSession');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-review-store-test-'));
try {
    const s = new ReviewSession({ file: '/tmp/paper.tex', baseText: 'first\nold\nlast\n' });
    const author = { name: 'Claude Code', sessionId: 'session-a' };
    s.noteBatch({ source: 'paper_applyEdit', author });
    s.recordArrival({ text: 'first\nnew\nlast\n', source: 'paper_applyEdit', author });
    s.update({ currentText: 'first\nnew\nlast\n' });
    assert.equal(s.pendingCount, 1);
    const store = new ReviewStore(directory);
    store.save({ file: s.file, session: s.serialize() });
    const restored = ReviewSession.restore(new ReviewStore(directory).load()[0].session);
    assert.equal(restored.pendingCount, 1, 'reload preserves unreviewed changes');
    restored.update({ currentText: 'first\nnew\nlast\n', map: { generation: 99 } });
    assert.equal(restored.pendingCount, 1, 'recompile/replacement does not accept edits');
    assert.deepEqual(restored.payload().groups[0].author, author);
    const h = restored.hunks[0];
    assert(restored.addFeedback(h.id, 'Why was this normalization changed?'));
    assert(restored.keep(h.id).ok);
    restored.update({ currentText: 'first\nnew\nlast\n' });
    assert.equal(restored.pendingCount, 0);
    store.save({ file: s.file, session: restored.serialize() });
    const final = ReviewSession.restore(new ReviewStore(directory).load()[0].session);
    assert.equal(final.feedback.length, 1);
    assert.match(final.feedbackDraft, /Claude Code/);
    assert.match(final.feedbackDraft, /paper\.tex:2/);
    assert.equal(final.arrivals[0].before, 'first\nold\nlast\n');
    assert.equal(final.arrivals[0].after, 'first\nnew\nlast\n');
    final.noteBatch({ source: 'disk' });
    assert.equal(final.batches.at(-1).author, null, 'unknown disk author is never guessed');
    console.log('durable paper review, provenance, and feedback: OK');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }

require('node:test').test('file-scoped review restore leaves other projects and their histories on disk', () => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'review-lazy-'));
    try {
        const store=new ReviewStore(directory);
        store.save({file:'/paper/main.tex',observed:'accepted',session:null});
        store.save({file:'/other/large.tex',observed:'unrelated',session:null});
        fs.writeFileSync(path.join(directory,store._key('/other/large.tex')+'.json'),'malformed unrelated history');
        const reopened=new ReviewStore(directory);
        assert.deepEqual(reopened.load(['/paper/main.tex']).map(r=>r.file),['/paper/main.tex']);
        assert.equal(reopened.errors.length,0,'an unopened history is not parsed');
        assert.equal(reopened.changed('/paper/main.tex'),null);
        assert.throws(()=>reopened.changed('/other/large.tex'));
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
