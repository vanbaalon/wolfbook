'use strict';
/**
 * Stub: VS Code Language Model API adapter.
 *
 * Future implementation will use `vscode.lm.selectChatModels()` and
 * `model.sendRequest()` to expose Copilot models as a convenience provider.
 * Subscription-assisted access — see spec §13.
 */
const { ProviderAdapter, providerError } = require('./provider');
class LmApiAdapter extends ProviderAdapter {
    get name() { return 'lmapi'; }
    async chatComplete() { throw providerError('lmapi', { message: 'VS Code LM API adapter not implemented yet (MVP-3+).' }); }
}
module.exports = { LmApiAdapter };
