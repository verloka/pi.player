#!/usr/bin/env bash
# Run from the repository root: bash tests/scripts/kiosk-policy.test.sh
set -euo pipefail
# Git Bash cannot apply Unix-only 0700 directory permissions on Windows.
# Keep exercising the real file installation/replacement; Linux tests use install unchanged.
if [[ $OSTYPE == msys || $OSTYPE == cygwin ]]; then
  install() {
    if [[ ${1:-} == -d && ${2:-} == -m && ${3:-} == 700 ]]; then
      shift 3
      mkdir -p -- "$@"
    else
      command install "$@"
    fi
  }
fi
source scripts/kiosk-browser-policy.sh
mkdir -p artifacts/test-results
work=$(mktemp -d artifacts/test-results/kiosk-policy.XXXXXXXX)
# Keep every filesystem operation inside this isolated test directory.
kiosk_policy_dirs=("$work/chromium/managed" "$work/chromium-browser/managed")
mkdir -p "${kiosk_policy_dirs[0]}"
printf '{"TranslateEnabled":true}\n' >"${kiosk_policy_dirs[0]}/pi-player-kiosk.json"
printf '{"HomepageLocation":"https://example.test"}\n' >"${kiosk_policy_dirs[0]}/unrelated.json"
cp "${kiosk_policy_dirs[0]}/unrelated.json" "$work/unrelated.before"
backup_kiosk_policy "$work/backup"
apply_kiosk_policy
for directory in "${kiosk_policy_dirs[@]}"; do
  cmp "$kiosk_policy_source" "$directory/pi-player-kiosk.json"
done
# Reapplication must preserve other administrators' policies and the backup.
apply_kiosk_policy
cmp "$work/unrelated.before" "${kiosk_policy_dirs[0]}/unrelated.json"
restore_kiosk_policy "$work/backup"
cmp "$work/backup/0.json" "${kiosk_policy_dirs[0]}/pi-player-kiosk.json"
[[ ! -e ${kiosk_policy_dirs[1]}/pi-player-kiosk.json ]]
cmp "$work/unrelated.before" "${kiosk_policy_dirs[0]}/unrelated.json"
echo 'PASS: policy install, repeat install, rollback of existing/absent policies, unrelated policy preservation.'
