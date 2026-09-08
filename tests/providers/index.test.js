'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { PROVIDER_CLASSES, createProviders } = require('../../lib/providers');

const FULLY_CONFIGURED = {
  providers: {
    telegram: { enabled: true, botToken: 'tg', chatId: '1' },
    discord: { enabled: true, botToken: 'dc', channelId: 'C1' },
    slack: { enabled: true, botToken: 'xoxb', channelId: 'C2' },
  },
};

test('the registry exposes exactly the three supported providers', () => {
  assert.deepEqual(Object.keys(PROVIDER_CLASSES).sort(), ['discord', 'slack', 'telegram']);
});

test('every provider class advertises its own id', () => {
  for (const [providerId, ProviderClass] of Object.entries(PROVIDER_CLASSES)) {
    assert.equal(ProviderClass.ID, providerId);
  }
});

test('all three providers can be built at once', () => {
  const { providers, unconfigured } = createProviders(FULLY_CONFIGURED);

  assert.deepEqual(
    providers.map((provider) => provider.id).sort(),
    ['discord', 'slack', 'telegram'],
  );
  assert.deepEqual(unconfigured, []);
});

test('a disabled provider is not built', () => {
  const { providers } = createProviders({
    providers: {
      telegram: { enabled: true, botToken: 'tg', chatId: '1' },
      discord: { enabled: false, botToken: 'dc', channelId: 'C1' },
    },
  });

  assert.deepEqual(
    providers.map((provider) => provider.id),
    ['telegram'],
  );
});

test('an enabled but incomplete provider is reported instead of silently dropped', () => {
  const { providers, unconfigured } = createProviders({
    providers: {
      telegram: { enabled: true, botToken: 'tg', chatId: '1' },
      slack: { enabled: true, botToken: 'xoxb', channelId: '' },
    },
  });

  assert.deepEqual(
    providers.map((provider) => provider.id),
    ['telegram'],
  );
  assert.deepEqual(unconfigured, ['slack']);
});

test('a config with no providers block builds nothing', () => {
  assert.deepEqual(createProviders({}), { providers: [], unconfigured: [] });
});

test('an unknown provider id in the config is ignored', () => {
  const { providers, unconfigured } = createProviders({
    providers: { carrier_pigeon: { enabled: true, botToken: 'x', chatId: 'y' } },
  });

  assert.deepEqual(providers, []);
  assert.deepEqual(unconfigured, []);
});

test('an injected http client reaches the built providers', async () => {
  const calls = [];
  const httpClient = {
    async postJson(url, payload, options) {
      calls.push({ url, payload, options });
      return { status: 200, ok: true, body: { ok: true, result: { message_id: 1 }, ts: '1.1' } };
    },
  };
  const { providers } = createProviders(FULLY_CONFIGURED, { httpClient });

  for (const provider of providers) {
    await provider.sendStatus({ type: 'done', paneId: 'p', agent: { agent: 'a' } });
  }

  assert.equal(calls.length, 3);
});

test('providers are built in registry order so notification order is deterministic', () => {
  const { providers } = createProviders(FULLY_CONFIGURED);
  assert.deepEqual(
    providers.map((provider) => provider.id),
    Object.keys(PROVIDER_CLASSES),
  );
});
