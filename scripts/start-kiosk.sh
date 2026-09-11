#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -ne 0 ]] || { echo 'Run Chromium as the graphical user, never root.' >&2; exit 1; }
[[ -n ${WAYLAND_DISPLAY:-}${DISPLAY:-} ]] || { echo 'No graphical session. Start from labwc autostart.' >&2; exit 1; }
for utility in curl flock python3 setsid; do command -v "$utility" >/dev/null || { echo "Missing $utility" >&2; exit 1; }; done
chromium=$(command -v chromium || command -v chromium-browser || true)
[[ -n $chromium ]] || { echo 'Chromium not installed.' >&2; exit 1; }
profile="$HOME/.local/share/pi-player/chromium-profile"
state_dir="$HOME/.local/state/pi-player"
mkdir -p "$profile" "$state_dir"
chmod 700 "$profile" "$state_dir"
exec 9>"$state_dir/launcher.lock"
flock -n 9 || { echo 'PiPlayer launcher already running.'; exit 0; }
printf '%s\n' "$$" >"$state_dir/launcher.pid"
origin='http://localhost:5000'
# Keep browser UI and permission dialogs off an unattended screen. PipeWire camera
# discovery can open an OS portal dialog before a web permission prompt is shown.
kiosk_args=(
  --user-data-dir="$profile" --profile-directory=Default --kiosk
  --no-first-run --no-default-browser-check --password-store=basic --noerrdialogs
  --deny-permission-prompts --disable-notifications --disable-extensions
  --disable-features=Translate,WebRtcPipeWireCamera,MediaRouter
  --disable-session-crashed-bubble --propagate-iph-for-testing
  --autoplay-policy=no-user-gesture-required
)
browser_pid=''
stop_browser() {
  if [[ -n $browser_pid ]]; then
    kill -TERM -- "-$browser_pid" 2>/dev/null || true
    for attempt in {1..10}; do kill -0 -- "-$browser_pid" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$browser_pid" 2>/dev/null || true
    wait "$browser_pid" 2>/dev/null || true
    browser_pid=''
  fi
}
finish() { stop_browser; rm -f -- "$state_dir/launcher.pid"; exit 0; }
trap finish TERM INT HUP
restarts=()
while true; do
  until curl --silent --fail --max-time 3 "$origin/api/system/ready" >/dev/null; do sleep 3; done
  now=$(date +%s); recent=()
  for stamp in "${restarts[@]}"; do ((now-stamp < 600)) && recent+=("$stamp"); done
  restarts=("${recent[@]}")
  if ((${#restarts[@]} >= 3)); then echo 'Restart limit reached; cooling down for 5 minutes.'; sleep 300; continue; fi
  echo 'Launching dedicated Chromium kiosk.'
  # Chromium is stopped here. Avoid a restore-tabs prompt after a watchdog kill
  # or power loss, preserving every other preference and the persistent profile.
  python3 - "$profile" <<'PY'
import json, os, pathlib, sys
path = pathlib.Path(sys.argv[1]) / 'Default' / 'Preferences'
if path.exists():
    try:
        prefs = json.loads(path.read_text(encoding='utf-8'))
        profile = prefs.setdefault('profile', {})
        profile['exit_type'] = 'Normal'
        profile['exited_cleanly'] = True
        temporary = path.with_name('Preferences.pi-player.tmp')
        temporary.write_text(json.dumps(prefs), encoding='utf-8')
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except (ValueError, TypeError, AttributeError):
        print('Cannot read Chromium preferences; original file preserved.', file=sys.stderr)
PY
  # Avoid desktop keyring creation/unlock dialogs during unattended autologin.
  # This dedicated kiosk profile must not be used to save passwords.
  setsid "$chromium" "${kiosk_args[@]}" "$origin/screen" &
  browser_pid=$!
  started=$(date +%s); failures=0; silent_notice=0
  while kill -0 -- "-$browser_pid" 2>/dev/null; do
    sleep 10
    now=$(date +%s); ((now-started >= 60)) || continue
    if ! response=$(curl --silent --fail --max-time 3 "$origin/api/system/kiosk-status"); then failures=0; continue; fi
    # This screen has no input devices. Report a muted picture once instead of every ten seconds.
    if python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("soundWaitingForGesture") else 1)' <<<"$response"; then
      ((silent_notice)) || echo 'Picture runs without sound: this Chromium has not permitted audible autoplay. Check the --autoplay-policy switch below and the Chromium package wrapper.'
      silent_notice=1
    else
      silent_notice=0
    fi
    # Blocked playback counts as unhealthy: a fresh browser is the one thing a kiosk can try on its own.
    # Content errors deliberately do not, because restarting cannot fix an unsupported file.
    if python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if not d["serverReady"] or (d["screenConnected"] and d["lastHeartbeatAgeSeconds"] is not None and d["lastHeartbeatAgeSeconds"] <= 30 and not d.get("playbackStalled")) else 1)' <<<"$response"; then
      failures=0
    else
      failures=$((failures+1))
      if ((failures >= 3)); then echo 'Renderer heartbeat absent or playback refused. Restarting owned kiosk process group.'; stop_browser; break; fi
    fi
  done
  stop_browser
  restarts+=("$(date +%s)")
  sleep 5
done
