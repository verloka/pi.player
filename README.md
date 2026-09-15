# PiPlayer

A player for a Raspberry Pi screen: local video or YouTube, plus an independent audio channel. Control it from a browser on your computer or phone. Closing the control panel does not stop playback.

## 1. Build, install and update over SSH

### Requirements

- **Windows:** .NET SDK **10.0.400**, Node **22.22.2**, npm **10.9.7**, and `ssh`, `scp`, `tar` on PATH. Run all PowerShell commands below from the repository root.
- **Raspberry Pi:** Raspberry Pi OS Desktop **64-bit**, SSH, Chromium, an active **labwc** desktop with **LightDM**, `curl`, `python3`, `util-linux`, `nftables`, and the system libraries required by .NET 10. The release includes the .NET runtime; Node is not needed on the Pi. OS Lite and X11 are not supported by the installer.

The commands use SSH user `verloka` and Pi IP `192.168.68.122`. They assume LAN subnet `192.168.68.0/24` (mask `255.255.255.0`); confirm your network mask and adjust `-LanCidr` if needed. Keep the Pi's IP fixed, for example with a router DHCP reservation.

### Build an archive without deploying

On Windows, in PowerShell:

```powershell
./scripts/publish-linux-arm64.ps1
```

This installs build dependencies, runs frontend and backend tests, builds the frontend and packages the server for Linux ARM64. Output:

```text
artifacts/pi-player-<version>-linux-arm64.tar.gz
artifacts/pi-player-<version>-linux-arm64.tar.gz.sha256
publish/pi-player-<version>-linux-arm64/
```

Each run generates a unique version, so you can repeat the command without removing previous builds. Keep the archive and its `.sha256` file together. To name a release explicitly, use `-Version 2.1.0-local.2`; an existing name is rejected before the build starts.

Copy the archive path printed after `Release ready:` into this variable for the commands below:

```powershell
$archive = 'Y:\verloka\verloka.pi.player\artifacts\pi-player-<version>-linux-arm64.tar.gz'
```

### Upload and install for the first time

On Windows, deploy the archive you built:

```powershell
./scripts/deploy.ps1 -PiHost 192.168.68.122 -SshUser verloka -Archive $archive -Install -LanAddress 192.168.68.122 -LanCidr 192.168.68.0/24
```

The script uploads over SSH, verifies checksums, installs the service and waits for it to become ready. Enter the SSH and `sudo` passwords if prompted. Wait for `Deployment complete`.

Then connect to the Pi and configure the screen browser once:

```bash
ssh verloka@192.168.68.122
sudo bash /opt/pi-player/scripts/configure-kiosk.sh verloka
sudo reboot
```

The user `verloka` must be running the **active labwc desktop**. If you get `No active labwc session`, enable desktop login through `sudo raspi-config`, reboot and retry the kiosk setup.

After reboot, open **http://192.168.68.122:5000/admin** from another device on the LAN. The player opens automatically on the Pi's display.

The kiosk starts without on-screen password prompts. Its dedicated Chromium profile uses `--password-store=basic` to avoid desktop keyring dialogs; do not save passwords in this profile. SSH and `sudo` prompts are handled on your computer during maintenance.

Installation and updates also apply Chromium kiosk policies: no translation offers, camera/microphone/screen capture, notifications, location requests, popup windows, password saving or autofill offers. These policies apply to Chromium on this Pi. The launcher disables PipeWire camera discovery and browser tips, and suppresses session-restore prompts after a power loss. Audio and video playback remain enabled.

There is no application password: access is restricted to the subnet supplied at installation. Do not expose port 5000 to the internet.

### Upload and apply an update

To deploy an archive without rebuilding it:

```powershell
./scripts/deploy.ps1 -PiHost 192.168.68.122 -SshUser verloka -Archive $archive
```

Set `$archive` to the path of your new build. Do not pass `-Install` again. The script backs up the data, updates the application, waits for readiness and requests a browser restart in the running kiosk. Settings and media are preserved; playback is briefly interrupted. If the new service fails to start, the script attempts to restore the previous application version.

If the output says **Kiosk launcher updated**, run `sudo reboot` over SSH after deployment. This applies new browser launch settings, including the keyring fix. Use a freshly built archive to include source changes.

**To build and deploy in one command**, omit `-Archive`. No separate build is needed:

