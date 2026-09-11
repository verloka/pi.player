// Run after preparing the E2E media fixtures: node tests/scripts/kiosk-browser.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
  chromium,
} = require("../../src/PiPlayer.Web/node_modules/@playwright/test");

async function main() {
  const root = path.resolve(__dirname, "../..");
  const launcher = fs.readFileSync(
    path.join(root, "scripts/start-kiosk.sh"),
    "utf8",
  );
  const flags = launcher
    .match(/kiosk_args=\(([\s\S]*?)\n\)/)[1]
    .match(/--[a-z0-9-]+(?:=[^\s"]+)?/g)
    .filter((flag) => !flag.startsWith("--user-data-dir"));
  const media = new Map([
    [
      "/video.mp4",
      [
        fs.readFileSync(path.join(root, "artifacts/fixtures/video.mp4")),
        "video/mp4",
      ],
    ],
    [
      "/audio.wav",
      [
        fs.readFileSync(path.join(root, "artifacts/fixtures/audio.wav")),
        "audio/wav",
      ],
    ],
  ]);
  const server = http.createServer((request, response) => {
    const file = media.get(request.url);
    response.setHeader("Content-Type", file ? file[1] : "text/html");
    response.end(
      file
        ? file[0]
        : '<html><body><video src="/video.mp4"></video><audio src="/audio.wav"></audio></body></html>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    // Fake devices prove permission is denied even when a camera/microphone exists.
    // Permission is never granted by the test, and production gets no fake-device flag.
    browser = await chromium.launch({
      headless: true,
      args: [...flags, "--use-fake-device-for-media-stream"],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const capture = await page.evaluate(async () => {
      const results = [];
      for (const constraints of [{ video: true }, { audio: true }]) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          stream.getTracks().forEach((track) => track.stop());
          results.push("granted");
        } catch (error) {
          results.push(error.name);
        }
      }
      return results;
    });
    assert.ok(
      capture.every((result) =>
        ["NotAllowedError", "NotSupportedError"].includes(result),
      ),
      JSON.stringify(capture),
    );
    assert.equal(await page.evaluate(() => typeof Notification), "undefined");
    const locationError = await page.evaluate(
      () =>
        new Promise((resolve) =>
          navigator.geolocation.getCurrentPosition(
            () => resolve(0),
            (error) => resolve(error.code),
          ),
        ),
    );
    assert.equal(locationError, 1);
    await page.evaluate(() =>
      Promise.all(
        [...document.querySelectorAll("video,audio")].map((element) =>
          element.play(),
        ),
      ),
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll("video,audio")].every(
        (element) =>
          !element.paused && !element.muted && element.currentTime > 0.5,
      ),
    );
    console.log(
      `PASS Chromium ${browser.version()}: camera/microphone denied, notifications disabled, location denied, video and unmuted audio advance.`,
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
