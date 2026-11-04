# herdr-notifications

A [herdr](https://github.com/herdr) plugin that messages you on **Telegram**, **Discord** and/or
**Slack** when one of your coding agents changes state — goes **idle**, gets **blocked** (waiting
for your input), or is **done**. Each status is filtered independently: by default `idle` and
`done` only notify for a run that lasted at least 15 minutes, so finishing something you just
started and are still watching stays silent, while `blocked` always notifies. Any combination of providers can run in parallel; it is all
driven by one config file. Zero runtime dependencies.

## How it works

A background watcher (started by herdr via the plugin's `[[startup]]` entry) polls
`herdr agent list`, diffs each pane's `agent_status`, and sends a message to **every** enabled
provider for each notify-worthy transition.

Notification types:

| Type | Fires when |
|---|---|
| `idle` | an agent finishes working (`working` → `idle`) |
| `blocked` | an agent is blocked / waiting for your input |
| `done` | an agent completes its run |

Providers are independent: if your Slack token is revoked, Telegram and Discord still get the
message, and the failure is logged plus surfaced as a desktop toast naming the provider.

## Interactive relay

With `relay.enabled: true`, a `blocked` notification becomes two-way on **every** provider: the
plugin captures the agent's recent pane output, tries to detect a selectable option list (a
numbered menu or a `(y/n)`-style prompt) in it, and sends it along with the options. Your answer
— from any provider — is typed straight back into the blocked agent's pane, and the original
message is edited in place on all providers to show what was picked.

This stays consistent with the rest of the plugin: **poll-only, no tunnel, no webhook**. Each
provider is polled on the relay's own cadence (`relay.pollMs`) alongside the agent-status poll:

| Provider | Inbound | Answer by |
|---|---|---|
| Telegram | `getUpdates` poll | tapping an inline button, or replying |
| Slack | `conversations.history` poll + Socket Mode WebSocket | tapping a Block Kit button (needs `appToken`), or replying |
| Discord | `GET /channels/{id}/messages?after=…` poll | replying with the value shown next to an option |

**Buttons.** Telegram delivers button taps over the same poll it already makes, so they work with
no extra setup. Slack needs [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)
— the app opens an *outbound* WebSocket to Slack and clicks arrive over it, so no public endpoint
is required; set `providers.slack.appToken` to an app-level token to enable it. Without that token
Slack falls back to listing options as `` `1` — Yes, proceed `` lines that you reply to. Discord
always uses that fallback (its components would need a public interactions endpoint; its gateway
could carry them, which is not implemented).

**Typed answers always work**, on every provider, whether or not buttons are available — that is
the path a real text prompt needs (a shell `(y/n)` read, a commit message). Options that open a
text input rather than resolving immediately (e.g. Claude Code's "Type something") are marked ✏️,
and selecting one keeps the pane tracked and asks you for the follow-up text.

**Multi-question prompts** are walked one question at a time. Claude Code's `AskUserQuestion` can
hold several questions in a single prompt (rendered as tabs — `□ Report layout  □ Report link
✓ Submit`), and answering one advances the pane to the next rather than unblocking it. Since the
agent never leaves `blocked`, no new state transition fires, so the plugin re-reads the pane after
each answer and sends the next question as its own message with its own buttons. It stops when the
pane presents no menu, or presents the same one it just answered (so a slow redraw cannot loop).

That same prompt renders its option list beside a preview panel, sharing terminal rows. The
option detector cuts each label at the column gutter, so a label is the option's own text rather
than the option plus a slice of the panel's box-drawing art.

**Security**: every inbound message is scoped to the channel you configured. Telegram messages and
button taps are additionally checked against your `chatId` and dropped silently if they come from
anywhere else — no reply, no acknowledgement — so a leaked bot token cannot be used to inject
input into your terminals. Messages posted by bots/apps (including this plugin's own) are never
treated as answers.

If more than one agent is blocked at once, reply directly to the specific agent's notification to
target it; a plain (non-reply) message only works when exactly one agent is currently blocked.

Buttons and option values are a shortcut, not the only path: a free-text reply that matches one of
the shown options (by its label or its value, case-insensitive) is resolved exactly like tapping
that button — this matters because some menus (e.g. Claude Code's own approval dialogs) are
keypress-driven, so an unmatched free-text reply typed character-by-character wouldn't actually
select anything. Anything that doesn't match a shown option is relayed as plain typed text, which
is what a real text-input prompt (a shell `(y/n)` read, a `git commit` message, etc.) needs.

## Install

From the herdr marketplace (the repo carries the `herdr-plugin` topic):

```bash
herdr plugin install barnuri/herdr-notifications
```

Or link a local checkout for development:

```bash
git clone https://github.com/barnuri/herdr-notifications
herdr plugin link ./herdr-notifications
```

## Configure

Run the plugin's **Edit notification settings** action (or create the file yourself). Config lives
at `$HERDR_PLUGIN_CONFIG_DIR/config.json` (fallback: `~/.config/herdr-notifications/config.json`)
— never inside the repo.

```json
{
    "enabled": true,
    "pollMs": 2000,
    "notifyOn": {
        "defaults": {
            "minWorkingMs": 900000,
            "skipWhenFocused": false
        },
        "idle": {
            "enabled": true,
            "minWorkingMs": 900000,
            "skipWhenFocused": false
        },
        "blocked": {
            "enabled": true,
            "minWorkingMs": 0,
            "skipWhenFocused": false
        },
        "done": {
            "enabled": true,
            "minWorkingMs": 900000,
            "skipWhenFocused": false
        }
    },
    "relay": {
        "enabled": false,
        "contextLines": 40,
        "pollMs": 1000
    },
    "providers": {
        "telegram": {
            "enabled": true,
            "botToken": "1234567890:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "chatId": "123456789"
        },
        "discord": {
            "enabled": false,
            "botToken": "",
            "channelId": ""
        },
        "slack": {
            "enabled": false,
            "botToken": "xoxb-…",
            "channelId": "C0123456789",
            "appToken": "xapp-…"
        }
    }
}
```

### Config reference

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` disables all notifications on all providers. |
| `pollMs` | `2000` | Agent-status poll interval in milliseconds (minimum 500). |
| `notifyOn.<status>.enabled` | `true` | Whether this status notifies at all. `<status>` is `idle`, `blocked`, or `done`. |
| `notifyOn.<status>.minWorkingMs` | `900000` for `idle`/`done`, `0` for `blocked` | Suppress the notification unless the pane's most recent finished `working` run lasted at least this long. Measured across intermediate states, so a `done` reached via `idle` is still judged on the work that preceded it. `0` disables the check. |
| `notifyOn.<status>.skipWhenFocused` | `false` | Suppress the notification when that pane is the one you are looking at. |
| `notifyOn.<status>.delaySeconds` | `0` | Hold the notification this many seconds, then send it only if the pane is still in that status. A newer status change for the pane cancels the held send. Blocked events routed through the relay are never delayed, so auto-approve stays immediate. |
| `notifyOn.defaults.minWorkingMs` | — | Applies to every status that does not set its own. |
| `notifyOn.defaults.skipWhenFocused` | — | Applies to every status that does not set its own. |
| `relay.enabled` | `false` | Master switch for the interactive relay. Off by default. |
| `relay.contextLines` | `40` | Lines of recent pane output to capture and show for a blocked agent (1–200). |
| `relay.pollMs` | `1000` | How often to poll each provider for replies (minimum 500). Independent of `pollMs`. |
| `providers.<id>.enabled` | `false` | Per-provider switch. Enable as many as you like. |
| `providers.telegram.botToken` | `""` | Bot API token from BotFather. |
| `providers.telegram.chatId` | `""` | Target chat id (string or number; groups are negative). |
| `providers.discord.botToken` | `""` | Discord **bot** token (not the client secret). |
| `providers.discord.channelId` | `""` | Target channel id. |
| `providers.slack.botToken` | `""` | Slack bot token (`xoxb-…`). |
| `providers.slack.channelId` | `""` | Target channel id (e.g. `C0123456789`). |
| `providers.slack.appToken` | `""` | Optional app-level token (`xapp-…`) with `connections:write`. Enables Socket Mode, and with it real buttons instead of reply-with-a-value. |

A provider is used only when it is both `enabled` **and** has all its credentials filled in. An
enabled-but-incomplete provider is called out once in the log rather than failing silently.

Upgrading from `herdr-telegram-notifications` needs no action: a pre-rename config with top-level
`botToken`/`chatId` is adopted as the `telegram` provider, and a config left behind in the old
plugin's config directory is picked up automatically and migrated forward on the first edit.

### Notification filter

`notifyOn` decides which of the three types actually get sent. The plugin's **Cycle notification
filter** action steps through three presets without editing JSON:

| Preset | Sends | Use when |
|---|---|---|
| `all` | blocked 🔴 + idle 🟡 + done 🟢 | you want every state change |
| `needs-me` | blocked 🔴 + idle 🟡 | you only want pings when an agent is waiting on you |
| `blocked-only` | blocked 🔴 | you only want approval/input prompts |

Each run advances to the next preset and shows a desktop toast with the new setting. Any
hand-edited combination counts as custom, and the next run resets it to `all`. A preset only
toggles `enabled`, so the `minWorkingMs` / `skipWhenFocused` rules a status carries survive a
cycle untouched. To set one directly instead of cycling:

```bash
node bin/notify-filter.js needs-me
```

**Defaults are opt-out**: every notification type is enabled by default, and any key missing from
the file falls back to its default. Enable-all is therefore just removing the `notifyOn` block;
disable-all is `"enabled": false`.

## Provider setup

### Telegram

1. Start a chat with [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a display name and a username ending in `bot`.
3. BotFather replies with an **HTTP API token** — that is `botToken`.
4. Send your new bot any message (a bot cannot message you first), then run:

   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```

   Find `"chat":{"id":123456789,…}` — that number is `chatId`. Group chat ids are negative
   (e.g. `-1001234567890`); add the bot to the group and post a message there first.

Revoke a leaked token with `/revoke` in BotFather.

### Discord

1. At [discord.com/developers/applications](https://discord.com/developers/applications) create an
   application, then open **Bot** and copy the token — that is `botToken`.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent** (required to read
   your replies for the relay; not needed if you only want one-way notifications).
3. Invite the bot to your server with the `bot` scope and the **View Channels**,
   **Send Messages** and **Read Message History** permissions.
4. In Discord, enable **Settings → Advanced → Developer Mode**, then right-click the target
   channel → **Copy Channel ID** — that is `channelId`.

### Slack

1. At [api.slack.com/apps](https://api.slack.com/apps) create an app (**From scratch**, or from a
   manifest).
2. Under **OAuth & Permissions**, add these **Bot Token Scopes**: `chat:write` plus the history
   scope for your channel type — `channels:history` (public), `groups:history` (private),
   `im:history` (DM), `mpim:history` (group DM). The history scopes are only needed for the relay.
3. **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`) — that is `botToken`.
4. Invite the bot into the channel (`/invite @YourApp`), then copy the channel id from the
   channel's **View channel details → About** (e.g. `C0123456789`) — that is `channelId`.

That is enough for notifications and for typed answers. For **tappable buttons**, also:

5. Under **Interactivity & Shortcuts**, turn interactivity on. No Request URL is needed.
6. Under **Socket Mode**, enable Socket Mode.
7. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write`
   scope and copy it (`xapp-…`) — that is `appToken`. App-level tokens can only be created in the
   UI, not through the API.

Steps 5–7 are optional: leave `appToken` empty and Slack uses the reply-with-a-value list instead.

## Test it

Run the plugin's **Send test notification** action. Every enabled provider is attempted, and the
desktop toast lists which ones received the message and which failed.

## Security notes

- Bot tokens live only in the config file under `HERDR_PLUGIN_CONFIG_DIR`, written `0600` — never
  hardcode them, never commit them.
- All provider traffic goes over HTTPS with default TLS verification.
- Error output never includes a token.
- Inbound messages are scoped to the configured chat/channel, and bot-authored messages are never
  treated as answers.

## Development

```bash
npm test
```

Tests use the built-in `node:test` runner (Node >= 22). No dependencies to install.

Adding a provider is three edits: a class in `lib/providers/`, a line in `lib/providers/index.js`,
and a config block in `lib/config.js`.

The relay is provider-agnostic: a button tap and a typed reply both arrive as a normalised inbound
event (`lib/providers/inbound.js`), so a provider that gains buttons needs no relay changes — the
Slack Socket Mode support reuses the same `r:<token>:<index>` routing string as Telegram's
callback data.

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
