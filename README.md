# PiPlayer

A control panel for a single Raspberry Pi screen: one **Visual** channel (a local video or YouTube) and an independent **Audio** channel (a local file or a direct HTTP(S) link). `/admin` drives the scene, `/screen` plays it. Closing the panel does not stop the screen.

Implemented from `pi-player-detailed-plan-v2.md`. Progress and the limits of what has been verified are in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md). Hardware acceptance on a Raspberry Pi has not been done yet.

The interface is available in **English and Russian**. It follows the browser language on the first visit and offers a switch in the top bar; the choice is remembered in the browser. Everything else in the repository, including code comments and documentation, is English. The one deliberate exception is the original specification `pi-player-detailed-plan-v2.md`, which is the author's own Russian document.

## Running on Windows for development

You need .NET SDK **10.0.400**, Node **22.22.2** and npm **10.9.7**. Angular **21.2.22**, CLI and build **21.2.23**, TypeScript **5.9.3** and SignalR **10.0.11** are pinned in the lockfiles. The combination follows the [official Angular version table](https://angular.dev/reference/versions).

`.npmrc` pins `legacy-peer-deps=true` for npm 10: its resolver crashed on a cycle of optional Vitest 4.1 peers. The required Angular, TypeScript, Vite and Vitest versions are stated explicitly, and the build, the tests and `npm audit` were all checked. Vitest is pinned to the fixed 4.1.11 and Vite to 7.3.6.

Debugging runs through **.NET Aspire**: one launch starts the backend and the Angular dev server together and shows their logs, traces and links to both pages on its dashboard.

```powershell
./scripts/start-dev.ps1
```

The script runs `npm ci` when the lockfile changes, builds the AppHost and starts the orchestration. There is no password: the application opens straight away.

| Address | What it is |
| --- | --- |
| `http://localhost:4200/admin` | the control panel, with Angular hot reload |
| `http://localhost:4200/screen` | the player, with Angular hot reload |
| `http://localhost:5000` | the backend API and SignalR |
| `http://localhost:15888` | the Aspire dashboard |

The Angular dev server proxies `/api`, `/hubs` and `/media` to port 5000, so both pages work on port 4200. Port 5000 serves the same pages out of `wwwroot`, which is the production path; for that run `./scripts/prepare-dev.ps1` without `-SkipFrontend`.

In VS Code, **F5** starts the "PiPlayer: Aspire (backend + frontend)" configuration with the .NET debugger. Separate configurations open `/screen` and `/admin` in Edge with TypeScript debugging; the screen configuration passes `--autoplay-policy=no-user-gesture-required`, as the Pi does.

`DataPath` defaults to `artifacts/dev-data` in the repository root and is overridden by the `PiPlayer__DataPath` variable or the `-DataPath` parameter. A relative path is always resolved from `AppContext.BaseDirectory`.

Production on a Raspberry Pi runs **without** Aspire and without Node: the backend serves the compiled Angular bundle itself.

## Using it

1. On the Libraries tab, upload an MP4 or WebM and an audio file. Progress and cancellation are available. The application generates the file names on disk.
2. On Studio, choose a Visual source and press "Load paused" or "Select and play".
3. Enter X=100, Y=20, width=800, height=450, angle=33 and apply the geometry. Coordinates are CSS pixels and address the top-left corner of the **unrotated** frame; rotation and scale happen around the centre of the block, so an angle never shifts the picture sideways.
4. With the mouse on the schematic: the outline drags, the round grip at the bottom right resizes symmetrically about the centre, and the round grip on a stem above rotates. Hold Shift while rotating to step by 15°. With the aspect lock on, width and height stay tied.
5. A dashed ring 225 mm across is drawn at the centre of the screen as a physical reference for lining the picture up with something real. It belongs to the screen, not to the video: moving, scaling or rotating the block never moves it, and it keeps its real-world size throughout. It never intercepts the mouse either, so pressing exactly on the stroke reaches whatever is underneath.
6. When the block leaves the screen, the schematic zooms out so the whole block and its grips stay in view. The screen edges are drawn as dashes and the zoom factor appears in the caption below. While the block fits, the schematic shows exactly the screen.
7. Turn the Audio channel on separately. Mute, volume, pause and stop are independent per channel. Stop keeps the source; "Clear screen" removes the Visual and "Clear source" releases the chosen Audio.
8. Save Visual and Audio setups on the Presets tab. What is stored is the configuration with an initial position of 0, not the second you are watching.
9. On the Startup tab choose `defaults` with independent presets and flags, or `resumeLast` for the last saved state. Saving these settings does not change the current scene.

The panel's schematic is not a second media player and does not stream frames from the Pi. Before the first connection the screen has an **unknown size**, and the provisional schematic is never stored as its viewport. Preset coordinates survive a resolution change; "Fit" is an explicit adaptation of the current geometry and accounts for the rotated bounding box.

### Calibrating the ring

Millimetres and CSS pixels are related only through the density of the display, and a browser does not know the physical size of the panel. The CSS convention therefore applies by default: 96 pixels per inch. On a panel with a different density the ring is the wrong size, and the caption under the schematic says so with "uncalibrated, 96 dpi".

The ring is centred on the screen, so calibration is what makes it land where a real 225 mm circle would. To get a true 225 mm, measure the visible width of the screen with a ruler and record it in `appsettings.Production.json`:

```json
{ "PiPlayer": { "ScreenWidthMillimetres": 340.5, "GuideCircleDiameterMillimetres": 225 } }
```

The conversion then goes through the real width and the 96 dpi note disappears. `GuideCircleDiameterMillimetres: 0` removes the ring entirely.

`accepted` means the backend took the command. The real `playing`, `blocked` and `error` statuses, the position and the volume all come from the player. Even `playing` does not confirm that anything is audible: check the system sink, the OS mute and the speakers.

## Sources and limits

- Local video: `.mp4`, `.webm`; audio: `.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`. The extension and the container signature are checked; decoding depends on the codec and on Chromium. There is no automatic transcoding. The optional `ffprobe` step is not wired in, so unknown metadata stays `null`.
- YouTube goes exclusively through the [official IFrame API](https://developers.google.com/youtube/iframe_api_reference) with video or playlist URLs. The API loads on demand and its absence does not block the local channels. There is no downloading, no audio extraction and no hidden background YouTube.
- The minimum frame size comes from [YouTube's requirements](https://developers.google.com/youtube/terms/required-minimum-functionality) and is checked again on the screen itself, independently of the backend.
- Arbitrary rotation works for both sources, local video and YouTube alike (`EnableExperimentalYouTubeRotation=true` by default). Rotation and scale are around the centre of the block.
- Rotating YouTube is still a modification of somebody else's player: check the [service policies](https://developers.google.com/youtube/terms/developer-policies), and measure the load on the device, because CSS compatibility proves neither policy compliance nor that a Pi can composite the rotation. The same key in `appsettings.Production.json` turns it off.
- YouTube captions are always off. `cc_load_policy=0` alone is not enough: the provider reloads the captions module when playback starts and on every new clip, so the screen unloads it on each state change and on a 2-second guard timer.
- A frame may hang off the edge of the screen, for either source. For YouTube the requirements on the frame itself remain: opacity = 1, `contain`, and at least 200×200 CSS pixels; otherwise the command is refused with `youtubeGeometryInvalid`.
- Remote Audio is a direct link with no extra Authorization headers, no DRM and no media extraction from a page. HLS, DASH, M3U and PLS are not supported. `live` disables seek and loop; `auto` uses the observed properties of the HTML media element. A URL without an extension is accepted. Whether an arbitrary HTML page is recognised cannot be guaranteed before the browser reaches the source.
- Remote Audio is fetched by **Chromium**, not by the backend, so the address may be one that is reachable from the Pi's network. `RemoteAudioAllowedHosts` restricts the input by exact host name; it is not network isolation against DNS or redirects. Query parameters stay inside the private JSON presets and never appear in diagnostics.
- YouTube restrictions on private, region-locked, consent-gated, embedding-disabled or account-bound videos are not bypassed. Error 153 specifically indicates a Referer problem. Live YouTube, real remote radio stations and hardware codecs need compatible test sources and separate acceptance.

## Publishing for ARM64

```powershell
./scripts/publish-linux-arm64.ps1
```

The script runs `npm ci`, the frontend tests and build, a locked NuGet restore, the backend tests and a self-contained `linux-arm64` publish without trimming. It verifies the frontend index and the absence of data or credentials, adds the documentation and produces:

```text
artifacts/pi-player-2.1.0-linux-arm64.tar.gz
artifacts/pi-player-2.1.0-linux-arm64.tar.gz.sha256
publish/pi-player-2.1.0-linux-arm64/SHA256SUMS
```

An existing release directory is never overwritten: move the previous one aside or pass `-Version`. Self-contained includes the .NET runtime but still needs a compatible OS and system libraries; [deployment on ARM](https://learn.microsoft.com/en-us/dotnet/iot/deployment) does not replace checking the environment.

## Installing on a Raspberry Pi over SSH

You need working SSH, **64-bit Raspberry Pi OS Desktop**, an active labwc session for an ordinary user, Chromium, curl, python3, util-linux (`flock`, `setsid`), nftables and compatible .NET dependencies. No model, amount of RAM or resolution is assumed. On X11, another compositor or OS Lite the installation adapter refuses to change the kiosk; prepare a confirmed Desktop with labwc or write a separate adapter.

1. Transfer and verify the archive:

   ```powershell
   ./scripts/deploy.ps1 -PiHost raspberrypi.local -SshUser pi -Archive ./artifacts/pi-player-2.1.0-linux-arm64.tar.gz
   ```

   The script only creates a unique staging directory, copies the archive, checks the SHA-256 and unpacks it. Replace the user name and host name with your own.

2. Over SSH, change into the release directory it printed, verify the internal manifest and save a preflight report:

   ```bash
   sha256sum -c SHA256SUMS
   bash scripts/preflight.sh hardware-profile.json
   ```

   Preflight records the userspace architecture, the model, memory, OS, compositor, Chromium, network, storage and whatever display and audio facts are available. Some of them are `notRun` over SSH; repeat the diagnostics as the graphical user. Do not continue with an ARM64 archive on a 32-bit userspace.

3. Install the backend with your real LAN IPv4 address and subnet:

   ```bash
   sudo bash scripts/install-systemd.sh --lan-address 192.168.1.50 --lan-cidr 192.168.1.0/24
   ```

   The installer creates the `pi-player` user, `/opt/pi-player`, a private data directory, the Urls and AllowedHosts configuration, the systemd unit and a separate nftables table for TCP 5000. It asks for no password: the application has no authentication, and that firewall rule is what bounds access. It does not clear the whole firewall and does not touch the SSH rules. If your network is already governed by another firewall, check that the rules are compatible. The script waits for readiness before it exits successfully.

   For data on external storage you must name a mount it can verify:

   ```bash
   sudo bash scripts/install-systemd.sh --lan-address 192.168.1.50 --lan-cidr 192.168.1.0/24 --data-path /mnt/media/pi-player-data --expected-mount /mnt/media
   ```

   The mount has to exist already. The script refuses to create an empty library on the SD card in place of a missing external disk; systemd receives `RequiresMountsFor` and the matching `ReadWritePaths`.

4. Configure the kiosk for the user of the **active labwc session**:

   ```bash
   sudo bash /opt/pi-player/scripts/configure-kiosk.sh pi
   ```

   An existing `~/.config/labwc/autostart` is preserved and extended without duplicates. LightDM autologin and blanking are configured through raspi-config. The [official Raspberry Pi kiosk guide](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/) describes launching a browser from a graphical session.

   `wpctl status` as the graphical user shows the system audio sink. If needed, pass its current numeric ID as the second argument to `configure-kiosk.sh`. Check that the choice survives a reboot; a web application cannot decide physical audibility.

5. Check `/admin`, readiness and the journal, reboot over SSH and fill in the [hardware acceptance](docs/manual-test-results.md) table. The launcher starts automatically once the desktop session begins.

   ```bash
   systemctl status pi-player.service
   journalctl -u pi-player.service -n 100 --no-pager
   journalctl -t pi-player-kiosk -n 100 --no-pager
   curl -f http://localhost:5000/api/system/ready
   sudo reboot
   ```

Chromium gets its own profile at `~/.local/share/pi-player/chromium-profile`, a flock and its own process group. The launcher waits for readiness, restores a browser that exited and checks the heartbeat after a 60-second grace period. Three consecutive checks without a heartbeat while the backend is healthy restart only its own group, at most three times in 10 minutes, followed by a 5-minute cooldown. Buffering is never a reason to restart. Logs go to journald; configure its overall limit for the Pi's storage.

`--autoplay-policy=no-user-gesture-required` is used, as [documented by Chrome](https://developer.chrome.com/blog/autoplay/). Its behaviour on the hardware, the Chromium package wrapper and an audible cold boot all need separate verification. Neither `--no-sandbox` nor `--disable-web-security` is used.

## Autoplay without input devices

The Raspberry Pi has no keyboard and no mouse and is reachable only over SSH, so **no scenario requires a click**. The defence is layered, and each layer only comes into play if the previous one did not work.

1. **The kiosk flag.** The launcher starts Chromium with `--autoplay-policy=no-user-gesture-required`, [documented by Chrome](https://developer.chrome.com/blog/autoplay/). With it, sound starts immediately and nothing below is needed.
2. **The picture never stops.** If the browser still refuses an audible start, the player continues **without sound** instead of stopping. The screen never goes dark.
3. **A silent self-check.** Every 5 seconds the page plays a one-second silent WAV from `/media/silence.wav`, unmuted and at full volume. The autoplay policy looks at the element rather than at the samples, so the probe is a faithful test that makes no sound. As soon as the browser lets it through, the screen restores the requested volume without restarting playback.
4. **Retrying a refusal.** If even a muted start is forbidden (`autoplayBlocked`), the attempt repeats every 5 seconds for as long as the intent is to play.
5. **Restarting the browser.** If the screen reports `blocked` for 30 seconds, the launcher restarts its own Chromium process group, at most three times in 10 minutes, then pauses for 5 minutes. Content errors such as an unsupported codec deliberately do **not** trigger a restart, because a browser cannot fix them.
6. **A click.** It remains for an ordinary browser on Windows and is never required on the Pi.

While sound is waiting, a compact banner appears in the corner of the screen. It is deliberately **not** a full-screen overlay: on a device with no input such a window could never be dismissed and would cover the picture. The banner disappears by itself once sound is on.

### What to look at over SSH

```bash
curl -s http://localhost:5000/api/system/kiosk-status | python3 -m json.tool
journalctl -t pi-player-kiosk -n 100 --no-pager
```

`kiosk-status` and the diagnostics view report the intent, the observed status and the error code for each channel, plus two flags:

| Field | Meaning |
| --- | --- |
| `soundWaitingForGesture` | the picture is running but the browser has not permitted sound yet |
| `playbackStalled` | playback was requested and the browser refused it; this is what triggers a restart |

The launcher writes a single journald line when the picture goes silent, once per state rather than every 10 seconds.

### Controls on the video

Neither source shows player controls. The local `<video>` has `controls` removed and picture-in-picture, downloading and remote playback disabled; YouTube receives `controls=0`, `disablekb=1`, `fs=0`, `rel=0`, `modestbranding=1` and `iv_load_policy=3`. Both the `<video>` and the iframe get `pointer-events: none`, so a stray click cannot pause the video or open YouTube.

## Security and data

**There is no authentication.** No accounts, no passwords, no cookie sessions, no CSRF tokens and no roles: anyone who opens the device's address controls the screen. The boundary is purely the network — `Urls`, `AllowedHosts` and the nftables rule for TCP 5000, which the installer limits to the LAN CIDR you gave it. Do not publish the application to the internet and do not forward the port.

The `X-PiPlayer-Client-Id` header is an editor identity, not a pass: it exists only so that two open panels do not steal an active geometry drag from each other. The server-side lease still allows a single screen, and the client stops its adapters after 15 seconds without a confirmation, ahead of the 20-second lease expiry.

`/media/videos/{id}` and `/media/audio/{id}` serve media with Range support; the data directory, the JSON documents and the backups are never served as static files. The CSP, `X-Content-Type-Options` and `Referrer-Policy` headers are still in place.

**HTTP on a LAN encrypts nothing.** Commands and library contents travel in the clear. Use a trusted network or a properly designed HTTPS deployment.

JSON documents use schemaVersion 2 with atomic replacement, a backup of the last valid file and a per-document revision. Invalid files are preserved for diagnosis and an unknown version is never overwritten. Real v1 data would need an explicit backup-first migration; there is no previously deployed application here, and nothing chooses automatically between conflicting data sets.

An in-flight drag is saved with debounce and the final commit is written immediately. Checkpoints are written at most every 10 seconds and whenever the status changes to paused, stopped or ended. A full disk shows as `failed` while the running playback can continue from memory. Atomically replacing one JSON file is not a transaction across several files, nor a guarantee against a power cut.

Deleting an asset that is in use returns 409 with the references. Remove the current source and any referring presets first; a preset assigned at startup cannot be deleted until it is unassigned. The intent to delete is recorded before the metadata and media are removed, and unfinished operations are completed at start-up. Orphaned media are preserved with a warning.

## Updating, backup and diagnostics

1. As the graphical user run `/opt/pi-player/scripts/stop-kiosk.sh`. Then stop the backend with `sudo systemctl stop pi-player`.
2. Copy the whole data directory and keep the previous release. A consistent backup requires the backend to be stopped; the browser profile holds cookies and is not part of an ordinary data export.
3. Upload the new archive to staging, verify the checksums and run the installer. It preserves the data and the machine-specific `appsettings.Production.json`, backs up the existing data and updates the binaries, scripts and wwwroot.
4. Start the backend and the graphical launcher, or reboot, then check readiness and local playback. Never use `rsync --delete` across the whole of `/opt/pi-player`.
5. To roll back, stop the processes and restore the binaries together with a compatible data backup. An old binary must not run on top of an unknown newer schema.

Check the diagnostics view, `journalctl`, free space, the data permissions, the host name and origin, `wpctl status`, and the active display mode and scaling. If JSON is damaged, `.bak` files and the preserved `.corrupt-*` and `.invalid-*` copies are available. Without a valid backup the library is never silently reset; restore it by hand.

## Tests and layout

```powershell
dotnet test PiPlayer.sln
cd src/PiPlayer.Web
npm ci
npm test
npm run build
```

The browser E2E run needs a running backend with a **separate temporary DataPath**; it modifies the test libraries, presets and startup settings. Preparation and execution are described in [manual-test-results.md](docs/manual-test-results.md). Never run E2E against a user's installed library.

Main directories: `src/PiPlayer.Server` holds the API, SignalR, domain and storage; `src/PiPlayer.Web` holds the Angular panel, screen and adapters; `tests/PiPlayer.Server.Tests` holds unit tests and a real ASP.NET test host; `src/PiPlayer.Web/tests` holds Vitest; `src/PiPlayer.Web/e2e` holds the Chromium specs; `scripts` holds publication and installation; `docs` holds the factual results and the hardware acceptance table.

Translations live in `src/PiPlayer.Web/src/app/core/locales.ts`, with the service beside it in `i18n.ts`. Both dictionaries share the same keys and a unit test fails if one of them drifts. Adding a language means one more dictionary and one more entry in `LOCALES`.
