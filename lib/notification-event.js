'use strict';

// Provider-neutral view of a herdr agent state change. Providers render this
// into their own markup (Telegram HTML, Discord/Slack markdown) rather than
// receiving a pre-formatted string, so escaping and code-fence syntax stay a
// per-platform concern.
class NotificationEvent {
  static MESSAGES = {
    idle: 'is idle (finished working)',
    blocked: 'is blocked (waiting for input)',
    done: 'is done',
  };

  static ICONS = {
    blocked: '🔴',
    idle: '🟡',
    done: '🟢',
  };

  static DEFAULT_ICON = '⚪';
  static DEFAULT_STATUS_PREFIX = 'changed to';

  static agentLabel(event) {
    const agent = event.agent || {};
    return agent.terminal_title_stripped || agent.agent || String(event.paneId);
  }

  static describe(event) {
    return {
      icon: NotificationEvent.ICONS[event.type] || NotificationEvent.DEFAULT_ICON,
      label: NotificationEvent.agentLabel(event),
      status: NotificationEvent.MESSAGES[event.type] || `${NotificationEvent.DEFAULT_STATUS_PREFIX} ${event.type}`,
    };
  }
}

module.exports = { NotificationEvent };
