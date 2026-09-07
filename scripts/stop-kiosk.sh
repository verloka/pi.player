#!/usr/bin/env bash
set -euo pipefail
pid_file="$HOME/.local/state/pi-player/launcher.pid"
[[ -f $pid_file ]] || exit 0
read -r pid <"$pid_file"
[[ $pid =~ ^[0-9]+$ ]] || exit 1
[[ -r /proc/$pid/cmdline ]] || exit 0
command_line=$(tr '\0' ' ' </proc/"$pid"/cmdline)
[[ $command_line == *'/opt/pi-player/scripts/start-kiosk.sh'* ]] || { echo 'PID no longer belongs to PiPlayer launcher; refusing to stop it.' >&2; exit 1; }
kill -TERM "$pid"
for attempt in {1..20}; do kill -0 "$pid" 2>/dev/null || exit 0; sleep 1; done
echo 'Launcher has not stopped. Inspect its owned Chromium process group before updating.' >&2
exit 1
