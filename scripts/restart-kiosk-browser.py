#!/usr/bin/env python3
"""Refresh only Chromium process groups owned by a verified PiPlayer launcher."""
import os
import pathlib
import pwd
import signal


def restart_owned_browsers(proc=pathlib.Path('/proc')):
    refreshed = 0
    for item in proc.iterdir():
        if not item.name.isdigit():
            continue
        try:
            uid = item.stat().st_uid
            if uid == 0:
                continue
            account = pwd.getpwuid(uid)
            home = pathlib.Path(account.pw_dir)
            launcher = home / '.local/state/pi-player/launcher.pid'
            if launcher.read_text().strip() != item.name:
                continue
            args = item.joinpath('cmdline').read_bytes().split(b'\0')
            if not any(arg in (b'/opt/pi-player/scripts/start-kiosk.sh', b'/opt/pi-player/current/scripts/start-kiosk.sh') for arg in args):
                continue
            profile = os.fsencode('--user-data-dir=' + str(home / '.local/share/pi-player/chromium-profile'))
            for child in item.joinpath('task', item.name, 'children').read_text().split():
                process = proc / child
                command = process.joinpath('cmdline').read_bytes().split(b'\0')
                if process.stat().st_uid != uid or profile not in command or b'http://localhost:5000/screen' not in command:
                    continue
                pid = int(child)
                if os.getpgid(pid) == pid:
                    os.killpg(pid, signal.SIGTERM)
                    refreshed += 1
        except (OSError, ValueError, KeyError):
            continue
    print(f'PiPlayer kiosk browsers refreshed: {refreshed}. ' + ('Launcher will reopen the screen.' if refreshed else 'No owned kiosk is running; backend update is complete.'))
    return refreshed


if __name__ == '__main__':
    restart_owned_browsers()
