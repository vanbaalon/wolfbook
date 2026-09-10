# WPaper setup on Windows

WPaper's outline, folding, diagnostics, and agent editing tools work without a
TeX installation. The live compiled page requires these commands to be visible
on VS Code's `PATH`:

- `latexmk`
- the selected engine: `pdflatex`, `xelatex`, or `lualatex`

WPaper checks both before compiling. It also recognizes missing TeX package
files such as `.sty`, `.cls`, bibliography-style, and font-support files. A
setup notification and the **WPaper** output channel explain exactly what was
missing.

## Recommended: MiKTeX

1. Install [MiKTeX for Windows](https://miktex.org/howto/install-miktex). A
   private/current-user installation is the simplest option.
2. Open **MiKTeX Console → Packages**, search for `latexmk`, and install it.
3. Open **Settings → General** and set installation of missing packages to
   **Always** (or **Ask me first** if you prefer confirmation).
4. Apply the available MiKTeX updates.
5. Close and reopen every VS Code window so it inherits the updated `PATH`.

MiKTeX can install an individual package from the command line too:

```powershell
miktex packages install <package-id>
```

The package identifier is not always identical to the missing filename, so
MiKTeX Console's package search is the safer route.

## Alternative: TeX Live

Install [TeX Live for Windows](https://tug.org/texlive/quickinstall.html), then
restart VS Code. TeX Live includes the Windows support programs required by its
scripts.

For a missing file, first find which TeX Live package contains it:

```powershell
tlmgr search --global --file "/missing-file\.sty"
tlmgr install <package-name-from-the-search>
```

For missing WPaper prerequisites, install them directly:

```powershell
tlmgr install latexmk
tlmgr install pdftex   # pdflatex
tlmgr install xetex    # xelatex
tlmgr install luatex   # lualatex
```

## If TeX is installed but WPaper cannot find it

Run these commands in VS Code's integrated PowerShell terminal:

```powershell
latexmk --version
pdflatex --version
```

Replace `pdflatex` with the engine selected in
`wolfbook.tex.engine`. If a command works in a standalone terminal but not in
VS Code, fully restart VS Code; windows opened before installation keep the old
`PATH`.

Official references: [MiKTeX package management](https://docs.miktex.org/manual/miktex-packages.html),
[MiKTeX automatic package installation](https://docs.miktex.org/manual/texfeatures.html), and
[TeX Live Manager](https://tug.org/texlive/doc/tlmgr.html).
