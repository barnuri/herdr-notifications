'use strict';

const MAX_DETECTED_OPTIONS = 8;
// Tolerates a leading cursor/border glyph (e.g. Claude Code's own `❯` on the
// currently-highlighted option) before the digit — without this, the
// highlighted line never matches and a 2-option menu can't reach the
// 2-line contiguous-run threshold below, so the whole menu goes undetected.
const NUMBERED_LINE_PATTERN = /^\s*[❯›>│┃]?\s*(\d+)[.)]\s+(.+)$/;
const YES_NO_PATTERN = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]/i;

// Only a contiguous (blank-line-tolerant) run of numbered lines counts as one
// option list, and the last qualifying run wins — otherwise a stale menu from
// an earlier, already-answered prompt still visible in scrollback could merge
// with (or mask) the current one.
function detectNumberedList(text) {
  let currentRun = [];
  let bestRun = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(NUMBERED_LINE_PATTERN);
    if (match) {
      const [, number, content] = match;
      // `value` is the digit itself, not the option's label text: these menus
      // are keypress-driven select widgets (arrow keys / digit jump-select),
      // not text inputs — typing the label does nothing and Enter just
      // confirms whatever was already highlighted, silently picking the
      // wrong option. Sending the digit (which this widget treats as an
      // immediate, self-confirming selection) is what actually drives it,
      // verified against a live Claude Code trust-folder prompt.
      currentRun.push({ label: `${number}. ${content.trim()}`, value: number });
      continue;
    }
    if (line.trim() === '') {
      continue;
    }
    if (currentRun.length >= 2) {
      bestRun = currentRun;
    }
    currentRun = [];
  }
  if (currentRun.length >= 2) {
    bestRun = currentRun;
  }
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

module.exports = { detectOptions, MAX_DETECTED_OPTIONS };
