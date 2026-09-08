'use strict';

const { DiscordProvider } = require('./discord');
const { SlackProvider } = require('./slack');
const { TelegramProvider } = require('./telegram');

// Registry of every notification target. Adding a provider means: a class in
// this folder, a line here, and a config block in lib/config.js.
const PROVIDER_CLASSES = Object.freeze({
  [TelegramProvider.ID]: TelegramProvider,
  [DiscordProvider.ID]: DiscordProvider,
  [SlackProvider.ID]: SlackProvider,
});

// Instantiates every provider that is both switched on and has its credentials
// filled in. A provider that is enabled but not configured is reported through
// `unconfigured` rather than silently dropped, so the caller can tell the user
// which one needs attention instead of going quiet.
function createProviders(currentConfig, { httpClient } = {}) {
  const providers = [];
  const unconfigured = [];

  for (const [providerId, ProviderClass] of Object.entries(PROVIDER_CLASSES)) {
    const providerConfig = (currentConfig.providers || {})[providerId];
    if (!providerConfig || providerConfig.enabled !== true) {
      continue;
    }
    const provider = new ProviderClass({ providerConfig, ...(httpClient ? { httpClient } : {}) });
    if (provider.isConfigured()) {
      providers.push(provider);
      continue;
    }
    unconfigured.push(providerId);
  }

  return { providers, unconfigured };
}

module.exports = { PROVIDER_CLASSES, createProviders };
