"use strict";

// Only evaluation paths call this. Inspection, notebook opening and binding
// never start processes. launchKernel coalesces concurrent requests per slot.
async function ensureKernelReady(controller) {
    if (!controller) return false;
    if (controller._windowClosing) throw new Error('The VS Code window is closing.');
    if (controller.kernelStatusString === 'resolved') return true;
    if (typeof controller.launchKernel !== 'function') return false;
    await controller.launchKernel();
    if (controller.kernelStatusString !== 'resolved') {
        throw new Error('Wolfram kernel could not start. Check Wolfbook Kernel Diagnostics and retry evaluation.');
    }
    return true;
}

module.exports = { ensureKernelReady };
