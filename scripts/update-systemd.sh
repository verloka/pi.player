#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
target='/opt/pi-player'
systemd_dir='/etc/systemd/system'
backup_root='/var/backups/pi-player'
lock_path='/run/lock/pi-player-deploy.lock'
archive=''; expected=''; first_install=false; install_args=()
while (($#)); do
  case "$1" in
    --archive) archive=${2:?}; shift 2;;
    --sha256) expected=${2:?}; shift 2;;
    --install) first_install=true; shift;;
    --lan-address|--lan-cidr|--data-path|--expected-mount) install_args+=("$1" "${2:?}"); shift 2;;
    *) echo "Unknown argument: $1" >&2; exit 1;;
  esac
done
[[ -f $archive && $expected =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Archive and SHA-256 required.' >&2; exit 1; }
for utility in python3 flock systemctl curl tar sha256sum; do command -v "$utility" >/dev/null || { echo "Missing: $utility" >&2; exit 1; }; done
exec 9>"$lock_path"
flock -n 9 || { echo 'Another PiPlayer deployment is in progress.' >&2; exit 1; }
[[ $(getconf LONG_BIT) == 64 && $(uname -m) == aarch64 ]] || { echo 'ARM64 Linux is required.' >&2; exit 1; }
[[ $(sha256sum -- "$archive" | cut -d' ' -f1) == "${expected,,}" ]] || { echo 'Archive checksum mismatch; service untouched.' >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
work=$(mktemp -d /var/tmp/pi-player-deploy.XXXXXXXX)
chmod 755 "$work"
# Never follow links or paths supplied by an archive while extracting as root.
release_name=$(python3 - "$archive" "$work" <<'PY'
import pathlib,re,sys,tarfile
archive,destination=sys.argv[1:]
with tarfile.open(archive,'r:gz') as tf:
    entries=tf.getmembers(); roots=set()
    for entry in entries:
        p=pathlib.PurePosixPath(entry.name)
        if p.is_absolute() or '..' in p.parts or not p.parts or not (entry.isdir() or entry.isfile()):
            raise SystemExit('Unsafe release archive member: '+entry.name)
        roots.add(p.parts[0])
        if any(part in ('data','node_modules','chromium-profile','admin-password.json','appsettings.Production.json','appsettings.Development.json') for part in p.parts):
            raise SystemExit('Private or machine configuration in release archive')
    if len(roots)!=1 or not re.fullmatch(r'pi-player-[A-Za-z0-9.-]+-linux-arm64',next(iter(roots))):
        raise SystemExit('Unexpected release root')
    tf.extractall(destination, members=entries)
    print(next(iter(roots)))
PY
)
release="$work/$release_name"
python3 - "$release" <<'PY'
import pathlib,sys,re
root=pathlib.Path(sys.argv[1]); listed=set()
for line in (root/'SHA256SUMS').read_text(encoding='utf-8-sig').splitlines():
    if not re.fullmatch(r'[a-fA-F0-9]{64}  .+',line): raise SystemExit('Invalid manifest entry')
    p=pathlib.PurePosixPath(line[66:])
    if p.is_absolute() or '..' in p.parts or str(p) in listed: raise SystemExit('Unsafe/duplicate manifest path')
    listed.add(str(p))
actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() and p.name!='SHA256SUMS'}
if listed!=actual: raise SystemExit('Manifest must cover exactly the release files')
if not (root/'PiPlayer.Server').is_file() or not (root/'wwwroot/index.html').is_file(): raise SystemExit('Incomplete release')
PY
(cd -- "$release" && sha256sum --quiet -c SHA256SUMS)
if $first_install; then
  [[ ! -f $systemd_dir/pi-player.service ]] || { echo 'Already installed. Deploy again without -Install.' >&2; exit 1; }
  bash "$release/scripts/install-systemd.sh" "${install_args[@]}"
  exit 0
fi
[[ -f $systemd_dir/pi-player.service && -f $target/appsettings.Production.json ]] || { echo 'PiPlayer is not installed. Use deploy.ps1 -Install with LAN settings.' >&2; exit 1; }
data=$(python3 - "$target/appsettings.Production.json" <<'PY'
import json,pathlib,sys
with open(sys.argv[1]) as f: data=json.load(f)['PiPlayer']['DataPath']
if not pathlib.Path(data).is_absolute(): raise SystemExit('Installed DataPath must be absolute')
print(data)
PY
)
[[ -d $data ]] || { echo 'Installed data directory/mount missing; service untouched.' >&2; exit 1; }
deployment_id="$release_name-$(date +%Y%m%d%H%M%S)-${work##*.}"
next="$target/releases/$deployment_id"
install -d -m 755 "$target/releases" "$backup_root" "$systemd_dir/pi-player.service.d"
chmod 700 "$backup_root"
cp -a -- "$release" "$next"
chown -R root:root "$next"
chmod 755 "$next/PiPlayer.Server" "$next"/scripts/*.sh
ln -s -- "$target/appsettings.Production.json" "$next/appsettings.Production.json"
dropin="$systemd_dir/pi-player.service.d/90-release.conf"
backup="$backup_root/$deployment_id"
install -d -m 700 "$backup"
if [[ -e $target/current && ! -L $target/current ]]; then echo 'current must be a symlink; service untouched.' >&2; exit 1; fi
previous=$(readlink -- "$target/current" || true)
[[ ! -f $dropin ]] || cp -a -- "$dropin" "$backup/90-release.conf"
cp -a -- "$target/appsettings.Production.json" "$backup/appsettings.Production.json"
wait_ready() {
  for attempt in {1..30}; do
    if systemctl is-active --quiet pi-player.service && curl --silent --fail --max-time 2 http://localhost:5000/api/system/ready >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}
switch_link() {
  ln -s -- "$1" "$target/current.$deployment_id"
  mv -Tf -- "$target/current.$deployment_id" "$target/current"
}
rollback() {
  local code=$?
  trap - ERR INT TERM HUP
  set +e
  echo 'Deployment failed. Restoring the previous application version.' >&2
  systemctl stop pi-player.service
  if [[ -n $previous ]]; then switch_link "$previous"; else rm -f -- "$target/current"; fi
  if [[ -f $backup/90-release.conf ]]; then cp -a -- "$backup/90-release.conf" "$dropin"; else rm -f -- "$dropin"; fi
  systemctl daemon-reload
  systemctl reset-failed pi-player.service
  if systemctl start pi-player.service && wait_ready; then echo 'Previous version is running and ready.' >&2
  else echo 'Previous version could not start. Inspect journalctl -u pi-player.service.' >&2; fi
  echo "Data was preserved. Pre-update backup (if completed): $backup/data.tar.gz" >&2
  ((code != 0)) || code=1
  exit "$code"
}
systemctl stop pi-player.service
trap rollback ERR INT TERM HUP
tar -czf "$backup/data.tar.gz" -C "$(dirname -- "$data")" "$(basename -- "$data")"
switch_link "$next"
cat >"$dropin" <<EOF
[Service]
WorkingDirectory=$target/current
ExecStart=
ExecStart=$target/current/PiPlayer.Server
EOF
systemctl daemon-reload
systemctl reset-failed pi-player.service || true
systemctl start pi-player.service
wait_ready
trap - ERR INT TERM HUP
python3 "$script_dir/restart-kiosk-browser.py" || echo 'Backend ready, but kiosk refresh failed; inspect the desktop launcher.' >&2
echo "Deployment ready: $next"
echo "Previous version and data backup preserved: $backup"
