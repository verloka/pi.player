# Release validation — 2.1.0

Development environment: Windows x64, .NET SDK 10.0.400 with runtime 10.0.11, Node 22.22.2, npm 10.9.7. Production frontend: Angular 21.2.22, TypeScript 5.9.3, SignalR 10.0.11.

What changed in this release: authentication was removed completely, Windows debugging moved to .NET Aspire, the browser's autoplay refusal is now handled without any input device, the video carries no player controls, YouTube rotation is enabled, the rotation pivot moved to the centre of the block, a frame may hang off the screen, the YouTube start-up failure was fixed, an alignment ring was added to the schematic, and the interface is available in English and Russian.

| Check | Result |
|---|---|
| Backend unit and ASP.NET integration | passed, 49 tests; TRX in artifacts/test-results/backend.trx |
| Frontend Vitest | passed, 40 tests |
| Chromium E2E | passed, 5 tests; Chromium 145.0.7632.6 |
| Open access with no login | passed; `/api/auth/*` and `/api/screen/session` answer 404, a write succeeds from a foreign Origin with no token |
| Aspire development orchestration | passed by hand: backend ready on 5000, Angular dev server on 4200, `/api` proxied through 4200 |
| Autoplay when sound is refused | passed; the picture runs muted, sound returns **with no gesture** through the silent self-check, and separately on a click |
| SSH diagnostics | passed; `kiosk-status` and the diagnostics endpoint report intent, status and error per channel plus `playbackStalled` and `soundWaitingForGesture` |
| The banner never covers the picture | passed; its measured size is a corner banner, not a full-screen overlay |
| No controls on the video | passed; `controls=false`, `pointer-events: none`, and the YouTube player parameters covered by a unit test |
| Local video rotation | passed; the CSS matrix matches 33° in Chromium |
| YouTube rotation | passed on the live provider; the clip plays rotated and partly off screen |
| Rotation by mouse | passed; dragging the grip gives 90°, Shift snaps to 135°, and the position does not move |
| Rotation pivot | passed; `transform-origin` is the centre of the block and opposite corners stay symmetric about it |
| A frame hanging off the screen | passed; accepted by both the backend and the screen for either source |
| YouTube captions | passed on the live provider; the same paused frame is byte-identical before and after captions are forced on and turned off again, while forcing them on changes 75 KB |
| Alignment ring, 225 mm | passed; anchored to the centre of the screen and unmoved by the block's position, scale or rotation, the radius matches the calculation, and the stroke is transparent to the mouse |
| Schematic when the block overflows | passed; the drawn area zooms out, the rotation grip stays reachable, and the screen proportions are preserved |
| YouTube start-up | passed; two causes of a permanently stopped clip fixed: `getAvailablePlaybackRates()` before the data loads, and commands issued before the cue is accepted |
| English and Russian interface | passed; both dictionaries hold the same keys, the browser language decides the default, a choice survives a reload |
| PowerShell parser and Bash `-n` | passed for every script |
| npm audit including dev dependencies | no known vulnerabilities |
| Pinned npm ci and the Angular production build | passed |
| Self-contained linux-arm64 publish | passed; the apphost is an AArch64 ELF |
| Release contents and SHA-256 | passed; shell scripts use LF with no BOM and no private data is present |
| Real ARM64 execution, installation, cold boot | notRun — no Raspberry Pi available |
| YouTube playlists, consent and account restrictions | notRun — an SDK double stands in |

Release files: `artifacts/pi-player-2.1.0-linux-arm64.tar.gz` and the neighbouring `.sha256`. Inside are `release.json`, carrying the versions and the build time, and `SHA256SUMS` for every file. The archive's own hash is written outside it so the manifest never refers to itself.

The browser's refusal of audible autoplay is reproduced in E2E by replacing `HTMLMediaElement.prototype.play`: Chromium under automation always permits sound, and `--autoplay-policy=user-gesture-required` has no effect inside Playwright. `navigator.getAutoplayPolicy` is absent from Chromium 145, which is why the policy is detected with a silent probe instead. The application's reaction to a refusal is real. The kiosk flag and the launcher restart on the device itself remain hardware acceptance.

The automated tests reached the live YouTube service for a single video, its rotation and its captions. Playlists, consent, region and account restrictions were not exercised. The remote Audio E2E uses a direct URL to a controlled WAV served by the local backend, which is not a check of a radio station or of an audio output.
