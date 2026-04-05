#!/bin/bash
# Release Extended VSNB Editor Extension
# Usage: ./release.sh

set -e

BTL_DIR="/Users/k0959535/Dropbox/MY/Programming/VSCodeWolfbookLaTeX"
EXT_DIR="/Users/k0959535/Dropbox/MY/Programming/VSCodeWolframExtension/Extension Development"
VSIX_OUT_DIR="/Users/k0959535/Dropbox/MY/Programming/VSCodeWolframExtension/Extension Production VSIX"
PKG_FILE="$EXT_DIR/package.json"

# 1. Get current versions
BTL_VERSION=$(grep '"version"' "$BTL_DIR/package.json" | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
EXT_VERSION=$(grep '"version"' "$PKG_FILE" | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
NAME=$(grep '"name"' "$PKG_FILE" | head -1 | sed 's/.*"name": "\(.*\)".*/\1/')

echo "🚀 Starting Release Process"
echo "BTL Version: $BTL_VERSION"
echo "Extension Version: $EXT_VERSION"
echo ""

# 2. Rebuild BTL (native addon)
echo "🔨 Rebuilding BTL (native addon)..."
cd "$BTL_DIR"
npm run build
if [ ! -f "$BTL_DIR/build/Release/wolfbook_btl.node" ]; then
    echo "❌ BTL build failed! Binary not found."
    exit 1
fi
echo "   ✅ BTL build OK"

# 3. Synchronize BTL binaries to Extension
echo "🔄 Synchronizing BTL binaries to Extension..."
BTL_DEST="$EXT_DIR/wllatex-addon"
mkdir -p "$BTL_DEST/node_modules"
cp "$BTL_DIR/build/Release/wolfbook_btl.node" "$BTL_DEST/"
# Note: katexPrerender uses compiled ts from /out in BTL
# We should probably copy the .js and its dependencies
KPR_JS="$BTL_DIR/out/src/katexPrerender.js"
if [ -f "$KPR_JS" ]; then
    cp "$KPR_JS" "$BTL_DEST/"
    cp -R "$BTL_DIR/node_modules/katex" "$BTL_DEST/node_modules/"
    echo "   ✅ katexPrerender.js and dependencies copied"
else
    echo "⚠️  katexPrerender.js not found at $KPR_JS"
fi

# 4. Git Push BTL
echo "🔼 Pushing BTL changes to GitHub..."
cd "$BTL_DIR"
git add -A
if ! git diff-index --quiet HEAD --; then
    git commit -m "v$BTL_VERSION — release build"
    git push origin main
    echo "   ✅ BTL pushed"
else
    echo "   (BTL already up-to-date)"
fi

# 5. Pack Extension VSIX
echo "📦 Packaging Extension VSIX..."
cd "$EXT_DIR"
VSIX_FILE="$NAME-$EXT_VERSION.vsix"
VSIX_PATH="$VSIX_OUT_DIR/$VSIX_FILE"

# Make sure vsce is available
if ! command -v vsce &> /dev/null; then
  echo "❌ 'vsce' command not found. Please install it: npm install -g @vscode/vsce"
  exit 1
fi

vsce package --allow-missing-repository -o "$VSIX_PATH"
echo "   ✅ VSIX created: $VSIX_PATH"

# 6. Git Push Extension
echo "🔼 Pushing Extension changes to GitHub..."
cd "$EXT_DIR"
git add -A
if ! git diff-index --quiet HEAD --; then
    git commit -m "v$EXT_VERSION — release build"
    git push origin main
    echo "   ✅ Extension pushed"
else
    echo "   (Extension already up-to-date)"
fi

# 7. Create GitHub Release
echo "🎁 Creating GitHub Release v$EXT_VERSION..."
if command -v gh &> /dev/null; then
    # Create tag and release with VSIX attached
    # --generate-notes automatically creates changelog from commits
    gh release create "v$EXT_VERSION" "$VSIX_PATH" \
        --title "v$EXT_VERSION" \
        --notes "Release v$EXT_VERSION — Includes BTL v$BTL_VERSION (native arm64)" \
        --repo "vanbaalon/wolfbook"
    echo "   ✅ GitHub Release created: https://github.com/vanbaalon/wolfbook/releases/tag/v$EXT_VERSION"
else
    echo "⚠️  'gh' CLI not found. Skipping automatic release creation."
    echo "Manual step: Upload $VSIX_PATH to GitHub Releases"
fi

echo ""
echo "🎉 Release successful!"
