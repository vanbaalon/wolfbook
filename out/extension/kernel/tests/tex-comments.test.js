'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CommentStore, sidecarFor, markdownFor } = require('../../tex/commentStore');
const { sha256 } = require('../../tex/texModel');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-comments-'));
let seq = 0;
const store = new CommentStore({
    now: () => Date.UTC(2026, 8, 9, 12, 0, seq),
    uuid: () => `id-${++seq}`,
});

function object(file, text, line, extra = {}) {
    return {
        kind: extra.kind || 'paragraph',
        label: extra.label || null,
        stableKey: extra.stableKey || `root/${extra.kind || 'paragraph'}/${sha256(text).slice(0, 8)}/0`,
        sourceHash: sha256(text),
        text,
        sectionPath: extra.sectionPath || ['Introduction'],
        sourceRange: { file, startLine: line, endLine: line + (extra.lines || 0) },
    };
}

try {
    const file = path.join(tmp, 'paper.tex');
    fs.writeFileSync(file, '\\begin{document}\nA paper.\n\\end{document}\n');
    assert.strictEqual(sidecarFor(file), path.join(tmp, 'paper.timeline.comments'));

    const first = object(file,
        'This paragraph explains the boundary conditions and their physical interpretation.', 12);
    const added = store.add(file, first, 'Please justify the second boundary condition.',
        { author: { name: 'Nikolay Reader' } }, [first]);
    assert.ok(added.cell.id.startsWith('cell_'));
    assert.ok(fs.existsSync(sidecarFor(file)), 'a shareable sidecar is created');

    // More than one remark on one paragraph shares the durable cell identity.
    const second = store.add(file, first, 'Could this sentence cite the earlier result?', {}, [first]);
    assert.strictEqual(second.cell.id, added.cell.id);

    // Inserting text above moves the reported lines without changing identity.
    const moved = object(file, first.text, 31);
    let listed = store.list([file], () => [moved]);
    assert.strictEqual(listed.items.length, 2);
    assert.strictEqual(listed.items[0].cellId, added.cell.id);
    assert.strictEqual(listed.items[0].line, 31);
    assert.strictEqual(listed.items[0].detached, false);
    assert.deepStrictEqual(listed.items[0].author, { name: 'Nikolay Reader' },
        'a human author travels with a shared comment');
    assert.strictEqual(listed.items[0].sourcePreview, first.text,
        'the viewer receives TeX source intact instead of the command-stripped excerpt');
    assert.deepStrictEqual(listed.items[0].sectionPath, ['Introduction']);

    // A normal edit inside the paragraph reconciles by similarity and keeps id.
    const edited = object(file,
        'This paragraph carefully explains the boundary conditions and their physical interpretation.', 33);
    listed = store.list([file], () => [edited]);
    assert.strictEqual(listed.items[0].cellId, added.cell.id);
    assert.strictEqual(listed.items[0].line, 33);

    const md = markdownFor(listed.items, file);
    assert.ok(md.includes('paper.tex:33'));
    assert.ok(md.includes('Section: Introduction'));
    assert.ok(!md.includes(added.cell.id), 'copied comments use human locations, not storage ids');
    assert.ok(md.includes('Please justify'));
    const quotedAt = md.indexOf('### Quoted passage\n\n> ');
    const commentAt = md.indexOf('\n\n### Comment\n\n');
    assert.ok(quotedAt >= 0,
        'the source excerpt has an explicit beginning');
    assert.ok(commentAt > quotedAt && md.indexOf('Please justify', commentAt) > commentAt,
        'the comment is unmistakably separated from the quoted passage');

    // A rewrite below the conservative threshold never steals the comment.
    const unrelated = object(file,
        'Numerical convergence is summarized in the table and compared across discretizations.', 33);
    listed = store.list([file], () => [unrelated]);
    assert.strictEqual(listed.items[0].detached, true);
    assert.strictEqual(listed.items[0].line, 33, 'last known line remains useful');

    assert.strictEqual(store.update(file, second.id, 'Updated wording.'), true);
    assert.strictEqual(store.delete(file, second.id), true);
    assert.ok(fs.existsSync(sidecarFor(file)), 'one remaining comment keeps the sidecar');
    assert.strictEqual(store.delete(file, added.id), true);
    assert.ok(!fs.existsSync(sidecarFor(file)), 'an empty sidecar is removed');

    // Revision provenance survives the JSON round trip.
    store.add(file, moved, 'Why did this change?', {
        source: 'revision', revision: { originId: 'review:h1:1', changeId: 'h1' },
    }, [moved]);
    listed = store.list([file], () => [moved]);
    assert.strictEqual(listed.items[0].source, 'revision');
    assert.strictEqual(listed.items[0].revision.originId, 'review:h1:1');

    // Comments written before title/abstract became first-class cells migrate
    // from their old generic identity instead of disappearing from the page.
    const frontFile = path.join(tmp, 'front.tex');
    fs.writeFileSync(frontFile, '\\abstract{A concise summary.}\n');
    const oldAbstract = object(frontFile, '\\abstract{A concise summary.}', 1, { kind: 'paragraph' });
    const legacy = store.add(frontFile, oldAbstract, 'Clarify this claim.', {}, [oldAbstract]);
    const promotedAbstract = object(frontFile, oldAbstract.text, 1, { kind: 'abstract' });
    const promotedList = store.list([frontFile], () => [promotedAbstract]);
    assert.strictEqual(promotedList.items[0].cellId, legacy.cell.id);
    assert.strictEqual(promotedList.items[0].kind, 'abstract');
    assert.strictEqual(promotedList.items[0].detached, false);

    const titleFile = path.join(tmp, 'title.tex');
    const titleSource = '\\begin{titlepage}\nA title.\n\\end{titlepage}';
    fs.writeFileSync(titleFile, titleSource);
    const oldTitle = object(titleFile, titleSource, 1, { kind: 'environment', lines: 2 });
    const titleComment = store.add(titleFile, oldTitle, 'Check the title.', {}, [oldTitle]);
    const promotedTitle = object(titleFile, titleSource, 1, { kind: 'titlepage', lines: 2 });
    const titleList = store.list([titleFile], () => [promotedTitle]);
    assert.strictEqual(titleList.items[0].cellId, titleComment.cell.id);
    assert.strictEqual(titleList.items[0].kind, 'titlepage');
    assert.strictEqual(titleList.items[0].detached, false);

    // Clear-all preflights every sidecar: one merge-conflicted/malformed file
    // cannot leave an otherwise valid multi-file paper half-cleared.
    const bad = path.join(tmp, 'chapter.tex');
    fs.writeFileSync(sidecarFor(bad), '{ not json');
    assert.throws(() => store.clear([file, bad]));
    assert.ok(fs.existsSync(sidecarFor(file)), 'the valid sidecar was not removed first');

    // The shipped UI uses contextual bubbles and a resizable focused card.
    // At ordinary zoom they use the margin; fitted pages move them inside.
    const clientRoot = path.resolve(__dirname, '..', '..', '..', 'client');
    const shell = fs.readFileSync(path.join(clientRoot, 'tex-viewer.shell.html'), 'utf8');
    const client = fs.readFileSync(path.join(clientRoot, 'tex-viewer.js'), 'utf8');
    const host = fs.readFileSync(path.resolve(__dirname, '..', '..', 'tex', 'texViewer.js'), 'utf8');
    assert.match(shell, /id="commentgrip"/);
    assert.match(shell, /--comment-width/);
    assert.match(shell, /\.comment-marker/);
    assert.match(shell, /ti-comment-plus/);
    assert.match(shell, /ti-comment-on/);
    assert.match(shell, /#commentsbutton\[aria-pressed="true"\][\s\S]*box-shadow/,
        'the toolbar control has an unmistakable visible selected state');
    assert.match(shell, /id="commentstool"[\s\S]*id="commentsmenu"[\s\S]*aria-haspopup="menu"/,
        'the active comments control has a compact dropdown affordance');
    assert.match(shell, /id="commentsdropdown"[^>]*role="menu"/,
        'the toolbar can list every comment for direct navigation');
    assert.match(client, /function renderCommentsDropdown[\s\S]*comment-menu-item[\s\S]*openCommentFromMenu/,
        'the dropdown names and opens individual comments');
    assert.match(client, /comment-menu-actions[\s\S]*addAction\('copy', 'Copy all', 'copy'\)[\s\S]*addAction\('clear', 'Delete all', 'trash', true\)/,
        'the dropdown offers compact copy-all and delete-all actions');
    assert.match(client, /comment-menu-meta[\s\S]*commentAuthorName\(item\)[\s\S]*commentAge\(addedAt\)/,
        'each dropdown entry names its author and relative age');
    assert.match(client, /comment-menu-delete[\s\S]*requestCommentDelete\(item\)/,
        'each dropdown entry can delete that individual comment');
    assert.match(client, /action === 'copy'\) commentPost\('copy', \{ drafts: commentDrafts\(\) \}\);[\s\S]*commentPost\('clear'\)/,
        'the dropdown bulk actions reuse the existing comment action protocol');
    assert.match(shell, /id="pincontrol"[\s\S]*stays visible instead of fading/,
        'Pin explains its effect before the reader uses it');
    assert.match(shell, /body\.comment-thread-open #commentpanel/);
    assert.match(shell, /<symbol id="ti-refresh"/,
        'toolbar icons are one vector family rather than platform emoji');
    assert.match(client, /startWidth \+ startX - ev\.clientX/);
    assert.match(shell, /body\.fitted\.comments-open #pages \{ padding-right:0; \}/);
    assert.match(client, /function positionCommentMarkerX[\s\S]*visibleRight[\s\S]*canUseMargin/,
        'comment bubbles use the margin only while that page edge is visible');
    assert.match(client, /positionCommentMarkersX\(\);[\s\S]*placeCommentPopover/,
        'scrolling repositions both collapsed and open comment bubbles');
    assert.match(client, /const avail = main\.clientWidth - pad;/,
        'Fit remains edge-to-edge instead of shrinking for an outside rail');
    assert.match(shell, /id="commentheading"[\s\S]*id="commentprev"[\s\S]*id="commentnext"/,
        'the comment card offers context and document-order navigation');
    assert.match(shell, /class="cp-nav"[^>]*aria-label="Move between comments"/,
        'previous and next are presented as one clear comment-navigation control');
    assert.doesNotMatch(client, /commentPost\('reveal'/,
        'the comment card no longer spends its primary action on opening the source editor');
    assert.match(client, /function revealActiveComment[\s\S]*paintCommentMarkers\(\)[\s\S]*main\.scrollTo/,
        'opening or switching comments scrolls to and highlights its passage');
    assert.match(client, /pendingCommentDelete[\s\S]*commentLastDirection[\s\S]*fallbackCellId/,
        'deleting a comment continues through the comment worklist');
    assert.match(client, /placeCommentPopover\(commentPopoverAnchor, false\)/,
        'the open comment bubble follows its page anchor while scrolling');
    assert.match(client, /textItems\(n\)/,
        'the empty add bubble follows the rendered text row under the pointer');
    assert.match(client, /function requestCommentTarget[\s\S]*commentTarget:\s*true/,
        'the + bubble sends its source coordinates directly instead of waiting on word resolution');
    assert.match(shell, /\.comment-marker\.add \{ opacity:\.82;/,
        'the + stays visible while the pointer crosses from paper to rail');
    assert.match(client, /commentRow:\s*rowRect/,
        'the + carries its rendered text box instead of using the out-of-page rail coordinate');
    assert.match(client, /commentsOpen\(\) && \(ev\.metaKey \|\| ev\.ctrlKey\)[\s\S]*commentAnchorAt/,
        'Cmd/Ctrl-click on text opens a comment while comments are visible');
    assert.match(host, /_resolveCommentPoint[\s\S]*const probes =/,
        'comment lookup retries points within its verified text box');
    assert.match(host, /if \(m\.commentTarget\) \{[\s\S]*this\._postCommentTarget\(doc, hit\)/,
        'the extension resolves a comment before entering the caret-selection pipeline');
    assert.match(host, /_commentRects\(st, item\)[\s\S]*\['titlepage', 'abstract'\][\s\S]{0,700}\\\\maketitle/,
        'front-matter comments retain a visible maketitle fallback anchor');
    assert.match(client, /titlepage:\s*'Title page'/,
        'front-matter cells receive a human name in the comment card');
    assert.match(client, /activeCommentCellId/,
        'comments sharing a stable cell are presented as one contextual thread');
    assert.doesNotMatch(client, /comment-marker unplaced/,
        'an unplaced comment is never misrepresented at the top of an arbitrary page');
    assert.match(client, /item\.detached \|\| item\.unplaced[\s\S]*location changed/,
        'unplaced comments remain discoverable and honestly labelled in the dropdown');
    assert.match(client, /import\('\.\/katex\.mjs'\)/,
        'comment source quotations are rendered by the bundled offline KaTeX');
    assert.doesNotMatch(client, /anchor\.textContent\s*=\s*item\.cellId/,
        'the stable machine id does not leak into the human-facing comment card');
    assert.match(client, /const page = await doc\.getPage\(n\);[\s\S]*page\.getAnnotations/,
        'PDF links read annotations from their page proxy');
    assert.match(client, /function previewChipForPdfLink[\s\S]*inkMatching\(c\.find, page\)/,
        'hovering a printed PDF reference resolves the model target at the same ink');
    assert.match(client, /mouseenter[\s\S]*showPdfLinkPreview[\s\S]*showChipPreview\(chip, anchor\)/,
        'an in-text reference shows the same rendered miniature as a label badge');
    assert.match(client, /const previewWidth =[\s\S]*card\.style\.width =[\s\S]*visibleRight - card\.offsetWidth/,
        'a reference at the end of a line shifts its miniature inside the visible paper area');
    assert.match(client, /aria-label', 'Go to it in the paper'/,
        'reference navigation remains accessible without covering the preview with a native tooltip');
    assert.match(client, /const openSeq = \+\+state\.openSeq;[\s\S]*const pdfjs = await loadPdfjs[\s\S]*openSeq !== state\.openSeq/,
        'an older asynchronous PDF open cannot finish after and replace a newer render');
    assert.match(client, /case 'reviewFocus':[\s\S]*msg\.generation[\s\S]*state\.generation[\s\S]*!reviewPlacementCurrent\(\)/,
        'review navigation rejects coordinates belonging to another PDF generation');
    assert.match(client, /if \(state\.fitMode\) setTimeout\(\(\) => fitWidth\(\), 30\)/,
        'showing or hiding annotations recomputes a fitted view');

    console.log('WPaper shared comments: OK');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
