# WPaper and Overleaf

WPaper keeps a paper in step with an Overleaf project in one of two ways:

- **Git, every few minutes** (the default). WPaper commits your saved
  changes, merges your collaborators' and pushes, whenever you pause. This is
  Overleaf's supported route. It needs Overleaf's Git integration (a paid
  Overleaf plan) and a Git authentication token.
- **Real time, as in the Overleaf editor** (off by default). You link the
  paper's folder to an Overleaf project. What you type appears in Overleaf as
  you type it, and your collaborators' edits appear in your editor. Overleaf
  does not support this; read [its risks](#the-risks-of-real-time-editing)
  before you turn it on.

Everything is in one menu: click the green leaf in a `.tex` editor's title
bar, or the leaf button in WPaper's toolbar, or run **WPaper: Overleaf…**. The
menu shows how this paper is synced now, lets you choose the way (or **Off**),
and offers what that way needs. The setting behind it is
`wolfbook.tex.overleafSync` (`git`, `live` or `off`).

## Open a project from the Wolfbook sidebar

Open the **Overleaf** tab in Wolfbook's left panel. Two separate cards make the
connection choices clear:

- **Browse projects · Live sync:** connect your account using the existing
  browser-session setup, then choose a project from the list (or **Browse
  projects…**). The search box filters your projects. Pick a `.tex` file and a
  parent folder for the local copy. WPaper opens that file against the project's
  main document, with the project's sources, styles, bibliographies and assets
  on disk. The existing live connector keeps edits in step with Overleaf.
- **Open with Git:** paste the project/Git URL, enter an Overleaf Git token and
  choose a parent folder. Wolfbook clones the project, lets you pick a `.tex`
  file and opens WPaper. It uses the existing Git sync controls. This does not
  require connecting the browser-session account.

The first method reuses the real-time connector's one-time opt-in and session
cookie instructions described below. It remains unsupported by Overleaf. Git
uses Overleaf's supported integration and needs Git access enabled for the
project; see its [current documentation](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration).

Both methods add the project as a workspace folder so AI agents edit the same
local files WPaper uses. Sync settings are stored for that project, so a live
project and a Git project can use different modes. **Sync settings** changes the
mode for the current paper.

**Local projects** reopens an existing local copy and offers its `.tex` files;
opening the same live project again reuses that copy. Initial imports always
use a new folder and leave existing files intact. Opening a project does not
push changes. Files explicitly selected from the sidebar join live sync even
when the main paper does not include them yet. The live connector still offers a choice if a collaborator edited
files during the initial import. Disconnecting the account keeps local files.
An expired session is shown as a connection error; use **Replace session**.

In a window without a workspace, VS Code restarts the extension host when its
first workspace folder is added. Wolfbook saves the opening request and resumes
WPaper and live sync after activation. Existing workspaces add the project in
place.

## Git, every few minutes

1. Connect the paper's repository to the Overleaf project: in the menu,
   choose **Connect this paper to an Overleaf project…** (the steps are
   described [below](#configure-an-overleaf-git-remote)).
2. Add the token: **Add the Overleaf Git token…** In Overleaf, create it
   under **Account settings → Git integration**.

From then on, after you have paused typing for 20 seconds, WPaper:

1. commits what changed, with a message naming the sections and equations
   you changed;
2. merges your collaborators' changes from Overleaf;
3. pushes.

It does this every 5 minutes; change the interval with
`wolfbook.tex.overleafSyncMinutes`, or in the menu. The status bar shows the
last sync, and clicking it syncs now. **Sync with Overleaf now** in the menu
does the same.

If a collaborator changed the same lines as you, auto-sync stops and tells
you. Nothing is lost: your work is committed locally, and your files keep
your text, with no conflict markers. Choose **Merge and resolve now** to
resolve the overlap. Auto-sync resumes after that, or when you sync by hand.

A push can lose or move Overleaf's tracked changes and comments on the lines
it changes, so this way suits projects that don't rely on those.

## Real time: link this paper to an Overleaf project

You link the folder that holds the paper's main `.tex` file to one Overleaf
project, and to a folder in it: the project's top, or the folder in which
the project keeps the paper. Files then correspond by path below both. If
your `paper/` is linked to the project's `paper/` folder, `paper/fig/a.png` on
your disk is `paper/fig/a.png` on Overleaf, and a file the paper starts using
here is made in `paper/` there. No other window opens and no copy of the
project is made. The editors you already use are the ones kept in step. You
don't need any other extension.

Only the files the paper actually uses are synced; see [The files the paper
uses](#the-files-the-paper-uses). Markdown files (`.md`), and files or
folders whose name starts with a dot (`.latexmkrc`, `.git/…`), are never
synced.

### 1. Copy your Overleaf session cookie

WPaper signs in with the session your browser already has. In Chrome, Edge or
Brave, signed in to Overleaf:

1. Open https://www.overleaf.com.
2. Open the developer tools: **⌥⌘I** on a Mac, **Ctrl+Shift+I** elsewhere.
3. Open the **Application** tab. If you don't see it, look under the **»**
   menu.
4. In the sidebar, open **Storage → Cookies → https://www.overleaf.com**.
5. Click the row named **`overleaf_session2`** and copy its **Value**, shown
   below the table. It starts with `s%3A`.

In Safari, first turn on **Settings → Advanced → Show features for web
developers**. Then use **Develop → Show Web Inspector → Storage → Cookies**.
In Firefox, use the developer tools' **Storage → Cookies**.

The cookie is marked HttpOnly, so typing `document.cookie` in the console
doesn't show it: use the Cookies panel. Paste the value alone; WPaper adds
the `overleaf_session2=` part itself. The cookie is kept in VS Code's Secret
Storage and sent only to Overleaf. It expires after about five days, or when
you sign out of Overleaf in that browser. WPaper then asks for it again. To
replace it at any time, use **Set the Overleaf session cookie…** in the
menu.

### 2. Link the paper

1. Open the paper's main `.tex` file.
2. In the Overleaf menu, choose **Real time, as in the Overleaf editor**.
   Read the risks and accept them (asked once).
3. Choose **Link this paper to an Overleaf project…** and paste the cookie
   when asked.
4. Pick the project from your list of Overleaf projects. If the list can't
   be read, choose **Paste a project address…** and paste the address from
   the browser (`https://www.overleaf.com/project/…`).
5. Choose which folder of the Overleaf project is your paper's folder.
   WPaper lists the project's top and each of its folders. For each, it
   says how many of the files in it are already in your folder at the same
   paths, and the best match comes first. Say your `main.tex` is in
   `paper/`: if the project has `main.tex` at its top, choose **the
   project's top**; if it keeps the paper as `paper/main.tex`, choose
   `paper/`. **A new folder in the project…** makes one, for a paper the
   project doesn't have yet.
6. Confirm. WPaper shows your folder, the Overleaf folder and how their files
   correspond (for example `paper/main.tex ↔ paper/main.tex`), how many of
   the files there are already here, and where new files will be made.
   Nothing is changed before you choose **Link and connect**.

WPaper then connects, and a message confirms the link: the folder, the
project, and how many files are in step. If some files differ between your
folder and the project, it lists them and asks first:

- **Use Overleaf's version**: your text of those files is replaced. In an
  open editor this is an ordinary edit, so ⌘Z undoes it.
- **Send mine to Overleaf**: the project's text of those files is replaced,
  for every collaborator.

If you close the question, nothing changes and WPaper doesn't connect. Files
that only the project has are written into your folder.

### 3. Work as usual

- What you type goes to Overleaf as you type it: each change is sent as
  what was inserted or deleted, and where, not as the whole file. That is how
  Overleaf's own editor sends it.
- Your collaborators' edits appear in your editor as ordinary edits: your
  caret stays where it is, and ⌘Z works. Edits to a file you haven't opened
  are written to it on disk.
- Files are saved a moment after they change, as Overleaf keeps nothing
  unsaved.
- You appear in the project as you do from the browser: among the people
  online, with your cursor where your caret is in the file you are editing.
- The leaf is green while the paper is in step with Overleaf, in the
  editor's title bar and on WPaper's toolbar. It is grey when it isn't. Hover
  WPaper's leaf, or the **Overleaf live** item in the status bar, to see the
  project and the file on Overleaf that your editor is connected to, for
  example *Connected to Overleaf in real time: “Fishnets” — sections/intro.tex*.
  In Git mode the leaf is green after a successful sync and names the time
  and the file.

The link is remembered. The next time you open the paper, WPaper reconnects
by itself if the cookie is still valid. From the menu you can
**Disconnect**, **Connect** again, **Link to another project…** or **Unlink
this paper**.

Limits: a picture removed on Overleaf is not deleted from your folder. A text
file changed on disk by another program while it isn't open in the editor
(a `git pull`, say) isn't sent; open it, or connect again. After a dropped
connection, choose **Connect** again; differences are then offered for you
to resolve, as the first time. Characters outside the basic Unicode
range (𝔸, emoji) are stored by Overleaf as �, so write them as LaTeX commands
(`\mathbb{A}`).

### The files the paper uses

Only the files the paper explicitly uses are synced, starting from its main
file:

- the files it `\input`s or `\include`s, and what those use in turn;
- the pictures it `\includegraphics` (looked for as LaTeX does: along
  `\graphicspath`, and with `.pdf`, `.png`, `.jpg` and `.eps` added when no
  extension is written);
- the `.bib` files named by `\bibliography` or `\addbibresource`;
- local `.sty` and `.cls` files and data files the paper reads.

A file counts whether it is on your disk or only on Overleaf. Anything
else in the project, or in your folder, is left alone: other `.tex` files
the paper doesn't `\input`, stray pictures, the compiled `main.pdf`, notes.

When you connect, the files the paper uses that are only on Overleaf are
fetched. Those that differ go into the same "which version" question as
the text. What the paper uses that isn't on Overleaf yet is uploaded into
the linked folder there; a new `.tex` or `.bib` becomes an Overleaf document
and is then edited in real time like the others. While you are connected:

- a picture a collaborator uploads or replaces is fetched, if the paper
  uses it;
- one you re-export is uploaded;
- a file you start to use, by adding `\includegraphics{…}` or `\input{…}`,
  is brought into step a moment later.

### The risks of real-time editing

- Overleaf doesn't support this. WPaper connects to overleaf.com the way
  Overleaf's web editor does, with your session cookie, instead of through
  Git.
- Overleaf's terms forbid access by any means other than its publicly
  supported interfaces. Using real-time editing may breach them, and
  Overleaf could restrict or close your account.
- It can stop working at any time, without notice, when Overleaf changes
  its editor.
- Your session cookie gives full access to your Overleaf account. Keep it
  to yourself.

If any of this is a concern, use Git sync: it is Overleaf's supported route.

## Configuring the Git remote in detail

### If Git sync is already configured

The leaf first checks the current repository for any remote whose URL belongs
to Overleaf. The remote may be named `overleaf`, `origin`, or anything else.
When one exists, WPaper reports **Overleaf Git sync is configured
successfully** and shows the remote name and sanitized project URL. From there
you can merge and push immediately or delete the current sync.

Deleting the sync removes the Git remote and WPaper's saved authentication
token only. It does not delete local files, commits, branches, or history.

### Configure an Overleaf Git remote

This requires Overleaf's Git integration. In the Overleaf project, open
**Integrations → Git** and copy its Git URL or clone command. WPaper accepts the
URL, clone command, pull command, or the browser's Overleaf project URL.

Choose **Paste Overleaf Git details** to add a remote named `overleaf`. Enter
the authentication token generated in Overleaf Account Settings. WPaper stores
the token in VS Code Secret Storage; it removes embedded credentials before
writing the remote URL to `.git/config`.

The equivalent terminal setup is:

```bash
git remote add overleaf https://git@git.overleaf.com/YOUR_PROJECT_ID
git pull overleaf main --allow-unrelated-histories --no-rebase
git push overleaf HEAD:main
```

When Git asks, use `git` as the username and your Overleaf authentication token
as the password. New Overleaf Git clones use `main`; older repositories may still use
`master`. Wolfbook follows the cloned/configured branch or discovers the
remote HEAD when configuring sync.

Before every WPaper push, Wolfbook fetches the remote branch and performs a
three-way merge. Non-overlapping remote and local edits are kept automatically.
If the same lines changed on both sides, Git keeps all unambiguous changes and
WPaper opens the remaining conflicts for review; it never force-pushes over a
collaborator's work.

Official documentation: [Git integration](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration)
and [authentication tokens](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens).
