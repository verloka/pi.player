# Hardware profile

Status: **notRun**. No Raspberry Pi is attached to the development environment.

| Fact | Result |
|---|---|
| Model / RAM | unknown |
| OS / userspace / kernel architecture | unknown |
| Desktop / compositor / display manager | unknown |
| Chromium executable / package / version | unknown |
| HDMI mode / scaling / browser zoom / DPR | unknown |
| Audio server / sink / physical output | unknown |
| Mount / filesystem / free space | unknown |
| SSH / hostname / LAN CIDR | unknown |
| Panel width in millimetres (ring calibration) | unknown |

Save the output of `bash scripts/preflight.sh hardware-profile.json` before installing, then complete it with the facts only a graphical session can report. The reference target is Raspberry Pi OS Desktop, ARM64, labwc, LightDM. That is a constraint of the installation script, not an established fact about the user's device.

Development environment already verified: Windows 11 x64, .NET SDK 10.0.400 with runtime 10.0.11, Node 22.22.2 with npm 10.9.7, Playwright Chromium 145.0.7632.6. The browser tests used a 1280×720 viewport with a synthetic H.264/AAC MP4 at 640×360 and 24 fps plus a PCM WAV. Physical sound was never verified in a headless test.
