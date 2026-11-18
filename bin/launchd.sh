#!/bin/sh
# Runs the watcher as a macOS launchd agent, so hc (herdr-app) agents notify
# even when the herdr TUI server is not running. It shares the TUI plugin's
# config dir and watch.pid lock: with --wait-lock only one watcher is active,
# and the other waits to take over.
#
#   bin/launchd.sh install     write the plist and start it (also restarts it)
#   bin/launchd.sh uninstall   stop it and move the plist to the Trash
#   bin/launchd.sh status      show launchd state and the log tail
set -eu

LABEL="com.barnuri.herdr-notifications"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr/plugins/config/barnuri.notifications}"
LOG="$HOME/Library/Logs/herdr-notifications.log"
DOMAIN="gui/$(id -u)"
NODE="$(command -v node)"

write_plist() {
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$PLUGIN_DIR/bin/watch.js</string>
        <string>--wait-lock</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PLUGIN_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HERDR_PLUGIN_CONFIG_DIR</key>
        <string>$CONFIG_DIR</string>
        <key>PATH</key>
        <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
EOF
}

case "${1:-}" in
  install)
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    write_plist
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "installed $PLIST (log: $LOG)"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    [ -f "$PLIST" ] && trash "$PLIST"
    echo "uninstalled $LABEL"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =|last exit" || echo "$LABEL is not loaded"
    tail -n 5 "$LOG" 2>/dev/null || true
    ;;
  *)
    echo "usage: $0 install|uninstall|status" >&2
    exit 2
    ;;
esac
