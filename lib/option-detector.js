'use strict';

const MAX_DETECTED_OPTIONS = 8;
// Tolerates a leading cursor/border glyph (e.g. Claude Code's own `❯` on the
// currently-highlighted option) before the digit — without this, the
// highlighted line never matches and a 2-option menu can't reach the
// 2-line contiguous-run threshold below, so the whole menu goes undetected.
const NUMBERED_LINE_PATTERN = /^\s*[❯›>│┃]?\s*(\d+)[.)]\s+(.+)$/;
// Claude Code's AskUserQuestion renders the option list and a preview panel
// side by side, so a single terminal row holds both: the option's own text, a
// gutter, then the panel's box-drawing art. `(.+)$` above captures the whole
// row, so the gutter is where the label actually ends. Two signals mark it —
// a run of spaces before a box-drawing/pipe character, or any run of three
// spaces (no real option label contains one).
const COLUMN_GUTTER_PATTERN = /\s{2,}[|\u2500-\u257F]|\s{3,}/;
const YES_NO_PATTERN = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]/i;
// Claude Code's AskUserQuestion always appends these free-text built-ins to a
// menu; selecting them opens a text input, so tapping the digit alone leaves
// the pane waiting — the relay must follow up with the user's actual text.
const FREE_TEXT_LABEL_PATTERN = /^(type something|chat about this)\b/i;

// Cursor's TUI menus are not numbered — every option carries the key that
// selects it, either bracketed up front ("[a] Trust this workspace") or
// parenthesised at the end ("Run (once) (y)"), with the highlighted row
// marked by an arrow glyph. Verified against a live cursor-agent 2026.09.08
// workspace-trust dialog and shell-approval prompt.
const CURSOR_MARKER = '[→▶❯➤>»]';
const CURSOR_BRACKET_PATTERN = new RegExp(
  `^\\s*(?:│\\s*)?(${CURSOR_MARKER})?\\s*\\[([^\\]\\s]{1,6})\\]\\s+(.+?)\\s*(?:│\\s*)?$`,
);
const CURSOR_HINT_PATTERN = new RegExp(
  `^\\s*(?:│\\s*)?(${CURSOR_MARKER})?\\s*(\\S.*?)\\s+\\(([^()]{1,32})\\)\\s*(?:│\\s*)?$`,
);
// A key hint may list alternatives ("esc or n", "y/Y"). Only a single printable
// character can be typed into the pane, so that is what the relay sends.
const CURSOR_KEY_SEPARATOR = /\s+or\s+|\s*[/,]\s*/;
// Box borders and blank rows sit between the options of a framed menu, so they
// must not break the run the way a real content line does.
const CURSOR_FILLER_PATTERN = /^[\s─-╿]*$/;
// Cursor's "Skip & tell the agent what to do instead" opens a text input rather
// than resolving, exactly like Claude Code's free-text built-ins.
const CURSOR_FREE_TEXT_PATTERN = /\btell the agent\b/i;


// A run is defined by the numbering sequence, not line contiguity: real menus
// wrap option descriptions onto indented continuation lines and interleave
// separators/footers, so any non-matching line is ignored rather than
// treated as a run breaker. The stale-scrollback guard the old contiguity
// rule provided is preserved by the sequence itself — a line numbered `1`
// (or any out-of-sequence number) closes the current run, so an
// already-answered menu earlier in scrollback can't merge with the current
// one, and the last qualifying run still wins.
function stripAdjacentColumn(content) {
  const gutter = content.match(COLUMN_GUTTER_PATTERN);
  return (gutter ? content.slice(0, gutter.index) : content).trim();
}

