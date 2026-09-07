#!/usr/bin/env bash
set -euo pipefail
output=${1:-hardware-profile.json}
command -v python3 >/dev/null || { echo 'python3 is required to produce diagnostics.' >&2; exit 1; }
python3 - "$output" <<'PY'
import datetime, json, os, platform, shutil, subprocess, sys
def run(args):
    if not shutil.which(args[0]): return {'status':'notRun','reason':'command unavailable'}
    try:
        p=subprocess.run(args,capture_output=True,text=True,timeout=10)
        return {'status':'passed' if p.returncode==0 else 'notRun','output':(p.stdout+p.stderr).strip()[:20000]}
    except (OSError,subprocess.TimeoutExpired) as e: return {'status':'notRun','reason':type(e).__name__}
def read(path):
    try: return open(path).read().replace('\0','').strip()
    except OSError: return 'unknown'
chrome=shutil.which('chromium') or shutil.which('chromium-browser')
profile={'schemaVersion':2,'capturedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'model':read('/proc/device-tree/model'),'os':read('/etc/os-release'),'kernelArchitecture':platform.machine(),
 'userspaceBits':run(['getconf','LONG_BIT']),'dpkgArchitecture':run(['dpkg','--print-architecture']),
 'ram':run(['free','-h']),'storage':run(['df','-h']),
 'sessions':run(['loginctl','list-sessions']),'graphicalProcesses':run(['ps','-C','labwc,wayfire,Xorg,gnome-shell,lightdm','-o','user,pid,comm']),
 'chromiumExecutable':chrome,'chromiumVersion':run([chrome,'--version']) if chrome else {'status':'notRun'},
 'waylandDisplays':run(['wlr-randr']),'x11Displays':run(['xrandr','--current']) if os.environ.get('DISPLAY') else {'status':'notRun','reason':'not in X11 session'},
 'audio':run(['wpctl','status']),'pulseAudio':run(['pactl','info']),
 'ssh':run(['systemctl','is-active','ssh']),'displayManager':run(['systemctl','status','display-manager','--no-pager']),
 'existingApp':run(['systemctl','status','pi-player','--no-pager']),
 'environmentNote':'Run once over SSH and again from the graphical user session. SSH environment does not prove display/audio configuration.',
 'hardwareAcceptance':'notRun'}
with open(sys.argv[1],'w') as f: json.dump(profile,f,ensure_ascii=False,indent=2); f.write('\n')
print('Hardware profile written to '+sys.argv[1])
if profile['userspaceBits'].get('output')!='64' or platform.machine() not in ('aarch64','arm64'):
    print('linux-arm64 artifact cannot be installed on this userspace/kernel combination.',file=sys.stderr); sys.exit(2)
PY
