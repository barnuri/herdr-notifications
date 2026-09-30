'use strict';

const config = require('./config');
const herdr = require('./herdr');
const providerRegistry = require('./providers');

const { AutoApproveRules } = require('./auto-approve');
const { bareOptionLabel } = require('./providers/chat-text');
const { INBOUND_ACTION } = require('./providers/inbound');
const { RelayStateStore } = require('./relay-state');
const { affirmativeOption, commandSubject } = require('./permission-prompt');

class Relay {
  static LOG_PREFIX = 'herdr-notifications';
  static CALLBACK_DATA_PREFIX = 'r';
  static CALLBACK_DATA_PART_COUNT = 3;
  // A pane needs a moment to redraw after an answer is typed into it; reading
  // too early sees the question that was just answered.
  static FOLLOW_UP_SETTLE_MS = 1200;
  static AUTO_APPROVED_PREFIX = '⚡ Auto-approved';

  constructor({
    loadConfig = config.loadConfig,
    createProviders = providerRegistry.createProviders,
    readAgentOutput = herdr.readAgentOutput,
    answerBlockedAgent = herdr.answerBlockedAgent,
    detectOptions = require('./option-detector').detectOptions,
    compileAutoApproveRules = AutoApproveRules.compile,
    stateStore = new RelayStateStore(),
    log = (line) => process.stderr.write(`${line}\n`),
    settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this._loadConfig = loadConfig;
    this._createProviders = createProviders;
    this._readAgentOutput = readAgentOutput;
    this._answerBlockedAgent = answerBlockedAgent;
    this._detectOptions = detectOptions;
    this._compileAutoApproveRules = compileAutoApproveRules;
    this._stateStore = stateStore;
    this._log = log;
    this._settle = settle;
  }

  // Called by lib/notifier.js in place of its plain sendStatus fan-out when a
  // `blocked` event fires and relay.enabled is true. Returns the per-provider
  // failures so the notifier reports them the same way it reports a plain
  // status-send failure.
  async notifyBlocked(event, currentConfig, providers) {
    const context = await this._readAgentOutput(event.paneId, {
      lines: currentConfig.relay.contextLines,
    });
    const options = this._detectOptions(context);

    const autoApproval = this._resolveAutoApproval(context, options, currentConfig);
    if (autoApproval && (await this._autoApprove(event, autoApproval, currentConfig, providers))) {
      return [];
    }

    const token = options.length > 0 ? RelayStateStore.generateToken() : undefined;
    return this._announce({ event, context, options, token, providers });
  }

  // Every condition here is a reason *not* to answer unattended, so each one
  // returns null: auto-approve only ever fires on a permission prompt that
  // names a command matching a rule the user wrote.
  _resolveAutoApproval(context, options, currentConfig) {
    const { autoApprove } = currentConfig;
    if (!autoApprove || !autoApprove.enabled) {
      return null;
    }
    const affirmative = affirmativeOption(options);
    if (!affirmative) {
      return null;
    }
    const subject = commandSubject(context);
    if (subject === null) {
      return null;
    }
    const rules = this._compileAutoApproveRules(autoApprove, (message) =>
      this._log(`${Relay.LOG_PREFIX}: ${message}`),
    );
    const rule = rules.match(subject);
    return rule ? { affirmative, subject, rule } : null;
  }

  // Resolves false when the pane could not be answered, so the caller falls
  // back to announcing the question normally — an unanswerable pane must never
  // be left silently blocked just because a rule matched it.
  async _autoApprove(event, approval, currentConfig, providers) {
    try {
      await this._answerBlockedAgent(event.paneId, approval.affirmative.value);
    } catch (error) {
      this._log(`${Relay.LOG_PREFIX}: auto-approve could not answer ${event.paneId}: ${error.message}`);
      return false;
    }

    if (currentConfig.autoApprove.notify) {
      await this._announceAutoApproval(approval, providers);
    }
    return true;
  }

  // Plain text on every provider, exactly like _say: there is nothing to tap,
  // so the message needs no per-platform blocks or escaping beyond what
  // sendText already does.
  static autoApprovalText({ affirmative, subject, rule }) {
    return [
      `${Relay.AUTO_APPROVED_PREFIX}: ${subject}`,
      `Matched ${rule.kind} "${rule.pattern}" — sent "${bareOptionLabel(affirmative.label)}"`,
    ].join('\n');
  }

  // Best-effort on every provider: the command has already run in the pane, so
  // a provider being down changes nothing the user can act on — it must not
  // read as a failed notification.
  async _announceAutoApproval(approval, providers) {
    const text = Relay.autoApprovalText(approval);
    await Promise.all(providers.map((provider) => this._say(provider, text)));
  }

  // Sends one blocked question to every provider and records what it takes to
  // answer it. Shared by the initial notification and by the follow-up that
  // announces the next question of a multi-question prompt.
  async _announce({ event, context, options, token, providers }) {
    const deliveries = [];
    const failures = [];
    await Promise.all(
      providers.map(async (provider) => {
        try {
          const { messageId, baseText } = await provider.sendBlocked({ event, context, options, token });
          deliveries.push({ providerId: provider.id, messageId, baseText });
        } catch (error) {
          failures.push({ providerId: provider.id, message: error.message });
        }
      }),
    );

    // Nothing was delivered, so nothing can be answered — leave the pane
    // untracked rather than recording a question no one can see.
    if (deliveries.length > 0) {
      this._stateStore.trackBlocked(event.paneId, { deliveries, token, options, event });
    }
    return failures;
  }

  // Called from bin/watch.js on its own cadence. Every enabled provider is
  // polled: an answer may arrive on any of them.
  async pollUpdates() {
    const currentConfig = this._loadConfig();
    if (!currentConfig.relay.enabled) {
      return;
    }

    const { providers } = this._createProviders(currentConfig);
    for (const provider of providers) {
      try {
        await this._pollProvider(provider);
      } catch (error) {
        this._log(`${Relay.LOG_PREFIX}: ${provider.id} relay poll failed: ${error.message}`);
      }
    }
  }

  async _pollProvider(provider) {
    const { events, cursor } = await provider.fetchInbound(this._stateStore.getCursor(provider.id, provider.targetId));

    for (const event of events) {
      // A single event's processing must never block the cursor from advancing
      // past it — otherwise the provider redelivers it forever (and, for a
      // Telegram callback, re-answering an already-answered query throws on
      // every retry, permanently stalling the relay).
      try {
        await this._processInbound(provider, event);
      } catch (error) {
        this._log(`${Relay.LOG_PREFIX}: ${provider.id} relay failed to process ${event.id}: ${error.message}`);
      }
    }

    if (cursor !== this._stateStore.getCursor(provider.id, provider.targetId)) {
      this._stateStore.setCursor(provider.id, cursor, provider.targetId);
    }
  }

  async _processInbound(provider, event) {
    if (event.kind === INBOUND_ACTION) {
      await this._handleAction(provider, event);
      return;
    }
    await this._handleText(provider, event);
  }

  async _handleAction(provider, event) {
    const parts = String(event.data).split(':');
    if (parts.length !== Relay.CALLBACK_DATA_PART_COUNT || parts[0] !== Relay.CALLBACK_DATA_PREFIX) {
      return;
    }
    const [, token, indexRaw] = parts;
    const index = Number(indexRaw);

    const entry = this._stateStore.resolveByToken(token);
    if (!entry || !Number.isInteger(index) || !entry.options[index]) {
      // Flagged as a failure so a provider without a toast (Slack) can make it
      // visible instead of the tap vanishing silently.
      await provider.acknowledgeAction(event.actionId, 'This question has expired.', { failed: true });
      return;
    }

    await provider.acknowledgeAction(event.actionId, 'Sent.');

    const selected = entry.options[index];
    const paneId = entry.paneId;
    const answeredOptions = entry.options;
    if (!(await this._sendAnswer(provider, paneId, selected.value))) {
      return;
    }

    // The acknowledgement toast is transient and easy to miss; edit the
    // original message on every provider that got it so the selection stays
    // visible and stale buttons can't be tapped again.
    await this._markAnswered(paneId, selected.label);
    await this._finishAnswer(provider, paneId, selected, answeredOptions);
  }

  async _handleText(provider, event) {
    const paneId = this._resolvePane(provider, event);
    if (!paneId) {
      await this._say(provider, 'Please reply directly to the specific blocked-agent notification you want to answer.');
      return;
    }

    // The pane already had an expectsText option selected: this reply IS the
    // text to type — relay it verbatim, never re-matched against a menu.
    if (this._stateStore.isAwaitingText(paneId)) {
      if (await this._sendAnswer(provider, paneId, event.text)) {
        this._stateStore.expirePane(paneId);
      }
      return;
    }

    const answeredOptions = this._stateStore.resolveOptionsByPane(paneId);
    const matched = this._matchOption(paneId, event.text);
    if (!(await this._sendAnswer(provider, paneId, matched ? matched.value : event.text))) {
      return;
    }
    if (matched) {
      await this._markAnswered(paneId, matched.label);
    }
    // Typing an expectsText option's number/label is the same as tapping its
    // button — _finishAnswer asks for the follow-up text in that case.
    await this._finishAnswer(provider, paneId, matched, answeredOptions);
  }

  // A reply-to is the only unambiguous route once several panes are blocked, so
  // the single-blocked-pane shortcut is the sole exception.
  _resolvePane(provider, event) {
    if (event.replyToMessageId) {
      return this._stateStore.resolveByMessageId(provider.id, event.replyToMessageId);
    }
    const blockedPanes = this._stateStore.getBlockedPanes();
    return blockedPanes.length === 1 ? blockedPanes[0] : null;
  }

  // Resolves true when the answer reached the pane. A failure is reported back
  // into the chat that sent it and the pane is dropped, because the question it
  // was answering is no longer answerable.
  async _sendAnswer(provider, paneId, text) {
    try {
      await this._answerBlockedAgent(paneId, text);
      return true;
    } catch (error) {
      await this._say(provider, `Failed to relay your answer: ${error.message}`);
      this._stateStore.expirePane(paneId);
      return false;
    }
  }

  // Shared tail for both answer paths (button tap and free-text reply): an
  // expectsText option just opened a text input in the pane, so keep it
  // tracked and ask for the follow-up; anything else completes the exchange.
  async _finishAnswer(provider, paneId, option, answeredOptions) {
    if (option && option.expectsText) {
      await this._promptForText(provider, paneId, option.label);
      return;
    }
    await this._announceNextQuestion(paneId, answeredOptions);
  }

  // One blocked prompt can hold several questions — Claude Code's
  // AskUserQuestion renders them as tabs and answering one advances the pane to
  // the next rather than unblocking it. `agent_status` stays `blocked`
  // throughout, and StateWatcher only emits on a transition *into* blocked, so
  // without this the remaining questions are never announced and the user is
  // left with a pane waiting on something they cannot see.
  async _announceNextQuestion(paneId, answeredOptions) {
    const currentConfig = this._loadConfig();
    const question = this._stateStore.getQuestion(paneId);
    const answeredKey = RelayStateStore.optionsKey(answeredOptions);

    let context;
    try {
      await this._settle(Relay.FOLLOW_UP_SETTLE_MS);
      context = await this._readAgentOutput(paneId, { lines: currentConfig.relay.contextLines });
    } catch (error) {
      this._log(`${Relay.LOG_PREFIX}: could not re-read ${paneId} after answering: ${error.message}`);
      this._stateStore.expirePane(paneId);
      return;
    }

    const options = this._detectOptions(context);
    // No menu left, or the same menu still on screen (the pane had not
    // redrawn): the exchange is over as far as this relay can tell.
    if (options.length === 0 || RelayStateStore.optionsKey(options) === answeredKey) {
      this._stateStore.expirePane(paneId);
      return;
    }

    const { providers } = this._createProviders(currentConfig);
    if (providers.length === 0) {
      this._stateStore.expirePane(paneId);
      return;
    }

    // trackBlocked replaces the pane's previous state, so the answered
    // question's routing is dropped as part of announcing the next one.
    const event = (question && question.event) || { type: 'blocked', paneId };
    const failures = await this._announce({
      event,
      context,
      options,
      token: RelayStateStore.generateToken(),
      providers,
    });
    for (const failure of failures) {
      this._log(`${Relay.LOG_PREFIX}: ${failure.providerId} could not announce the next question: ${failure.message}`);
    }
  }

  // An expectsText option was just selected in the pane (the digit opened a
  // text input there). Keep the pane tracked so the user's next reply is
  // relayed as the literal text, and register the prompt's message id so a
  // reply-to on it routes correctly even when several panes are blocked. Only
  // the provider the selection came from is prompted — that is where the user
  // is looking.
  async _promptForText(provider, paneId, selectedLabel) {
    this._stateStore.setAwaitingText(paneId);
    try {
      const { messageId } = await provider.sendTextPrompt(
        `✏️ ${selectedLabel} selected — now reply with the text to send.`,
      );
      this._stateStore.registerMessage(provider.id, messageId, paneId);
    } catch (error) {
      this._log(`${Relay.LOG_PREFIX}: ${provider.id} relay failed to ask for follow-up text: ${error.message}`);
    }
  }

  // Best-effort on every provider that received the question: the answer was
  // already delivered, so a failure here (e.g. the message is too old to edit)
  // must not read as a relay failure to the user.
  async _markAnswered(paneId, selectedLabel) {
    const deliveries = this._stateStore.getDeliveries(paneId);
    if (deliveries.length === 0) {
      return;
    }
    const { providers } = this._createProviders(this._loadConfig());
    const byId = new Map(providers.map((provider) => [provider.id, provider]));

    await Promise.all(
      deliveries.map(async ({ providerId, messageId, baseText }) => {
        const provider = byId.get(providerId);
        if (!provider || baseText === undefined) {
          return;
        }
        try {
          await provider.markAnswered({ messageId, baseText, selectedLabel });
        } catch (error) {
          this._log(`${Relay.LOG_PREFIX}: ${providerId} relay failed to update the answered message: ${error.message}`);
        }
      }),
    );
  }

  // A free-text reply is always accepted (this is the universal fallback —
  // real text-input prompts need exactly this). But if the pane currently has
  // a detected menu, typing the option's own value/label should drive that menu
  // correctly (e.g. the digit key), not get typed as raw text into a
  // keypress-driven widget that will ignore it.
  _matchOption(paneId, rawText) {
    const options = this._stateStore.resolveOptionsByPane(paneId);
    if (!Array.isArray(options) || options.length === 0) {
      return null;
    }
    const normalized = String(rawText).trim().toLowerCase();
    return (
      options.find((option) => {
        const bareLabel = bareOptionLabel(option.label).toLowerCase();
        return normalized === String(option.value).toLowerCase() || normalized === bareLabel;
      }) || null
    );
  }

  async _say(provider, text) {
    try {
      await provider.sendText(text);
    } catch (error) {
      this._log(`${Relay.LOG_PREFIX}: ${provider.id} relay failed to reply in chat: ${error.message}`);
    }
  }
}

module.exports = { Relay };
