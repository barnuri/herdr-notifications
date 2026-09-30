'use strict';

const { bareOptionLabel } = require('./providers/chat-text');

// A permission prompt is the narrow shape auto-approve is allowed to answer:
// one affirmative choice and nothing but refusals beside it. Anything wider —
// Claude Code's AskUserQuestion menus, a pick-a-branch list — must never
// classify here, because auto-approving one of several substantive choices is
// picking an answer, not granting a permission that was already going to be
// granted by hand.
const MIN_PERMISSION_OPTIONS = 2;
const MAX_PERMISSION_OPTIONS = 3;

// Matched against the label with any leading "1. " numbering stripped.
const AFFIRMATIVE_PATTERN = /^(yes|y|run|allow|approve|accept|proceed|continue|ok|okay)\b/i;
const NEGATIVE_PATTERN = /^(no|n|skip|cancel|reject|deny|decline|abort|stop|quit|exit|don't|do not)\b/i;
// "Yes, and don't ask again" / "Run and always allow" persist inside the agent,
// outliving the config rule that triggered them — so they are never selected.
// Deleting a rule has to take effect on the very next prompt.
const PERSISTENT_APPROVAL_PATTERN = /\b(don't ask again|do not ask again|always|every time|for the rest)\b/i;

// Cursor renders the command under review as `$  rm -f /tmp/x in .`, where the
// trailing ` in <dir>` is the working directory rather than part of the
// command. Claude Code renders a bare `$ <command>` line.
const COMMAND_LINE_PATTERN = /^\s*(?:[│|]\s*)?\$\s+(\S.*?)\s*(?:[│|]\s*)?$/;
const CURSOR_CWD_SUFFIX_PATTERN = /\s+in\s+\S+$/;
// A captured line this long is wrapped or garbled viewport output rather than a
// real command, and matching a rule against it would be guesswork — so it is
// treated as "no command found" and fails closed.
const COMMAND_SUBJECT_MAX_CHARS = 500;

function labelText(option) {
  return bareOptionLabel(option.label);
}

function isAffirmative(option) {
  return AFFIRMATIVE_PATTERN.test(labelText(option));
}

function isNegative(option) {
  return NEGATIVE_PATTERN.test(labelText(option));
}

// Returns the option to send for an auto-approval, or null when the menu is not
// a permission prompt. Null is the safe answer for every ambiguous shape.
function affirmativeOption(options) {
  if (!Array.isArray(options)) {
    return null;
  }
  if (options.length < MIN_PERMISSION_OPTIONS || options.length > MAX_PERMISSION_OPTIONS) {
    return null;
  }

  const affirmatives = options.filter(isAffirmative);
  const negatives = options.filter(isNegative);
  // Every option must be classifiable, and the two buckets must not overlap:
  // an unrecognised label means this is a menu of real choices, not a
  // permission prompt.
  if (affirmatives.length + negatives.length !== options.length) {
    return null;
  }
  if (affirmatives.length === 0 || negatives.length === 0) {
    return null;
  }

  const onceOnly = affirmatives.filter((option) => !PERSISTENT_APPROVAL_PATTERN.test(labelText(option)));
  // Several plain affirmatives with nothing to tell them apart is not a shape
  // this understands well enough to answer unattended.
  if (onceOnly.length !== 1) {
    return null;
  }
  return onceOnly[0];
}

// The string auto-approve rules are matched against: the command the agent is
// asking permission to run. Returns null when the prompt names no command —
// a workspace-trust dialog, a bare "Continue?" — so those can never be
// auto-approved by a broad pattern.
function commandSubject(text) {
  if (typeof text !== 'string') {
    return null;
  }
  let subject = null;
  // A pane capture is a viewport: the same command appears in the transcript
  // above and again in the approval dialog below. The dialog is always last, so
  // the final match is the one being asked about.
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(COMMAND_LINE_PATTERN);
    if (match) {
      subject = match[1].replace(CURSOR_CWD_SUFFIX_PATTERN, '').trim();
    }
  }
  if (subject === null || subject === '' || subject.length > COMMAND_SUBJECT_MAX_CHARS) {
    return null;
  }
  return subject;
}

module.exports = { affirmativeOption, commandSubject };