```powershell
# First installation: build, upload and install
./scripts/deploy.ps1 -PiHost 192.168.68.122 -SshUser verloka -Install -LanAddress 192.168.68.122 -LanCidr 192.168.68.0/24

# Existing installation: build, upload and update
./scripts/deploy.ps1 -PiHost 192.168.68.122 -SshUser verloka
```

Each automatic build uses a unique release name. The first installation still needs the kiosk setup above.

To **only copy** an archive to the Pi without installing or restarting anything:

```powershell
scp $archive "${archive}.sha256" verloka@192.168.68.122:~/
```

Default data: `/opt/pi-player/data`. Machine settings: `/opt/pi-player/appsettings.Production.json`. Update backups: `/var/backups/pi-player`. Updates need enough free space for a full media library backup. For an external disk, add `-DataPath /mnt/media/pi-player-data -ExpectedMount /mnt/media` during the first installation; the disk must already be mounted.

## 2. Use the player

Open **http://192.168.68.122:5000/admin**. The language switch is in the top bar.

The panel opens on the **Dashboard**, laid out for a phone. It has a large pause/play button for each channel, **Pause everything**, video and audio presets that start with one tap (the one on screen is marked), the Pi's own output volume (−/+, slider, mute) and the processor temperature. The other tabs hold the detailed settings.

The backend sets the device volume by running `wpctl set-volume @DEFAULT_AUDIO_SINK@ N%` itself and reads the temperature with `vcgencmd measure_temp`. wpctl reaches the desktop session's PipeWire only as that session's user, so `configure-kiosk.sh` runs the service as the desktop user; `NoNewPrivileges` stays on, so that user's sudo rights never apply to the service. On a Pi configured before this change, run it once more after deploying: `sudo bash /opt/pi-player/current/scripts/configure-kiosk.sh verloka`.

1. **Libraries:** upload video (MP4, WebM) or audio (MP3, WAV, OGG, M4A, FLAC). Playback depends on Chromium's codec support.
2. **Studio → Visual:** select a library video or paste a YouTube URL, then click **Select and play**. **Load paused** prepares it without starting playback.
3. **Position and size:** drag the frame on the schematic, resize with the bottom-right grip, and rotate with the top grip. Hold Shift to rotate in 15° steps. The **Video** sliders move the frame, scale it and turn it about its own centre, and **Reset** puts it back in the middle, upright and at 100%. After a click on the schematic, the arrow keys move the frame by 1 px, or 10 px with Shift. For exact values, enter coordinates, dimensions and angle, then click **Apply geometry**.
4. **Studio → Audio:** select a library track or a direct HTTP(S) audio URL. A music service page is not an audio URL. Each channel has its own volume, mute and pause; mute Visual if you only want the separate audio track.
5. **Presets:** save video and audio settings for reuse. Presets start playback from zero.
6. **Startup:** choose startup presets (`defaults`) and playback flags, or restore the last saved state (`resumeLast`). Saving affects the next backend startup; it does not change the current scene.

**Stop** keeps the selected source. **Clear screen** removes the video; **Clear source** releases the audio source. Before deleting a library file, remove it from the current scene and any presets.

The panel schematic shows the picture's position. Playback happens on `/screen`, opened by the Pi kiosk; you do not need to open another screen on your computer for normal use.

The screen draws the background first, then a circle, then the video. The **Circle** sliders set its diameter and its offset from the centre of the screen, and **Reset** returns it to the centre. Its colour and visibility sit under the sliders. The circle is part of the current scene and is saved with visual presets.

### Experimental YouTube audio

In **Studio → Audio**, choose **YouTube audio (experimental)**, paste a video URL and select **Select and play** or **Load paused**. Watch, short-link and Shorts URLs use the same validation as Visual. A playlist parameter is ignored; playlist-only URLs are rejected. Audio has its own play/pause, stop, restart, seek, volume, mute and loop, and can be saved in an audio preset or restored at startup.

This opt-in source runs a separate 320×200 YouTube iframe outside the visible screen. It does not replace or reposition Visual. It still plays video and may consume CPU, GPU and bandwidth; it is not an audio-only stream. Closing the admin panel leaves playback running on the kiosk. Clearing or replacing the audio source destroys its player. The page visibility and screen-session rules still apply.

