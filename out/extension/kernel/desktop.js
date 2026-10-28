'use strict';
const path = require('path');

function appBundleForKernel(kernelPath) {
    if (!kernelPath || !path.isAbsolute(kernelPath)) return null;
    let directory = path.dirname(kernelPath);
    while (directory !== path.dirname(directory)) {
        if (directory.endsWith('.app')) return directory;
        directory = path.dirname(directory);
    }
    return null;
}

// A service MathematicaServer can register under the desktop bundle ID.
// Requesting a new instance bypasses that instance without stopping kernels,
// changing notebook file associations, or modifying Wolfram's app bundle.
async function openDesktop(kernelPath, {platform = process.platform,
    execFile = require('child_process').execFile} = {}) {
    if (platform !== 'darwin') throw new Error('This command is for macOS.');
    const bundle = appBundleForKernel(kernelPath);
    if (!bundle) throw new Error('The configured Wolfram kernel is not inside a macOS application bundle.');
    await new Promise((resolve, reject) => execFile('/usr/bin/open', ['-n', '-a', bundle],
        {timeout:15000}, error => error ? reject(error) : resolve()));
    return bundle;
}

module.exports = {appBundleForKernel, openDesktop};
