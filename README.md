# herdr-telegram-notifications

A [herdr](https://github.com/herdr) plugin that sends you a Telegram message when one of your
coding agents changes state — goes **idle**, gets **blocked** (waiting for your input), or is
**done**. Zero runtime dependencies.

## How it works

A background watcher (started by herdr via the plugin's `[[startup]]` entry) polls
`herdr agent list`, diffs each pane's `agent_status`, and sends a Telegram message for every
notify-worthy transition that is enabled in your config.

Notification types:

| Type | Fires when |
|---|---|
| `idle` | an agent finishes working (`working` → `idle`) |
| `blocked` | an agent is blocked / waiting for your input |
| `done` | an agent completes its run |

## Interactive relay

With `relay.enabled: true`, a `blocked` notification becomes two-way: the plugin captures the
agent's recent pane output, tries to detect a selectable option list (a numbered menu or a
`(y/n)`-style prompt) in it, and sends a Telegram message with inline buttons for those options.
Tapping a button — or just replying to the message with free text — sends your answer straight
back to the blocked agent's pane.

This stays consistent with the rest of the plugin: **poll-only, no tunnel, no webhook**. The
background watcher periodically calls Telegram's `getUpdates` on its own cadence (`relay.pollMs`)
alongside the existing agent-status poll.

**Security**: every incoming Telegram message or button tap is checked against your configured
`chatId` before it can touch an agent. Anything from a different chat is dropped silently — no
reply, no acknowledgement — so a leaked bot token cannot be used to inject input into your
terminals.

If more than one agent is blocked at once, reply directly to the specific agent's Telegram
notification to target it; a plain (non-reply) message only works when exactly one agent is
currently blocked.

Buttons are a shortcut, not the only path: when options are detected, typing a free-text reply
that matches one of the shown options (by its label or its value, case-insensitive) is resolved
exactly like tapping that button — this matters because some menus (e.g. Claude Code's own
approval dialogs) are keypress-driven, so an unmatched free-text reply typed character-by-character
wouldn't actually select anything. Anything that doesn't match a shown option is still relayed
as plain typed text, which is what a real text-input prompt (a shell `(y/n)` read, a `git commit`
message, etc.) needs.

## Step 1 — Create a Telegram bot with @BotFather

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather) (verified blue-check bot).
2. Send `/newbot`.
3. Choose a display name (e.g. `My Herdr Notifications`).
4. Choose a username — it must end in `bot` (e.g. `my_herdr_notifications_bot`).
5. BotFather replies with an **HTTP API token** that looks like
   `1234567890:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. This is your `botToken`.

Treat the token like a password: it goes only in the plugin's config file (outside any git
repo). If it ever leaks, revoke it with `/revoke` in BotFather.

## Step 2 — Get your chat id

1. Open a chat with your new bot and send it any message (e.g. `hi`) — a bot cannot message
   you first.
2. In a terminal, run (replace `<TOKEN>` with your bot token):

   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```

3. In the JSON response, find `"chat":{"id":123456789,...}`. That number is your `chatId`.

For a group chat: add the bot to the group, send a message in the group, and run the same
command — group chat ids are negative numbers (e.g. `-1001234567890`).

## Step 3 — Install the plugin

From the herdr marketplace (the repo carries the `herdr-plugin` topic):

```bash
herdr plugin install barnuri/herdr-telegram-notifications
```

Or link a local checkout for development:

```bash
git clone https://github.com/barnuri/herdr-telegram-notifications
herdr plugin link ./herdr-telegram-notifications
```

## Step 4 — Configure

Run the plugin's **Edit Telegram notification settings** action (or create the file yourself).
Config lives at `$HERDR_PLUGIN_CONFIG_DIR/config.json` (fallback:
`~/.config/herdr-telegram-notifications/config.json`) — never inside the repo.

```json
{
    "enabled": true,
    "botToken": "1234567890:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "chatId": "123456789",
    "pollMs": 2000,
    "notifyOn": {
        "idle": true,
        "blocked": true,
        "done": true
    }
}
```

### Config reference

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` disables all notifications (disable-all). |
| `botToken` | `""` | Bot API token from BotFather. Required for sending. |
| `chatId` | `""` | Chat id from Step 2 (string or number). Required for sending. |
| `pollMs` | `2000` | Poll interval in milliseconds (minimum 500). |
| `notifyOn.idle` | `true` | Notify when an agent goes idle. |
| `notifyOn.blocked` | `true` | Notify when an agent is blocked / needs input. |
| `notifyOn.done` | `true` | Notify when an agent finishes. |
| `relay.enabled` | `false` | Master switch for the interactive relay (see below). Off by default. |
| `relay.contextLines` | `40` | Lines of recent pane output to capture and show for a blocked agent (1–200). |
| `relay.pollMs` | `1000` | How often to poll Telegram for replies (minimum 500). Independent of `pollMs`. |

### Notification filter

`notifyOn` decides which of the three types actually reach Telegram. The plugin's **Cycle
Telegram notification filter** action steps through three presets without editing JSON:

| Preset | Sends | Use when |
|---|---|---|
| `all` | blocked 🔴 + idle 🟡 + done 🟢 | you want every state change |
| `needs-me` | blocked 🔴 + idle 🟡 | you only want pings when an agent is waiting on you |
| `blocked-only` | blocked 🔴 | you only want approval/input prompts |

Each run advances to the next preset and shows a desktop toast with the new setting. Any
hand-edited combination counts as custom, and the next run resets it to `all`. To set one
directly instead of cycling:

```bash
node bin/notify-filter.js needs-me
```

**Defaults are opt-out**: every notification type is enabled by default, and any key missing
from the file falls back to its default — an empty `{}` config (with token + chat id) means
"send me everything". Enable-all is therefore just removing the `notifyOn` block (or setting
every key `true`); disable-all is `"enabled": false`.

## Step 5 — Test it

Run the plugin's **Send test Telegram message** action. You should receive a test message in
Telegram; a desktop toast confirms success or points at what's missing in the config.

## Security notes

- The bot token lives only in the config file under `HERDR_PLUGIN_CONFIG_DIR` — never hardcode
  it, never commit it.
- All Telegram traffic goes over HTTPS with default TLS verification.
- Error output never includes the token.

## Development

```bash
npm test
```

Tests use the built-in `node:test` runner (Node >= 22). No dependencies to install.

### End-to-end test (opt-in)

```bash
npm run test:e2e
```

Not part of `npm test` / CI. This spins up a real, disposable, unfocused `herdr` workspace in a
brand-new scratch directory, launches a real `claude` binary to force its first-run trust-folder
dialog, and verifies `lib/option-detector.js` + `herdr.answerBlockedAgent` actually drive that
live dialog correctly (not just against captured/hardcoded text). Requires the `herdr` CLI and an
authenticated `claude` binary on `PATH`; takes several seconds; tears down the workspace and
scratch dir itself, on success or failure.

## License

MIT
