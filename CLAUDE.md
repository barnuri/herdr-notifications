# herdr-notifications — agent instructions

## Always restart the local install after code changes

This plugin runs as a persistent background process declared via `[[startup]]` in
`herdr-plugin.toml` (`node bin/watch.js`). That process is spawned once, when herdr's own
server starts — **not** on `herdr plugin enable`/`disable`. Confirmed empirically (herdr 0.8.2):
running `herdr plugin disable barnuri.notifications` then `herdr plugin enable
barnuri.notifications` reports success but does not kill or respawn the running
`bin/watch.js` process. Code changes to `lib/*.js` or `bin/watch.js` sit inert in an
already-running process until it's actually restarted.

Whenever you finish a change to this plugin's code (anything the running process loads —
`lib/*.js`, `bin/watch.js`), restart it yourself as the last step, without being asked:

```bash
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"   # or hardcode the repo path
CONFIG_DIR="$(herdr plugin config-dir barnuri.notifications)"
# Resolve pids first, then kill them — do NOT use `pkill -f "<pattern>"` here.
# `pkill -f` matches against every process's full command line, including the
# shell running this very snippet (the pattern appears verbatim in its argv),
# so pkill intermittently kills its own shell and the restart silently half-runs.
# Match on the absolute script path, not just "bin/watch.js": a sibling plugin
# (herdr-auto-update) runs the exact same relative command.
for pid in $(pgrep -f "herdr-notifications/bin/watch\.js"); do
  kill "$pid" 2>/dev/null
done
# The process traps SIGTERM and exits at its next poll tick, not instantly.
until [ -z "$(pgrep -f "herdr-notifications/bin/watch\.js")" ]; do sleep 1; done
HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" nohup node "$PLUGIN_DIR/bin/watch.js" >> "$CONFIG_DIR/watch.log" 2>&1 &
disown
```

`$CONFIG_DIR` is where the real `config.json` (the `providers` block with each bot token) lives — it's not the
`~/.config/herdr-notifications` fallback path in `lib/config.js`'s defaults, that
fallback is only used when nothing sets `HERDR_PLUGIN_CONFIG_DIR` (e.g. running scripts by hand
outside herdr). Always pass it through explicitly when relaunching, or the process will start
against an empty/default config and silently warn "not configured" instead of sending messages.

No restart needed for the one-shot action scripts (`bin/edit-config.js`, `bin/test-message.js`,
`bin/e2e-option-detector.js`) — those run fresh on every invocation. Also no restart needed for
test-only or doc-only changes.
