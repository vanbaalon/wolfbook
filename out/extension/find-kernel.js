"use strict";
/*
 *  wolfbook
 *
 *  Copyright (c) 2026 Nikolay Gromov. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  Based on vscode-wolfram by Wolfram Research (Apache 2.0).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FindKernel = void 0;
const vscode = require("vscode");
const fs = require('fs');
const path = require('path');
const configCompat = require("./config-compat");
class FindKernel {
    constructor() {
        this.linuxKernelPath = (() => {
            // Dynamically enumerate all installed Wolfram products and versions
            // under /usr/local/Wolfram/.  Mirrors macKernelPath below.  Sorted
            // descending so the newest version is tried first.
            const _paths = [];
            const _productDirs = [
                '/usr/local/Wolfram/WolframEngine',
                '/usr/local/Wolfram/Mathematica',
                '/usr/local/Wolfram/Wolfram',
            ];
            const _verToNum = (v) => {
                const parts = String(v || '').split('.').map(x => parseInt(x, 10));
                const a = Number.isFinite(parts[0]) ? parts[0] : 0;
                const b = Number.isFinite(parts[1]) ? parts[1] : 0;
                return a * 1e6 + b * 1e3;
            };
            for (const base of _productDirs) {
                try {
                    if (!fs.existsSync(base)) continue;
                    const entries = fs.readdirSync(base, { withFileTypes: true })
                        .filter(e => e.isDirectory() && /^\d/.test(e.name))
                        .map(e => e.name)
                        .sort((a, b) => _verToNum(b) - _verToNum(a));
                    for (const ver of entries) {
                        _paths.push(path.join(base, ver, 'Executables', 'WolframKernel'));
                    }
                } catch (_) {}
            }
            return _paths;
        })();
        this.macKernelPath = (() => {
            // Dynamically discover all Wolfram/Mathematica apps in /Applications/.
            // Handles numbered variants ("Wolfram 3.app", "Wolfram 14.app", etc.) and
            // sorts them descending by version number so the newest is tried first.
            const _paths = [];
            try {
                const _apps = fs.readdirSync('/Applications')
                    .filter(e => /^(Wolfram( \d+)?|Wolfram Engine|Mathematica( \d+)?)\.app$/i.test(e))
                    .sort((a, b) => {
                        const na = parseInt(a.match(/^Wolfram (\d+)\.app$/i)?.[1] ?? '-1');
                        const nb = parseInt(b.match(/^Wolfram (\d+)\.app$/i)?.[1] ?? '-1');
                        if (na >= 0 && nb >= 0) return nb - na;  // both numbered → descending
                        if (na >= 0) return -1;                  // a numbered → a first
                        if (nb >= 0) return  1;                  // b numbered → b first
                        // Neither numbered: prefer Wolfram.app > Mathematica > Wolfram Engine
                        const _ord = ['Wolfram.app', 'Mathematica.app', 'Wolfram Engine.app'];
                        return (_ord.indexOf(a) + 1 || 999) - (_ord.indexOf(b) + 1 || 999);
                    });
                for (const app of _apps) _paths.push(`/Applications/${app}/Contents/MacOS/WolframKernel`);
            } catch (_) {}
            if (_paths.length === 0) {
                // Fallback if /Applications cannot be scanned
                _paths.push(
                    "/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel",
                    "/Applications/Wolfram 2.app/Contents/MacOS/WolframKernel",
                    "/Applications/Wolfram.app/Contents/MacOS/WolframKernel",
                    "/Applications/Mathematica.app/Contents/MacOS/WolframKernel",
                    "/Applications/Wolfram Engine.app/Contents/MacOS/WolframKernel"
                );
            }
            return _paths;
        })();
        this.winKernelPath = (() => {
            const _paths = [];
            const _vendorDirs = [
                "C:\\Program Files\\Wolfram Research\\Wolfram",
                "C:\\Program Files\\Wolfram Research\\Wolfram Engine",
                "C:\\Program Files\\Wolfram Research\\Mathematica",
            ];
            const _verToNum = (v) => {
                const parts = String(v || '').split('.').map(x => parseInt(x, 10));
                const a = Number.isFinite(parts[0]) ? parts[0] : 0;
                const b = Number.isFinite(parts[1]) ? parts[1] : 0;
                const c = Number.isFinite(parts[2]) ? parts[2] : 0;
                return a * 1e6 + b * 1e3 + c;
            };
            for (const base of _vendorDirs) {
                try {
                    if (!fs.existsSync(base)) continue;
                    const entries = fs.readdirSync(base, { withFileTypes: true })
                        .filter(e => e.isDirectory())
                        .map(e => e.name)
                        .sort((a, b) => _verToNum(b) - _verToNum(a));
                    for (const ver of entries) {
                        _paths.push(path.join(base, ver, 'WolframKernel.exe'));
                    }
                }
                catch (_) { }
            }
            // Fallback list if directory scan fails entirely.
            if (_paths.length === 0) {
                _paths.push(
                    "C:\\Program Files\\Wolfram Research\\Wolfram\\14.3\\WolframKernel.exe",
                    "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\14.3\\WolframKernel.exe",
                    "C:\\Program Files\\Wolfram Research\\Mathematica\\14.3\\WolframKernel.exe",
                    "C:\\Program Files\\Wolfram Research\\Wolfram\\14.2\\WolframKernel.exe",
                    "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\14.2\\WolframKernel.exe"
                );
            }
            return _paths;
        })();
    }
    resolveKernel() {
        let kernel = configCompat.getSetting("systemKernel", "Automatic");
        // kernel is the default value, so resolve to an actual path
        if (kernel == "Automatic") {
            kernel = this.getOSKernelPath();
        }
        // Resolve symlinks so the kernel binary runs from its real directory.
        // Wolfram Engine's MacOS/WolframKernel is a symlink to the Wolfram Player
        // kernel; if launched via the symlink path the kernel can't find its
        // resources and the WSTP link closes immediately (WSError=WSECLOSED).
        if (kernel && kernel !== 'kernel-not-found' && process.platform !== 'win32') {
            try { kernel = fs.realpathSync(kernel); } catch (_) {}
        }
        return kernel;
    }
    /**
     * Resolves the kernel to use for the LSP server (stdio transport).
     * The Wolfram Engine Player kernel (used for WSTP) does not support stdio
     * mode and exits immediately when run with -run. When the resolved WSTP
     * kernel is the Player, we fall back to the first stdio-capable kernel
     * found in the standard OS search paths (e.g. Wolfram 3.app on macOS).
     */
    resolveLSPKernel() {
        const wstp = this.resolveKernel();
        // If the WSTP kernel is the Wolfram Engine Player, it cannot be used for
        // LSP's stdio transport. Search for a stdio-capable fallback.
        if (wstp && wstp.includes('Wolfram Player.app')) {
            const fallback = this.getOSKernelPath();
            if (fallback && fallback !== 'kernel-not-found') {
                return fallback;
            }
        }
        return wstp;
    }
    getOSKernelPath() {
        let possibleKernelPaths;
        switch (process.platform) {
            case "linux":
                //
                // generally recommend newer versions over older versions
                // and recommend pre-13.0 Wolfram Engine last, because usage messages did not work before 13.0
                //
                possibleKernelPaths = this.linuxKernelPath;
                break;
            case "darwin":
                possibleKernelPaths = this.macKernelPath;
                break;
            case "win32":
                //
                // generally recommend newer versions over older versions
                // and recommend pre-13.0 Wolfram Engine last, because usage messages did not work before 13.0
                //
                possibleKernelPaths = this.winKernelPath;
                break;
            default:
                possibleKernelPaths = [];
                break;
        }
        let res = possibleKernelPaths.find(k => fs.existsSync(k));
        if (res === undefined) {
            res = "kernel-not-found";
        }
        return res;
    }
    /**
     * Discover all installed Wolfram kernels with friendly names and versions.
     * Returns an array of { label, description, path } objects.
     */
    discoverKernels() {
        const found = [];
        let possibleKernelPaths;
        let appDirGlob;
        switch (process.platform) {
            case "darwin":
                possibleKernelPaths = this.macKernelPath;
                appDirGlob = "/Applications";
                break;
            case "linux":
                possibleKernelPaths = this.linuxKernelPath;
                break;
            case "win32":
                possibleKernelPaths = this.winKernelPath;
                break;
            default:
                possibleKernelPaths = [];
                break;
        }
        for (const kp of possibleKernelPaths) {
            if (!fs.existsSync(kp)) continue;
            let label = kp;
            let description = '';
            if (process.platform === 'darwin') {
                // Extract app name from path like /Applications/Wolfram 3.app/Contents/MacOS/WolframKernel
                const m = kp.match(/\/Applications\/(.+?)\.app\//);
                if (m) {
                    label = m[1]; // e.g. "Wolfram 3", "Mathematica", "Wolfram Engine"
                    // Try to read version from Info.plist
                    const appPath = `/Applications/${m[1]}.app`;
                    let ver = this._readMacVersion(appPath);
                    if (ver) {
                        // Trim build number: "14.2.1.11454240" → "14.2.1"
                        const parts = ver.split('.');
                        if (parts.length > 3) ver = parts.slice(0, 3).join('.');
                        description = `v${ver}`;
                    }
                }
            } else if (process.platform === 'win32') {
                // Extract from path like C:\Program Files\Wolfram Research\Wolfram\14.2\WolframKernel.exe
                const m = kp.match(/Wolfram Research\\(.+?)\\([\d.]+)\\/);
                if (m) {
                    label = m[1]; // e.g. "Wolfram", "Mathematica", "Wolfram Engine"
                    description = `v${m[2]}`;
                }
            } else if (process.platform === 'linux') {
                const m = kp.match(/Wolfram\/(.+?)\/([\d.]+)\//);
                if (m) {
                    label = m[1];
                    description = `v${m[2]}`;
                }
            }
            found.push({ label, description, path: kp });
        }
        return found;
    }
    /**
     * Read the version string from a macOS .app bundle's Info.plist.
     * For Wolfram Engine, falls back to the nested Wolfram Player plist.
     */
    _readMacVersion(appPath) {
        const { execSync } = require('child_process');
        try {
            let ver = execSync(
                `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${appPath}/Contents/Info.plist"`,
                { encoding: 'utf8', timeout: 2000 }
            ).trim();
            // Wolfram Engine has placeholders like "__VersionNumber__"
            if (ver.includes('__')) {
                // Try nested Wolfram Player app
                const playerPlist = `${appPath}/Contents/Resources/Wolfram Player.app/Contents/Info.plist`;
                if (fs.existsSync(playerPlist)) {
                    ver = execSync(
                        `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${playerPlist}"`,
                        { encoding: 'utf8', timeout: 2000 }
                    ).trim();
                    if (!ver.includes('__')) return ver;
                }
                return null;
            }
            return ver;
        } catch (_) {
            return null;
        }
    }
}
exports.FindKernel = FindKernel;
;
//# sourceMappingURL=find-kernel.js.map