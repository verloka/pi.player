# PiPlayer implementation status

The software and the self-contained ARM64 release **2.1.0** are ready. A device is only fully ready after hardware acceptance, and no Raspberry Pi is reachable from this environment.

| Specification phase | Implementation | Checks |
|---|---|---|
| 0 — feasibility | completed: the production screen doubles as the prototype, preflight and the matrix are prepared | not tested on a Pi; a local Chromium smoke run passed |
| 1 — skeleton and contracts | completed, **with no authentication** | Backend and Angular build; every route is open and the retired login and CSRF routes answer 404 |
| 2 — JSON and recovery | completed | Atomic concurrency, backup, a guard against a future schema, an injected storage failure |
| 3 — media libraries | completed | Upload with signature and byte limits, Range/HEAD/206/416, rename, reference safety, durable deletion recovery |
| 4 — commands and local Visual | completed | Reducer generations, deduplication, conflicts, drag commit, 100/20/33, real browser playback, video without controls, rotation by mouse around the centre with a Shift step |
| 5 — independent Audio | completed | An independent channel reducer and a real local WAV; live and retry code tests. External radio not tested on a Pi |
| 6 — YouTube Visual | completed, rotation enabled | Parser and capability tests, the official SDK double, and **the live service verified in Chromium**: the clip starts, the position advances, the frame is rotated about its centre, hangs off the screen and shows no captions |
| 7 — presets and startup | completed | CRUD and reference tests; all four default combinations, resumeLast, and registration without repeating startup |
| 8 — reconnect, leases, checkpoints | completed | Session, generation, fingerprint and sequence guards, the A→B race, browser reload and checkpoint, a second screen |
| 9 — installation, release, docs | completed in the sources | Bash scripts syntax-checked; ARM64 publish, archive contents and SHA-256 passed. Installation on a Pi not tested |

Final release run: **49 backend tests**, **40 frontend tests** and **5 Chromium E2E tests** passed. Results are in `docs/release-validation.md`; the archive hash is in `artifacts/pi-player-2.1.0-linux-arm64.tar.gz.sha256`.

## Real limitations

- Hardware facts are unknown and HW-01…HW-32 are `notRun`. A desktop build is not a Raspberry Pi cold boot.
- A single YouTube video, its rotation and its captions were verified against the live service. Playlists, Referer, consent, account, region behaviour and remote radio on a Pi are `notRun`; the SDK double only covers integration logic.
- YouTube rotation is enabled by default and verified on the live provider in Chromium. Compliance with the service policies and the compositing load on a Pi are `notRun`; the `EnableExperimentalYouTubeRotation` key remains available to turn it off.
- The installation adapter targets a confirmed Raspberry Pi OS Desktop ARM64 with labwc and LightDM. X11, other compositors and OS Lite are **not implemented**; preflight and configure refuse unsuitable changes.
- The optional ffprobe step is **not implemented**, so duration and codecs in the library may be null. No permitted extension promises hardware compatibility.
- Authentication was removed entirely on request: no accounts, cookie sessions, CSRF or roles. Access is bounded only by the network and the installer's nftables rule.
- No scenario needs an input device. When the browser refuses sound the picture keeps running muted, the screen checks every 5 seconds with a silent probe whether sound is permitted and turns it on with no gesture, a refused start retries, and a stalled screen is restarted by the launcher. Verified in Chromium with a simulated refusal; the behaviour of the kiosk flag on the device itself is **not verified in hardware**.
- The browser's refusal of audible autoplay cannot be reproduced inside Playwright, which always permits sound and ignores `--autoplay-policy=user-gesture-required`. E2E simulates the refusal by replacing `play()`, and the application's reaction is genuine.
- Checkpoint recovery may repeat a few seconds. Seamless looping, frame synchronisation, physical audibility and long-run performance are not claimed.
- There is no real v1 data. A version guard and preservation of the originals are implemented; the elaborate v1 migration engine was not built, which the specification permits.

Full instructions: [README](README.md), [hardware profile](docs/hardware-profile.md), [compatibility](docs/compatibility-report.md), [acceptance](docs/manual-test-results.md).

The original specification `pi-player-detailed-plan-v2.md` is the author's own document and is deliberately left in Russian: translating a requirements text risks changing what it requires.
