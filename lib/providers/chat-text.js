'use strict';

const { NotificationEvent } = require('../notification-event');

// Text rendering shared by the providers. Each platform supplies its own
// escaper and bold delimiters; everything that does not actually differ between
// platforms lives here rather than being written once per provider.

const OPTION_PROMPT = 'Reply with one of these, or your own answer:';
const BUTTON_OR_REPLY_PROMPT = 'Tap a button, or reply with your own answer.';
const SELECTED_PREFIX = '✅ Selected:';
const RESOLVED_TEXT = '↪️ Answered in the pane';
const NUMBER_PREFIX_PATTERN = /^\d+[.)]\s*/;

// Telegram HTML and Slack mrkdwn both need exactly these three characters
// turned into entities. Discord backslash-escapes its own set instead and does
// not call this.
function escapeHtmlEntities(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Keeps the tail: the interesting part of a blocked agent's output is always
// the last few lines, and every platform caps message length.
function tailTrim(text, maxChars) {
  return String(text).slice(-maxChars);
}

// A fenced code block whose content cannot break out of the fence. A zero-width
// space after the first backtick of any fence in the content stops it reading
// as a fence while leaving it visually unchanged.
function fencedBlock(text, maxChars) {
  const fenceSafe = String(text).replace(/```/g, '`​``');
  return `\`\`\`\n${tailTrim(fenceSafe, maxChars)}\n\`\`\``;
}

function statusLine(event, { bold, escapeLabel }) {
  const { icon, label, status } = NotificationEvent.describe(event);
  return `${icon} ${bold(escapeLabel(label))} ${status}`;
}

// A detected option's label without the number it already carries for numbered
// menus ("1. Proceed" -> "Proceed"), so rendering and reply-matching agree on
// what the label is.
function bareOptionLabel(label) {
  return String(label).replace(NUMBER_PREFIX_PATTERN, '').trim();
}

// Free-text options (e.g. Claude Code's "Type something") open a text input
// after selection rather than resolving immediately, so they are marked to
// signal that a follow-up reply is expected.
function freeTextHint(option) {
  return option.expectsText ? ' ✏️' : '';
}

// A button's caption: the option's own label, hint included. The number prefix
// is kept — a button shows what the pane shows.
function buttonLabel(option) {
  return `${option.label}${freeTextHint(option)}`;
}

// One line per detected option, keyed by the value the user must send back.
function optionLines(options, escapeLabel) {
  return options.map(
    (option) => `\`${option.value}\` — ${escapeLabel(bareOptionLabel(option.label))}${freeTextHint(option)}`,
  );
}

// The blocked-agent message body for a platform without tappable buttons: the
// rendered context followed by the values to reply with.
function optionListBody(baseText, options, escapeLabel) {
  return `${baseText}\n${OPTION_PROMPT}\n${optionLines(options, escapeLabel).join('\n')}`;
}

function selectedBody(baseText, selectedLabel, { bold, escapeLabel }) {
  return `${baseText}\n\n${SELECTED_PREFIX} ${bold(escapeLabel(selectedLabel))}`;
}

// The blocked message after the pane was answered without the chat: no
// selection is known here, so only the fact that it is no longer open is shown.
function resolvedBody(baseText) {
  return `${baseText}\n\n${RESOLVED_TEXT}`;
}

module.exports = {
  OPTION_PROMPT,
  BUTTON_OR_REPLY_PROMPT,
  freeTextHint,
  buttonLabel,
  SELECTED_PREFIX,
  RESOLVED_TEXT,
  escapeHtmlEntities,
  tailTrim,
  fencedBlock,
  statusLine,
  bareOptionLabel,
  optionLines,
  optionListBody,
  selectedBody,
  resolvedBody,
};
