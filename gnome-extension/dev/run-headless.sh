#!/usr/bin/env bash
# Run a headless nested GNOME Shell with only this extension enabled, for
# development without a visible window. Drive it with dev/drive.py (screenshots,
# clicks, keys over the nested session bus).
#
#   dev/run-headless.sh [ADDR_FILE]     ADDR_FILE gets the nested session bus address
#
# In-memory GSettings backend: nothing leaks into the real session's dconf.
# Note: disable the extension in the live session first (one RFCOMM client at a time).
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
UUID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$HERE/metadata.json")
ADDR_FILE=${1:-/tmp/xm5-nested-bus}
LINK="$HOME/.local/share/gnome-shell/extensions/$UUID"
if [ ! -e "$LINK" ]; then
    mkdir -p "$(dirname "$LINK")"
    ln -s "$HERE" "$LINK"
    echo "symlinked $LINK -> $HERE"
fi

export GSETTINGS_BACKEND=memory
export XM5_UUID="$UUID" XM5_ADDR_FILE="$ADDR_FILE"
export MONITOR="${MONITOR:-1600x1000}"
exec dbus-run-session -- bash -c '
    echo "$DBUS_SESSION_BUS_ADDRESS" > "$XM5_ADDR_FILE"
    gnome-shell --headless --virtual-monitor "$MONITOR" --wayland --no-x11 2>&1 &
    SHELL_PID=$!
    for i in $(seq 1 60); do
        gnome-extensions enable "$XM5_UUID" 2>/dev/null && break
        sleep 0.5
    done
    echo "=== extension $XM5_UUID enabled in headless shell (pid $SHELL_PID), bus in $XM5_ADDR_FILE"
    wait $SHELL_PID
'
