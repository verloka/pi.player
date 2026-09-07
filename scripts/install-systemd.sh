#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
release=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
address=''; cidr=''; data='/opt/pi-player/data'; mount=''
while (($#)); do
  case "$1" in
    --lan-address) address=${2:?}; shift 2;;
    --lan-cidr) cidr=${2:?}; shift 2;;
    --data-path) data=${2:?}; shift 2;;
    --expected-mount) mount=${2:?}; shift 2;;
    *) echo 'Usage: install-systemd.sh --lan-address IP --lan-cidr CIDR [--data-path /mounted/path --expected-mount /mountpoint]' >&2; exit 1;;
  esac
done
[[ -n $address && -n $cidr ]] || { echo 'Explicit LAN address and CIDR are required.' >&2; exit 1; }
for cmd in python3 systemctl curl nft tar; do command -v "$cmd" >/dev/null || { echo "Install required tool: $cmd" >&2; exit 1; }; done
python3 - "$address" "$cidr" <<'PY'
import ipaddress,sys
address=ipaddress.ip_address(sys.argv[1]); network=ipaddress.ip_network(sys.argv[2],strict=False)
assert address.version==4 and address in network and not address.is_loopback,'Use the Pi LAN IPv4 address and subnet.'
PY
[[ $(getconf LONG_BIT) == 64 && $(uname -m) == aarch64 ]] || { echo 'This release requires ARM64 Linux userspace and kernel.' >&2; exit 1; }
[[ -x $release/PiPlayer.Server || -f $release/PiPlayer.Server ]] || { echo 'Run this script from the extracted release.' >&2; exit 1; }
[[ $data =~ ^/[A-Za-z0-9._/-]+$ && $data != / && $data != /opt/pi-player ]] || { echo 'Invalid data path.' >&2; exit 1; }
if [[ $data != /opt/pi-player/data ]]; then
  [[ -n $mount ]] && mountpoint -q "$mount" || { echo 'External data mount is absent; refusing to create an empty local library.' >&2; exit 1; }
  data=$(realpath -m -- "$data"); mount=$(realpath -- "$mount")
  [[ $data == "$mount/"* ]] || { echo 'Data path must be inside expected mount.' >&2; exit 1; }
fi
target='/opt/pi-player'
id pi-player >/dev/null 2>&1 || useradd --system --home-dir "$target" --shell /usr/sbin/nologin pi-player
install -d -m 755 "$target"
systemctl stop pi-player.service 2>/dev/null || true
if [[ -d $data ]]; then
  install -d -m 700 /var/backups/pi-player
  tar -czf "/var/backups/pi-player/data-$(date +%Y%m%d%H%M%S).tar.gz" -C "$(dirname -- "$data")" "$(basename -- "$data")"
fi
if [[ $release != "$target" ]]; then
  # Copy only release files. Never use --delete on the application/data tree.
  while IFS= read -r -d '' entry; do
    name=$(basename -- "$entry")
    case "$name" in data|appsettings.Production.json) continue;; esac
    cp -a -- "$entry" "$target/"
  done < <(find "$release" -mindepth 1 -maxdepth 1 -print0)
fi
chmod 755 "$target/PiPlayer.Server" "$target"/scripts/*.sh
chown -R root:root "$target/wwwroot" "$target/scripts"
install -d -m 700 -o pi-player -g pi-player "$data"
if [[ -f $target/appsettings.Production.json ]]; then cp -a "$target/appsettings.Production.json" "$target/appsettings.Production.json.bak"; fi
python3 - "$target/appsettings.Production.json" "$address" "$data" <<'PY'
import json,socket,sys
path,address,data=sys.argv[1:]; host=socket.gethostname()
try:
    with open(path) as f: config=json.load(f)
except FileNotFoundError: config={}
config['Urls']='http://127.0.0.1:5000;http://[::1]:5000;http://'+address+':5000'
config['AllowedHosts']='localhost;127.0.0.1;[::1];'+host+';'+host+'.local;'+address
p=config.setdefault('PiPlayer',{}); p['DataPath']=data
p.pop('ScreenOrigin',None); p.pop('AllowedOrigins',None)
with open(path,'w') as f: json.dump(config,f,indent=2); f.write('\n')
PY
chmod 644 "$target/appsettings.Production.json"
cat >/etc/systemd/system/pi-player.service <<EOF
[Unit]
Description=PiPlayer server
After=network.target
RequiresMountsFor=$data
[Service]
Type=simple
User=pi-player
Group=pi-player
WorkingDirectory=$target
ExecStart=$target/PiPlayer.Server
Environment=ASPNETCORE_ENVIRONMENT=Production
Restart=always
RestartSec=5
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$data
[Install]
WantedBy=multi-user.target
EOF
install -d /etc/pi-player
cat >/etc/pi-player/firewall.nft <<EOF
table inet pi_player {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "lo" tcp dport 5000 accept
    ip saddr $cidr tcp dport 5000 accept
    tcp dport 5000 drop
  }
}
EOF
cat >/etc/systemd/system/pi-player-firewall.service <<'EOF'
[Unit]
Description=PiPlayer LAN firewall boundary
Before=pi-player.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/usr/sbin/nft delete table inet pi_player
ExecStart=/usr/sbin/nft -f /etc/pi-player/firewall.nft
[Install]
WantedBy=multi-user.target
EOF
install -d /etc/systemd/system/pi-player.service.d
printf '[Unit]\nRequires=pi-player-firewall.service\nAfter=pi-player-firewall.service\n' >/etc/systemd/system/pi-player.service.d/firewall.conf
systemctl daemon-reload
systemctl enable pi-player-firewall.service pi-player.service
systemctl restart pi-player-firewall.service
systemctl start pi-player.service
for attempt in {1..30}; do
  if curl --silent --fail --max-time 2 http://localhost:5000/api/system/ready >/dev/null; then
    echo "Backend ready. Open http://$address:5000/admin. Configure kiosk separately in the verified desktop session."
    echo "PiPlayer has no login: anyone who can reach port 5000 controls the screen. The nftables rule above limits that to $cidr."
    exit 0
  fi
  sleep 2
done
echo 'Backend did not become ready. Inspect journalctl -u pi-player.' >&2
exit 1
