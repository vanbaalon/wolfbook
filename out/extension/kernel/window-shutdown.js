'use strict';

// VS Code awaits deactivate(), but not subscription dispose() promises. Drain
// every locally owned session before the native addon's environment teardown.
// Remote entries are proxies: closing this window must never stop their owner.
async function shutdownWindow(manager, defaultController, languageClient) {
    const controllers = new Set(defaultController ? [defaultController] : []);
    for (const entry of manager?._entries?.values?.() || []) {
        if (entry.remote) continue;
        if (entry.controller) controllers.add(entry.controller);
        try { entry.operations?.markLost?.('VS Code extension host reloaded or stopped'); } catch (_) {}
    }
    for (const controller of controllers) controller._windowClosing = true;
    const work = [...controllers].map(async controller => {
        // Stop an existing session immediately, including an initializing one.
        // A launch still awaiting its preflight is prevented from creating one.
        await controller.quitKernel('window-closing');
        if (controller._launchPromise) {
            try { await controller._launchPromise; } catch (_) {}
            await controller.quitKernel('window-closing');
        }
    });
    if (languageClient) work.push(Promise.resolve().then(() => languageClient.stop(1500)));
    const results = await Promise.allSettled(work);
    for (const result of results) {
        if (result.status === 'rejected') console.error('[wolfbook] Window shutdown failed:', result.reason);
    }
    return results;
}

module.exports = { shutdownWindow };
