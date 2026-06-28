'use strict';
/**
 * Oberon — Stage 2 contribution review panel (WebviewPanel).
 *
 * The review surface for the contribution candidate inbox. Lists pending
 * candidates and, for one candidate, shows the review dialog: rendered SKILL.md,
 * evidence, lineage, a rights-declaration checkbox, and the actions
 * Approve & submit (private draft) · Decline (keep local) · Discard · Open clean.wb.
 *
 * SAFETY: approval creates a PRIVATE draft only. Making a draft public is a
 * separate, deliberate action outside this dialog. No candidate is ever submitted
 * without an explicit Approve here (and the rights checkbox ticked).
 */

const vscode  = require('vscode');
const inbox   = require('../memory/contributionInbox');
const submit  = require('../memory/contributionSubmit');

const VIEW_TYPE = 'wolfbook.oberon.contributionReview';

class ContributionReviewPanel {
    /** @param {vscode.ExtensionContext} context */
    constructor(context) {
        this._context = context;
        /** @type {vscode.WebviewPanel|null} */
        this._panel = null;
    }

    /** Open (or reveal) the review panel. */
    async open() {
        if (this._panel) { this._panel.reveal(vscode.ViewColumn.Active); await this._refresh(); return; }
        this._panel = vscode.window.createWebviewPanel(
            VIEW_TYPE, 'SkilXiv — Review Contributions',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this._panel.onDidDispose(() => { this._panel = null; });
        this._panel.webview.onDidReceiveMessage((m) => this._onMessage(m).catch(err => {
            this._post({ type: 'error', message: (err && err.message) || String(err) });
        }));
        this._panel.webview.html = this._html();
        await this._refresh();
    }

    _post(msg) { if (this._panel) this._panel.webview.postMessage(msg); }

    async _refresh() {
        const candidates = await inbox.listCandidates();
        const signedIn   = await submit.isSignedIn(this._context.secrets);
        this._post({ type: 'state', candidates, signedIn });
    }

    async _onMessage(m) {
        switch (m && m.command) {
            case 'ready':
                await this._refresh();
                return;

            case 'signIn': {
                // Token-based sign-in: open the SkilXiv account page where the user
                // creates an API token, then paste it into a password prompt. The
                // token is stored in secret storage and never logged.
                const cfg = require('../config/settings').recall();
                await vscode.env.openExternal(vscode.Uri.parse(`${cfg.skilxivBaseUrl}/#/account`));
                const token = await vscode.window.showInputBox({
                    title: 'SkilXiv sign-in',
                    prompt: 'Paste your SkilXiv API token (from your account page). Stored securely; never logged.',
                    password: true, ignoreFocusOut: true,
                });
                if (token) {
                    await submit.setToken(this._context.secrets, token.trim());
                    vscode.window.showInformationMessage('Signed in to SkilXiv.');
                }
                await this._refresh();
                return;
            }

            case 'signOut':
                await submit.clearToken(this._context.secrets);
                await this._refresh();
                return;

            case 'openCandidate': {
                const loaded = await submit.loadCandidate(m.id);
                if (loaded) this._post({ type: 'candidate', id: m.id, manifest: loaded.manifest, skillMd: loaded.skillMd });
                return;
            }

            case 'openNotebook': {
                const loaded = await submit.loadCandidate(m.id);
                const p = loaded && loaded.manifest && loaded.manifest.cleanNbPath;
                if (p) {
                    try {
                        const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(p));
                        await vscode.window.showNotebookDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
                    } catch (e) { this._post({ type: 'error', message: `Could not open clean.wb: ${e.message}` }); }
                }
                return;
            }

            case 'saveEdits':
                await submit.saveSkillMd(m.id, m.skillMd);
                this._post({ type: 'saved', id: m.id });
                return;

            case 'approve': {
                if (!m.rightsConfirmed) { this._post({ type: 'error', message: 'Tick the rights declaration before approving.' }); return; }
                if (m.skillMd) await submit.saveSkillMd(m.id, m.skillMd);
                const token = await submit.getToken(this._context.secrets);
                if (!token) { this._post({ type: 'needSignIn' }); return; }

                // Near-duplicate pre-check → offer acknowledge-usage instead.
                const loaded = await submit.loadCandidate(m.id);
                const title  = (loaded && loaded.manifest.title) || '';
                const task   = (loaded && loaded.manifest.task) || '';
                if (!m.forceNew) {
                    const { match } = await submit.nearDuplicateCheck(token, { title, task });
                    if (match) {
                        this._post({ type: 'nearDuplicate', id: m.id, match: {
                            ref: match.ref || `${match.namespace || ''}/${match.name || ''}`,
                            summary: match.summary || match.trigger || '',
                        } });
                        return;
                    }
                }

                this._post({ type: 'submitting', id: m.id });
                const res = await submit.submitCandidate({
                    id: m.id, secrets: this._context.secrets,
                    agentModel: loaded && loaded.manifest.generatedWith,
                });
                if (res.ok) {
                    vscode.window.showInformationMessage(`Submitted private draft to SkilXiv${res.draftId ? ` (${res.draftId})` : ''}.`);
                    await this._refresh();
                    this._post({ type: 'submitted', id: m.id, url: res.url });
                } else if (res.error === 'not_signed_in') {
                    this._post({ type: 'needSignIn' });
                } else {
                    this._post({ type: 'error', message: `Submit failed: ${res.error}. The candidate is kept locally — you can retry.` });
                }
                return;
            }

            case 'acknowledgeUsage': {
                // The user accepted the near-duplicate: keep the candidate local and
                // mark it declined (a usage acknowledgement, not a new draft).
                await submit.declineCandidate(m.id);
                vscode.window.showInformationMessage('Recorded as usage of the existing skill; no new draft created.');
                await this._refresh();
                return;
            }

            case 'decline':
                await submit.declineCandidate(m.id);
                await this._refresh();
                return;

            case 'discard':
                await submit.discardCandidate(m.id);
                await this._refresh();
                return;
        }
    }

