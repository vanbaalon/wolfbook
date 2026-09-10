# WPaper and Overleaf

WPaper can synchronize a paper through Git while keeping its local commit
history and WPaper review workflow. Open a `.tex` file and click the green leaf
in the editor title, or run **WPaper: Configure Overleaf Git Sync**.

## If Git sync is already configured

The leaf first checks the current repository for any remote whose URL belongs
to Overleaf. The remote may be named `overleaf`, `origin`, or anything else.
When one exists, WPaper reports **Overleaf Git sync is configured
successfully** and shows the remote name and sanitized project URL. From there
you can merge and push immediately or delete the current sync.

Deleting the sync removes the Git remote and WPaper's saved authentication
token only. It does not delete local files, commits, branches, or history.

## Configure an Overleaf Git remote

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
git pull overleaf master --allow-unrelated-histories --no-rebase
git push overleaf HEAD:master
```

When Git asks, use `git` as the username and your Overleaf authentication token
as the password. Overleaf exposes one branch named `master`, even when the local
branch is named `main`.

Before every WPaper push, Wolfbook fetches the remote branch and performs a
three-way merge. Non-overlapping remote and local edits are kept automatically.
If the same lines changed on both sides, Git keeps all unambiguous changes and
WPaper opens the remaining conflicts for review; it never force-pushes over a
collaborator's work.

Official documentation: [Git integration](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git)
and [authentication tokens](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git/git-integration-authentication-tokens).
