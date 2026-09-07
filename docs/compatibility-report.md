# Compatibility report

| Capability | Status | Evidence / what is still needed |
|---|---|---|
| Local H.264/AAC MP4, 640×360, 24 fps | passed on Windows Chromium | A real media element and an observed playing status in E2E; not a Pi test |
| Local PCM WAV, independent Audio | passed on Windows Chromium | Simultaneous playback with the video, independent pause and mute |
| Local transform x=100 / y=20 / rotation=33 | passed on Windows Chromium | Unit geometry plus a CSS check, and the same video element survives the change |
| Rotation around the centre of the block | passed on Windows Chromium | `transform-origin` measured in the browser, opposite corners symmetric about the centre |
| Rotation by mouse with a 15° Shift step | passed on Windows Chromium | Dragging the grip produced 90°, Shift snapped to 135°, position unchanged |
| Range / HEAD / 206 / 416 | passed | ASP.NET integration test |
| MP3 / OGG / M4A / FLAC / WebM on the Pi | notRun | Extensions and signatures are allowed; hardware decoding is unconfirmed |
| YouTube adapter lifecycle / errors / playlist context | passed with an SDK double | This checks the code, not the live service |
| YouTube video from a localhost origin | passed on Windows Chromium | The clip started, the position advanced, rotated and partly off screen |
| YouTube captions stay off | passed on the live provider | The same paused frame is byte-identical before and after captions are forced on and off again |
| YouTube playlists, consent, region and account restrictions | notRun | Needs agreed reachable embeds, cookies and the target Chromium |
| YouTube autoplay muted or audible after a cold boot | notRun | The kiosk flag is no proof of external compatibility |
| YouTube rotation on the device | notRun, enabled in configuration | Accepted and rendered on the desktop. Provider policy and Pi compositing load are unverified |
| Remote direct file or continuous radio on the Pi | notRun | Needs a real HTTP(S) source; the network and retry branches are covered separately |
| labwc / LightDM installation and watchdog | notRun on the Pi | The scripts are written and syntax-checked with Bash |
| Disk-full fault | passed with an injected filesystem failure | The test confirms the `failed` state and that writing recovers; no physical disk-full or power cut was staged |
| Two-hour playback, memory, thermals, dropped frames | notRun | Needs the target Pi and an agreed media profile |

Rotation: the container rotation maths, the checks for every angle and the configuration gate are implemented and enabled. The IFrame API documentation offers no official rotation parameter. A working CSS prototype is not an assessment of YouTube's requirements, and the switch remains available to turn the behaviour off.

Autoplay: `navigator.getAutoplayPolicy` is absent from Chromium 145, so the screen decides whether audible playback is permitted by playing a one-second silent WAV unmuted. Captions need more than `cc_load_policy=0`, because the provider reloads the captions module during playback; the screen unloads it on every state change and on a slow guard timer.

External documents re-checked during implementation: [IFrame API](https://developers.google.com/youtube/iframe_api_reference), [minimum functionality](https://developers.google.com/youtube/terms/required-minimum-functionality), [developer policies](https://developers.google.com/youtube/terms/developer-policies), [player parameters](https://developers.google.com/youtube/player_parameters), [Chrome autoplay](https://developer.chrome.com/blog/autoplay/). None of them constitutes hardware acceptance of this application.