function detectNumberedList(text) {
  let currentRun = [];
  let bestRun = [];
  const closeRun = () => {
    if (currentRun.length >= 2) {
      bestRun = currentRun;
    }
    currentRun = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(NUMBERED_LINE_PATTERN);
    if (!match) {
      continue;
    }
    const [, number, content] = match;
    if (currentRun.length > 0 && Number(number) !== Number(currentRun[currentRun.length - 1].value) + 1) {
      closeRun();
    }
    // `value` is the digit itself, not the option's label text: these menus
    // are keypress-driven select widgets (arrow keys / digit jump-select),
    // not text inputs — typing the label does nothing and Enter just
    // confirms whatever was already highlighted, silently picking the
    // wrong option. Sending the digit (which this widget treats as an
    // immediate, self-confirming selection) is what actually drives it,
    // verified against a live Claude Code trust-folder prompt.
    const trimmedContent = stripAdjacentColumn(content);
    currentRun.push({
      label: `${number}. ${trimmedContent}`,
      value: number,
      ...(FREE_TEXT_LABEL_PATTERN.test(trimmedContent) ? { expectsText: true } : {}),
    });
  }
  closeRun();
  if (bestRun.length < 2) {
    return [];
  }
  return bestRun.slice(0, MAX_DETECTED_OPTIONS);
}

function cursorKeyFromHint(hint) {
  for (const token of hint.split(CURSOR_KEY_SEPARATOR)) {
    const key = token.trim();
    if (key.length === 1 && /\S/.test(key)) {
      return key;
    }
  }
  return null;
}

function cursorOption(marked, label, key) {
  const trimmedLabel = stripAdjacentColumn(label);
  if (trimmedLabel === '') {
    return null;
  }
  return {
    marked,
    option: {
      label: trimmedLabel,
      value: key,
      ...(CURSOR_FREE_TEXT_PATTERN.test(trimmedLabel) ? { expectsText: true } : {}),
    },
  };
}

function matchCursorLine(line) {
  const bracket = line.match(CURSOR_BRACKET_PATTERN);
  if (bracket) {
    const [, marker, key, label] = bracket;
    if (key.length === 1) {
      return cursorOption(Boolean(marker), label, key);
    }
  }
  const hinted = line.match(CURSOR_HINT_PATTERN);
  if (hinted) {
    const [, marker, label, hint] = hinted;
    const key = cursorKeyFromHint(hint);
    if (key) {
      return cursorOption(Boolean(marker), label, key);
    }
  }
  return null;
}

// Unlike the numbered detector there is no sequence to anchor on, so the run
// itself is the only evidence a menu is on screen: options must be adjacent
// (borders and blank rows aside) and at least one of them must carry the
// highlight marker. Without that marker requirement any two consecutive prose
// lines ending in a parenthesised character would read as a menu.
function detectCursorKeyedList(text) {
  let currentRun = [];
  let currentMarked = false;
  let bestRun = [];
  const closeRun = () => {
    if (currentMarked && currentRun.length >= 2) {
      bestRun = currentRun;
    }
    currentRun = [];
    currentMarked = false;
  };
  for (const line of text.split(/\r?\n/)) {
    const match = matchCursorLine(line);
    if (match) {
      currentRun.push(match.option);
      currentMarked = currentMarked || match.marked;
      continue;
    }
    if (CURSOR_FILLER_PATTERN.test(line)) {
      continue;
    }
    closeRun();
  }
  closeRun();
  return bestRun.slice(0, MAX_DETECTED_OPTIONS);
}

function detectYesNo(text) {
  if (!YES_NO_PATTERN.test(text)) {
    return [];
  }
  return [
    { label: 'Yes', value: 'y' },
    { label: 'No', value: 'n' },
  ];
}

function detectOptions(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [];
  }
  const numbered = detectNumberedList(text);
  if (numbered.length > 0) {
    return numbered;
  }
  const keyed = detectCursorKeyedList(text);
  if (keyed.length > 0) {
    return keyed;
  }
  return detectYesNo(text);
}

module.exports = { detectOptions, stripAdjacentColumn, MAX_DETECTED_OPTIONS };
