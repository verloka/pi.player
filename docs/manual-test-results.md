# Test results and hardware acceptance

Automated results: `artifacts/test-results/backend.trx` and `artifacts/test-results/browser.json`; UI screenshots: `artifacts/admin-desktop.png` and `artifacts/admin-mobile.png`. The final test counts are recorded in `IMPLEMENTATION-STATUS.md` after the release run.

## Reproducing the browser E2E run

Use separate test data only. ffmpeg and Playwright Chromium are required.

```powershell
# Project root
New-Item -ItemType Directory -Force artifacts/fixtures | Out-Null
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 20 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart artifacts/fixtures/video.mp4
ffmpeg -f lavfi -i sine=frequency=220:sample_rate=44100 -t 30 artifacts/fixtures/audio.wav
$env:PiPlayer__DataPath = Join-Path (Get-Location) 'artifacts/e2e-data'
./scripts/prepare-dev.ps1                 # builds Angular into wwwroot: E2E runs against port 5000
dotnet run --project src/PiPlayer.Server --no-launch-profile
# In another terminal, from src/PiPlayer.Web:
npx playwright install chromium
npm run test:e2e
```

No password is needed: the application has no authentication. The tests leave the ordinary DataPath alone as long as the server runs with the environment variable above.

The specs address the panel in English. The interface picks its language from the browser, and Playwright reports `en-US`, so the English strings are the ones on screen during a test run.

Verified on Windows Chromium: entry without a login, production Angular delivered with its styles under CSP, uploading two files, real playback, the media element surviving a transform, independent sound and pause, seek, saving presets and startup settings, reloading the panel, reloading the screen and restoring its checkpoint, a second screen with no media, desktop and mobile layout, no controls on the video, sound recovering with no gesture through the silent self-check, and sound recovering on a click when autoplay is refused. The YouTube SDK double is not live provider acceptance.

The browser's refusal of audible autoplay is reproduced by replacing `HTMLMediaElement.prototype.play`: Chromium under automation always permits sound, and `--autoplay-policy=user-gesture-required` has no effect inside Playwright. Everything that happens after the refusal is the real application.

## Raspberry Pi acceptance

Kiosk regression checks (from the repository root; Bash, Python and the E2E media fixtures above are required):

```text
bash tests/scripts/kiosk-policy.test.sh
python tests/scripts/test_kiosk_profile.py
node tests/scripts/kiosk-browser.test.cjs
```

Verified locally: policy installation and reapplication, rollback with an existing or absent policy file, preservation of unrelated policies and profile data, rejected camera/microphone access, disabled notifications, denied location requests, and advancing video and unmuted audio with the launcher's arguments in Windows Chromium 145.0.7632.6. The browser check uses fake input devices without granting permissions. Windows cannot verify Linux policy loading or the native PipeWire camera dialog; both require a reboot check on the Pi.

Every row below is **notRun**. Replace a status with `passed`, `failed`, `blockedByEnvironment` or `experimental` only after a real check, quoting the hardware profile, the media URL, codec, bitrate and frame rate, the steps taken and the result.

| ID | Check | Status |
|---|---|---|
| HW-01 | Cold boot with no default presets: background and silence | notRun |
| HW-02 | Visual default only | notRun |
| HW-03 | Audio default only | notRun |
| HW-04 | Both defaults | notRun |
| HW-05 | Local x=100 / y=20 / rotation=33 | notRun |
| HW-06 | Local video sound plus independent Audio | notRun |
| HW-07 | YouTube plus local Audio | notRun |
| HW-08 | Local Visual plus remote live Audio | notRun |
| HW-09 | Transform during playback without a reload | notRun |
| HW-10 | Reloading the panel does not disturb playback | notRun |
| HW-11 | Closing the panel does not disturb playback | notRun |
| HW-12 | SignalR drop and return without losing the position | notRun |
| HW-13 | Reloading the screen restores the checkpoint | notRun |
| HW-14 | Killing Chromium and the launcher restoring it | notRun |
| HW-15 | Renderer without a heartbeat: watchdog fires, buffering does not restart it | notRun |
| HW-16 | Backend restart with defaults | notRun |
| HW-17 | Backend restart with resumeLast | notRun |
| HW-18 | No internet: local channels and the panel keep working | notRun |
| HW-19 | YouTube embedding forbidden: the error shows and Audio continues | notRun |
| HW-20 | Remote audio network failure: bounded retry and a reported error | notRun |
| HW-21 | Deleting an asset in use: 409 with references | notRun |
| HW-22 | Corrupt runtime JSON: backup, fallback and a warning | notRun |
| HW-23 | Disk full: the old JSON survives, the status becomes failed | notRun |
| HW-24 | A second screen starts no additional sound | notRun |
| HW-25 | HDMI reconnect, viewport and scaling | notRun |
| HW-26 | Two hours of playback: memory, temperature, frames, write rate | notRun |
| HW-27 | Cold boot with sound: local video, local audio and YouTube separately | notRun |
| HW-28 | YouTube rotation on the device plus a policy review | notRun |
| HW-29 | Seek and loop on a large local file, Range and memory | notRun |
| HW-30 | An OS-level mute is not masked by a playing status | notRun |
| HW-31 | Alignment ring calibrated against the measured panel width, checked with a ruler on the panel | notRun |
| HW-32 | Captions stay off on the device across a whole playlist | notRun |
| HW-33 | Cold boot and watchdog restart without keyring, camera portal, translation, permission or restore-tabs dialogs; video and audio play without local input | notRun |

For HW-27 record local muted video, local audible video, local audio, YouTube muted, YouTube audible, and YouTube muted with local Audio separately. No result counts if it needed a local click on the Pi: the device has no input devices, so the picture must arrive on its own.