    _html() {
        const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
        return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 16px; }
  h1 { font-size: 1.1rem; } h2 { font-size: 0.95rem; margin: 12px 0 6px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  button { font: inherit; cursor:pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border:1px solid var(--vscode-button-border,transparent); border-radius:4px; padding:4px 10px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity:.45; cursor:default; }
  .candidate { border:1px solid var(--vscode-widget-border,rgba(128,128,128,.25)); border-radius:6px; padding:8px 10px; margin:6px 0; }
  .badge { font-size:11px; padding:1px 6px; border-radius:8px; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); }
  pre { background: var(--vscode-textCodeBlock-background); padding:10px; border-radius:6px; overflow:auto; max-height:340px; white-space:pre-wrap; }
  textarea { width:100%; min-height:240px; font-family: var(--vscode-editor-font-family,monospace); font-size:12px;
             background:var(--vscode-input-background); color:var(--vscode-input-foreground);
             border:1px solid var(--vscode-input-border,rgba(128,128,128,.35)); border-radius:4px; padding:6px; }
  .evidence span { margin-right:14px; }
  .ok { color: var(--vscode-testing-iconPassed,#3a3); } .no { color: var(--vscode-descriptionForeground); }
  .rights { margin:10px 0; }
  .hidden { display:none; }
  .dup { border:1px solid var(--vscode-inputValidation-warningBorder,#cc8); padding:8px; border-radius:6px; margin:8px 0; }
</style></head><body>
  <div class="row" style="justify-content:space-between">
    <h1>Review contributions</h1>
    <div id="auth" class="row"></div>
  </div>
  <p class="muted">Approving creates a <b>private draft</b> on SkilXiv under your account. Going public is a separate step.</p>
  <div id="list"></div>
  <div id="detail" class="hidden"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let STATE = { candidates: [], signedIn: false };
let CURRENT = null;

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderAuth(){
  const a = document.getElementById('auth');
  a.innerHTML = STATE.signedIn
    ? '<span class="badge">signed in</span> <button class="secondary" id="signOut">Sign out</button>'
    : '<button id="signIn">Sign in to SkilXiv</button>';
  const si = document.getElementById('signIn'); if (si) si.onclick = ()=>vscode.postMessage({command:'signIn'});
  const so = document.getElementById('signOut'); if (so) so.onclick = ()=>vscode.postMessage({command:'signOut'});
}

function renderList(){
  const l = document.getElementById('list');
  if (!STATE.candidates.length){ l.innerHTML = '<p class="muted">No contribution candidates yet. They appear here after a delivered run with reusable results.</p>'; return; }
  l.innerHTML = STATE.candidates.map(c => \`
    <div class="candidate">
      <div class="row" style="justify-content:space-between">
        <b>\${esc(c.title)}</b><span class="badge">\${esc(c.status)}</span>
      </div>
      <div class="muted">\${esc(c.task||'').slice(0,160)}</div>
      <div class="row" style="margin-top:6px">
        <button data-id="\${esc(c.id)}" class="review">Review</button>
        \${c.draftUrl? '<span class="muted">draft submitted</span>':''}
      </div>
    </div>\`).join('');
  l.querySelectorAll('.review').forEach(b=> b.onclick = ()=>vscode.postMessage({command:'openCandidate', id:b.dataset.id}));
}

function renderDetail(id, manifest, skillMd){
  CURRENT = id;
  const d = document.getElementById('detail');
  d.classList.remove('hidden');
  const ev = manifest.evidence||{};
  d.innerHTML = \`
    <h2>\${esc(manifest.title)} <button class="secondary" id="back">← back</button></h2>
    <div class="evidence muted">
      <span class="\${ev.executed_fresh?'ok':'no'}">\${ev.executed_fresh?'✓':'○'} executed_fresh</span>
      <span class="\${ev.skill_self_tests_passed?'ok':'no'}">\${ev.skill_self_tests_passed?'✓':'○'} self_tests</span>
      \${manifest.derivedFrom? '<span>derived_from: '+esc(manifest.derivedFrom)+'</span>':''}
      <span>generated_with: \${esc(manifest.generatedWith||'?')}</span>
    </div>
    <div class="row" style="margin:6px 0">
      <button class="secondary" id="openNb">Open clean.wb</button>
      <button class="secondary" id="save">Save edits</button>
    </div>
    <h2>SKILL.md (editable)</h2>
    <textarea id="md">\${esc(skillMd)}</textarea>
    <div id="dup"></div>
    <label class="rights"><input type="checkbox" id="rights"> I have the right to publish this content.</label>
    <div class="row">
      <button id="approve" disabled>Approve &amp; submit (private draft)</button>
      <button class="secondary" id="decline">Decline (keep local)</button>
      <button class="secondary" id="discard">Discard</button>
    </div>
    <p class="muted" id="status"></p>\`;
  document.getElementById('back').onclick = ()=>{ d.classList.add('hidden'); CURRENT=null; };
  document.getElementById('rights').onchange = (e)=>{ document.getElementById('approve').disabled = !e.target.checked; };
  document.getElementById('openNb').onclick = ()=>vscode.postMessage({command:'openNotebook', id});
  document.getElementById('save').onclick = ()=>vscode.postMessage({command:'saveEdits', id, skillMd: document.getElementById('md').value});
  document.getElementById('decline').onclick = ()=>vscode.postMessage({command:'decline', id});
  document.getElementById('discard').onclick = ()=>{ if(confirm('Delete this candidate?')) vscode.postMessage({command:'discard', id}); };
  document.getElementById('approve').onclick = ()=>vscode.postMessage({
    command:'approve', id, rightsConfirmed: document.getElementById('rights').checked, skillMd: document.getElementById('md').value
  });
}

window.addEventListener('message', e=>{
  const m = e.data;
  if (m.type==='state'){ STATE = m; renderAuth(); renderList(); }
  else if (m.type==='candidate'){ renderDetail(m.id, m.manifest, m.skillMd); }
  else if (m.type==='saved'){ const s=document.getElementById('status'); if(s) s.textContent='Edits saved.'; }
  else if (m.type==='submitting'){ const s=document.getElementById('status'); if(s) s.textContent='Submitting…'; }
  else if (m.type==='submitted'){ const s=document.getElementById('status'); if(s) s.textContent='Submitted as a private draft. Open your SkilXiv account to publish.'; }
  else if (m.type==='needSignIn'){ const s=document.getElementById('status'); if(s) s.textContent='Sign in first (top-right), then approve again.'; }
  else if (m.type==='nearDuplicate'){
    const dup=document.getElementById('dup');
    if(dup) dup.innerHTML = '<div class="dup">A similar skill already exists: <b>'+esc(m.match.ref)+'</b><br><span class="muted">'+esc(m.match.summary)+'</span><div class="row" style="margin-top:6px"><button id="ackUse" class="secondary">Acknowledge usage instead</button><button id="forceNew">Submit as new anyway</button></div></div>';
    const ack=document.getElementById('ackUse'); if(ack) ack.onclick=()=>vscode.postMessage({command:'acknowledgeUsage', id:m.id});
    const fn=document.getElementById('forceNew'); if(fn) fn.onclick=()=>vscode.postMessage({command:'approve', id:m.id, rightsConfirmed:true, forceNew:true, skillMd:document.getElementById('md').value});
  }
  else if (m.type==='error'){ const s=document.getElementById('status'); if(s) s.textContent=m.message; }
});
vscode.postMessage({command:'ready'});
</script></body></html>`;
    }
}

module.exports = { ContributionReviewPanel, VIEW_TYPE };
