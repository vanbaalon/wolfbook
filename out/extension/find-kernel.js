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
class FindKernel {
    constructor() {
        this.linuxKernelPath = [
            // ToDo: Add Wolfram app paths
            "/usr/local/Wolfram/Wolfram/14.2/Executables/WolframKernel",
            "/usr/local/Wolfram/WolframEngine/14.2/Executables/WolframKernel",
            "/usr/local/Wolfram/Wolfram/14.1/Executables/WolframKernel",
            "/usr/local/Wolfram/WolframEngine/14.1/Executables/WolframKernel",
            "/usr/local/Wolfram/Mathematica/14.0/Executables/WolframKernel",
            "/usr/local/Wolfram/WolframEngine/14.0/Executables/WolframKernel",
            "/usr/local/Wolfram/Mathematica/13.3/Executables/WolframKernel",
            "/usr/local/Wolfram/WolframEngine/13.3/Executables/WolframKernel",
            "/usr/local/Wolfram/Mathematica/13.2/Executables/WolframKernel",
            "/usr/local/Wolfram/WolframEngine/13.2/Executables/WolframKernel",
            "/usr/local/Wolfram/Mathematica/13.1/Executables/WolframKernel",
            "/usr/local/Wolfram/WolframEngine/13.1/Executables/WolframKernel",
            "/usr/local/Wolfram/Mathematica/13.0/Executables/WolframKernel",
            "/usr/local/Wolfram/WolframEngine/13.0/Executables/WolframKernel",
            "/usr/local/Wolfram/Mathematica/12.3/Executables/WolframKernel",
            "/usr/local/Wolfram/WolframEngine/12.3/Executables/WolframKernel",
            "/usr/local/Wolfram/Mathematica/12.2/Executables/WolframKernel",
            "/usr/local/Wolfram/WolframEngine/12.2/Executables/WolframKernel",
            "/usr/local/Wolfram/Mathematica/12.1/Executables/WolframKernel",
            "/usr/local/Wolfram/WolframEngine/12.1/Executables/WolframKernel"
        ];
        this.macKernelPath = [
            // Wolfram app (numbered versions, e.g. "Wolfram 3.app" = v14.3)
            "/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel",
            "/Applications/Wolfram 2.app/Contents/MacOS/WolframKernel",
            "/Applications/Wolfram.app/Contents/MacOS/WolframKernel",
            // Standard Mathematica app names
            "/Applications/Mathematica.app/Contents/MacOS/WolframKernel",
            // Wolfram Engine — symlink, resolved at runtime in resolveKernel()
            "/Applications/Wolfram Engine.app/Contents/MacOS/WolframKernel"
        ];
        this.winKernelPath = [
            "C:\\Program Files\\Wolfram Research\\Wolfram\\14.2\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\14.2\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Wolfram\\14.1\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\14.1\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Mathematica\\14.0\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\14.0\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Mathematica\\13.3\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\13.3\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Mathematica\\13.2\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\13.2\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Mathematica\\13.1\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\13.1\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Mathematica\\13.0\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\13.0\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Mathematica\\12.3\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\12.3\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Mathematica\\12.2\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\12.2\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Mathematica\\12.1\\WolframKernel.exe",
            "C:\\Program Files\\Wolfram Research\\Wolfram Engine\\12.1\\WolframKernel.exe"
        ];
    }
    resolveKernel() {
        const config = vscode.workspace.getConfiguration("wolfram", null);
        let kernel = config.get("systemKernel", "Automatic");
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