Hidden playback conflicts with the [YouTube API developer policies](https://developers.google.com/youtube/terms/developer-policies); this is an explicitly experimental mode, not a supported YouTube audio API. Embedding restrictions, ads, autoplay and provider changes can prevent playback. Real YouTube playback and sound on the Raspberry Pi require device acceptance.

## 3. Debug

### On the Pi over SSH

Start with the panel's **Diagnostics** tab for screen status and channel errors. Over SSH:

```bash
ssh verloka@192.168.68.122

# Service status and API readiness
systemctl status pi-player.service --no-pager
curl -f http://localhost:5000/api/system/ready

# Player state and channel errors
curl -fsS http://localhost:5000/api/system/kiosk-status | python3 -m json.tool

# Recent backend and kiosk logs
sudo journalctl -u pi-player.service -n 100 --no-pager
sudo journalctl -t pi-player-kiosk -n 100 --no-pager

# Follow backend logs; Ctrl+C to exit
sudo journalctl -u pi-player.service -f
```

| Problem | Check |
| --- | --- |
| Panel will not open | Pi IP, port 5000 and access from the configured LAN subnet. If local `ready` also fails, read the service logs. |
| Panel works, screen is blank | Visual source and playback state, then `kiosk-status` and kiosk logs. Use `pgrep -a -u verloka labwc` to check the desktop. |
| Translation or permission dialogs appear | Deploy a fresh build and reboot. Check `/etc/chromium/policies/managed/pi-player-kiosk.json` and the running Chromium arguments for `--deny-permission-prompts` and `WebRtcPipeWireCamera`. |
| Picture plays without sound | Channel volume and mute, then `XDG_RUNTIME_DIR=/run/user/$(id -u) wpctl status` as the desktop user. `playing` does not confirm sound from the speakers. |
| `soundWaitingForGesture: true` | The browser is blocking sound. The player retries automatically; check kiosk logs. |
| A file or URL will not play | Channel error, file codec and URL access from the Pi. YouTube videos must allow embedding. |
| Saving or updating fails | Free space (`df -h`), external disk mount, service logs or the output from `deploy.ps1`. |

Restart the backend:

```bash
sudo systemctl restart pi-player.service
curl -f http://localhost:5000/api/system/ready
```

To restart the whole kiosk and desktop, use `sudo reboot`.

If an older installation shows **Choose password for new keyring**, upload the corrected launcher from Windows; no application rebuild is needed:

```powershell
scp ./scripts/start-kiosk.sh verloka@192.168.68.122:~/pi-player-start-kiosk.sh
ssh verloka@192.168.68.122
```

Then run in that SSH session:

```bash
sudo cp -a /opt/pi-player/scripts/start-kiosk.sh /opt/pi-player/scripts/start-kiosk.sh.before-keyring-fix
sudo install -m 755 ~/pi-player-start-kiosk.sh /opt/pi-player/scripts/start-kiosk.sh
sudo reboot
```

This updates the launcher used by labwc autostart. The reboot closes the existing dialog and starts Chromium with the new flag. No local keyboard or keyring deletion is needed.

### Locally on Windows

From the repository root:

```powershell
./scripts/start-dev.ps1
```

This prepares dependencies and starts the backend and frontend through Aspire. Open both **http://localhost:4200/admin** for controls and **http://localhost:4200/screen** for playback. Logs are in the Aspire dashboard at **http://localhost:15888**; use the token link printed at startup if prompted. Development data is stored in `artifacts/dev-data`.

In VS Code, select **PiPlayer: Aspire (backend + frontend)** and press **F5** to debug .NET. Then launch **PiPlayer: Windows admin (Edge)** or **PiPlayer: Windows screen (Edge)** for TypeScript breakpoints. The screen configuration enables autoplay with sound.

Run checks from the repository root:

```powershell
dotnet test PiPlayer.sln
npm --prefix src/PiPlayer.Web ci
npm --prefix src/PiPlayer.Web test
npm --prefix src/PiPlayer.Web run build
```

Browser E2E tests modify the media library. Use separate test data and follow the [E2E instructions](docs/manual-test-results.md).

Technical reports: [implementation status](IMPLEMENTATION-STATUS.md), [release checks](docs/release-validation.md), [compatibility](docs/compatibility-report.md), [hardware profile](docs/hardware-profile.md). Installation and playback on a real Raspberry Pi have not yet been verified.
