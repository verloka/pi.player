#!/usr/bin/env bash
# Sourced by installation and update scripts; only PiPlayer's policy file is managed.
kiosk_policy_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/chromium-kiosk-policy.json"
kiosk_policy_dirs=(/etc/chromium/policies/managed /etc/chromium-browser/policies/managed)

backup_kiosk_policy() {
  local backup_dir=$1 index policy
  install -d -m 700 "$backup_dir"
  for index in "${!kiosk_policy_dirs[@]}"; do
    policy="${kiosk_policy_dirs[$index]}/pi-player-kiosk.json"
    if [[ -f $policy ]]; then cp -a -- "$policy" "$backup_dir/$index.json"; fi
  done
}

replace_kiosk_policy() {
  local source=$1 directory=$2 temporary
  install -d -m 755 "$directory"
  temporary=$(mktemp "$directory/.pi-player-kiosk.XXXXXXXX")
  install -m 644 -- "$source" "$temporary"
  mv -f -- "$temporary" "$directory/pi-player-kiosk.json"
}

apply_kiosk_policy() {
  local directory
  python3 -m json.tool "$kiosk_policy_source" >/dev/null
  for directory in "${kiosk_policy_dirs[@]}"; do
    replace_kiosk_policy "$kiosk_policy_source" "$directory"
  done
}

restore_kiosk_policy() {
  local backup_dir=$1 index directory
  for index in "${!kiosk_policy_dirs[@]}"; do
    directory=${kiosk_policy_dirs[$index]}
    if [[ -f $backup_dir/$index.json ]]; then
      replace_kiosk_policy "$backup_dir/$index.json" "$directory"
    else
      rm -f -- "$directory/pi-player-kiosk.json"
    fi
  done
}
