#!/bin/bash
# Deploy Extended VSNB Editor Extension
# Usage: ./deploy-extension.sh [quick|package]

DEV_DIR="/Users/k0959535/Dropbox/MY/Programming/VSCodeWolframExtension/Extension Development"
INSTALL_DIR="/Users/k0959535/.vscode/extensions"
PKG_FILE="$DEV_DIR/package.json"

# Get current version
VERSION=$(grep '"version"' "$PKG_FILE" | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
PUBLISHER=$(grep '"publisher"' "$PKG_FILE" | head -1 | sed 's/.*"publisher": "\(.*\)".*/\1/')
NAME=$(grep '"name"' "$PKG_FILE" | head -1 | sed 's/.*"name": "\(.*\)".*/\1/')

EXTENSION_ID="$PUBLISHER.$NAME-$VERSION"
TARGET_DIR="$INSTALL_DIR/$EXTENSION_ID"

echo "📦 Extended VSNB Editor Deployment"
echo "Version: $VERSION"
echo "Extension ID: $EXTENSION_ID"
echo ""

MODE=${1:-quick}

if [ "$MODE" == "quick" ]; then
    echo "🚀 Quick deploy (file copy)..."
    
    # Remove ALL previously installed versions of this extension
    for old in "$INSTALL_DIR/$PUBLISHER.$NAME"-*/; do
        [ -d "$old" ] && rm -rf "$old"
    done
    
    # Copy development version
    cp -R "$DEV_DIR" "$TARGET_DIR"

    # ---- Copy WolfbookLaTeX binaries (C++ addon + KaTeX pre-renderer) ----
    BTL_SRC="/Users/k0959535/Dropbox/MY/Programming/VSCodeWolfbookLaTeX"
    BTL_DEST="$TARGET_DIR/wllatex-addon"
    mkdir -p "$BTL_DEST/node_modules"
    cp "$BTL_SRC/build/Release/wolfbook_btl.node" "$BTL_DEST/"
    cp "$BTL_SRC/out/src/katexPrerender.js"       "$BTL_DEST/"
    # katexPrerender.js requires 'katex' — copy the module so it resolves locally
    cp -R "$BTL_SRC/node_modules/katex"           "$BTL_DEST/node_modules/katex"
    echo "   WolfbookLaTeX addon copied to: $BTL_DEST"

    # ---- Patch VS Code extensions.json so it points to the new version ----
    # Without this, VS Code keeps the old version path and fails to activate.
    EXT_JSON="$HOME/.vscode/extensions/extensions.json"
    if [ -f "$EXT_JSON" ]; then
        python3 -c "
import json, sys
ext_id, ver, rel, loc, path = '$PUBLISHER.$NAME', '$VERSION', '$EXTENSION_ID', '$TARGET_DIR', '$EXT_JSON'
f = open(path); data = json.load(f); f.close()
for e in data:
    if isinstance(e, dict) and e.get('identifier', {}).get('id') == ext_id:
        e['version'] = ver
        if 'location' in e: e['location']['path'] = loc
        e['relativeLocation'] = rel
open(path, 'w').write(json.dumps(data, indent=2))
"
        echo "   ✓  extensions.json updated to $EXTENSION_ID"
    fi

    echo "✅ Quick deploy complete!"
    echo "   Extension installed at: $TARGET_DIR"
    echo "   Reload VS Code window to apply changes"
    
elif [ "$MODE" == "package" ]; then
    echo "📦 Building VSIX package..."
    
    cd "$DEV_DIR"
    
    VSIX_DIR="/Users/k0959535/Dropbox/MY/Programming/VSCodeWolframExtension/Extension Production VSIX"
    VSIX_PATH="$VSIX_DIR/$NAME-$VERSION.vsix"
    CODE_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"

    # Build VSIX
    vsce package --allow-missing-repository -o "$VSIX_PATH"
    
    if [ $? -eq 0 ]; then
        echo "✅ VSIX package created: $VSIX_PATH"
        echo ""
        echo "📥 Installing via VS Code CLI..."
        "$CODE_CLI" --install-extension "$VSIX_PATH" --force
        if [ $? -eq 0 ]; then
            echo "✅ Extension installed — reload VS Code window to activate"

            # ---- Copy WolfbookLaTeX binaries (same as quick mode) ----
            BTL_SRC="/Users/k0959535/Dropbox/MY/Programming/VSCodeWolfbookLaTeX"
            BTL_DEST="$TARGET_DIR/wllatex-addon"
            if [ -f "$BTL_SRC/build/Release/wolfbook_btl.node" ]; then
                mkdir -p "$BTL_DEST/node_modules"
                cp "$BTL_SRC/build/Release/wolfbook_btl.node" "$BTL_DEST/"
                cp "$BTL_SRC/out/src/katexPrerender.js"       "$BTL_DEST/"
                cp -R "$BTL_SRC/node_modules/katex"           "$BTL_DEST/node_modules/katex"
                echo "   WolfbookLaTeX addon copied to: $BTL_DEST"
            else
                echo "⚠️  WLLatex addon not found — build it first:"
                echo "     cd ~/Dropbox/MY/Programming/VSCodeWolfbookLaTeX && ./build.sh"
            fi
        else
            echo "⚠️  Auto-install failed. Install manually:"
            echo "  Cmd+Shift+P → 'Extensions: Install from VSIX...' → $VSIX_PATH"
        fi
    else
        echo "❌ VSIX packaging failed!"
        exit 1
    fi
else
    echo "❌ Unknown mode: $MODE"
    echo "Usage: ./deploy-extension.sh [quick|package]"
    exit 1
fi

# Push to remote
echo ""
echo "🔼 Pushing to remote..."
cd "$DEV_DIR"
git push origin main
if [ $? -eq 0 ]; then
    echo "✅ Pushed to origin/main"
else
    echo "⚠️  Git push failed (changes still deployed locally)"
fi
