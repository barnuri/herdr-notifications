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
  return detectYesNo(text);
}

module.exports = { detectOptions, stripAdjacentColumn, MAX_DETECTED_OPTIONS };
