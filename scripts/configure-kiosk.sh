#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
user=${1:?Usage: configure-kiosk.sh GRAPHICAL_USER [PIPEWIRE_SINK_ID]}
sink=${2:-}
id "$user" >/dev/null
[[ -f /proc/device-tree/model ]] && grep -q 'Raspberry Pi' /proc/device-tree/model || { echo 'Only Raspberry Pi OS labwc is an implemented installation adapter.' >&2; exit 1; }
pgrep -u "$user" -x labwc >/dev/null || { echo 'No active labwc session for this user. Start Raspberry Pi OS Desktop labwc and rerun; no autostart files changed.' >&2; exit 1; }
command -v raspi-config >/dev/null || { echo 'raspi-config missing: configure autologin/blanking for the actual OS manually.' >&2; exit 1; }
[[ -f /etc/lightdm/lightdm.conf ]] || { echo 'Reference adapter requires LightDM.' >&2; exit 1; }
user_home=$(getent passwd "$user" | cut -d: -f6)
[[ $user_home == /* && $user_home != / ]] || exit 1
install -d -m 700 -o "$user" -g "$(id -gn "$user")" "$user_home/.config/labwc" "$user_home/.local/state/pi-player" "$user_home/.config/pi-player"
autostart="$user_home/.config/labwc/autostart"
if [[ -f $autostart ]]; then cp -a -- "$autostart" "$autostart.pi-player-backup-$(date +%Y%m%d%H%M%S)"; fi
line='/opt/pi-player/scripts/start-kiosk.sh 2>&1 | systemd-cat -t pi-player-kiosk &'
touch "$autostart"
grep -Fqx "$line" "$autostart" || printf '\n%s\n' "$line" >>"$autostart"
chown "$user:$(id -gn "$user")" "$autostart"
install -d /etc/lightdm/lightdm.conf.d
printf '[Seat:*]\nautologin-user=%s\nautologin-user-timeout=0\n' "$user" >/etc/lightdm/lightdm.conf.d/90-pi-player.conf
raspi-config nonint do_blanking 1
# The dashboard sets the device volume by running wpctl from the backend, and wpctl reaches the desktop
# session's PipeWire only as that session's user. So the service runs as this user. NoNewPrivileges stays
# on in the unit, so the user's sudo rights never apply to the service.
data=$(python3 - /opt/pi-player/appsettings.Production.json <<'PY'
import json, sys
with open(sys.argv[1]) as f: print(json.load(f)['PiPlayer']['DataPath'])
PY
)
[[ $data == /* && $data != / && -d $data ]] || { echo 'PiPlayer data directory missing; install PiPlayer first.' >&2; exit 1; }
group=$(id -gn "$user")
install -d /etc/systemd/system/pi-player.service.d
printf '[Service]\nUser=%s\nGroup=%s\nEnvironment=XDG_RUNTIME_DIR=/run/user/%s\nProtectHome=read-only\n' \
  "$user" "$group" "$(id -u "$user")" >/etc/systemd/system/pi-player.service.d/20-desktop-user.conf
chown -R "$user:$group" "$data"
systemctl daemon-reload
systemctl restart pi-player.service
if [[ -n $sink ]]; then
  [[ $sink =~ ^[0-9]+$ ]] || { echo 'Sink must be a numeric wpctl ID.' >&2; exit 1; }
  runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$user")" wpctl set-default "$sink"
fi
echo "PiPlayer service now runs as $user, so the dashboard can set the volume with wpctl."
echo 'labwc autostart, LightDM autologin and blanking configured. Verify the default audio sink with wpctl status as the desktop user, then run cold-boot acceptance.'
