import { test, expect, APIRequestContext, Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Chromium under automation always permits audible autoplay: --autoplay-policy=user-gesture-required
// has no effect in the Playwright runtime, so the refusal is reproduced here by rejecting an audible
// play() exactly the way a real desktop browser does (NotAllowedError until sound becomes permitted).
// Everything after that point is the real application: adapter fallback, the screen banner, the silent
// self-check, the telemetry the backend records, and the recovery. The Raspberry Pi kiosk launcher
// passes --autoplay-policy=no-user-gesture-required, so the device never takes this path.
const REFUSE_AUDIBLE_AUTOPLAY = () => {
  const original = HTMLMediaElement.prototype.play;
  const win = window as Window & { audiblePermitted?: boolean };
  win.audiblePermitted = false;
  // A real pointer gesture lifts the refusal, exactly like a browser's user-activation rule.
  document.addEventListener(
    "pointerdown",
    () => (win.audiblePermitted = true),
    true,
  );
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!win.audiblePermitted && !this.muted && this.volume > 0)
      return Promise.reject(new DOMException("blocked", "NotAllowedError"));
    return original.call(this);
  };
};

async function command(
  api: APIRequestContext,
  target: string,
  type: string,
  payload: unknown = {},
) {
  const current = await (await api.get("/api/system/state")).json();
  const response = await api.post("/api/commands", {
    data: {
      commandId: crypto.randomUUID(),
      target,
      type,
      payload,
      expectedRevision: current.revision,
      expectedPlaybackGeneration:
        target === "system" ? null : current.desired[target].playbackGeneration,
      interactionId: null,
      clientSequence: null,
      commit: true,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
const state = async (api: APIRequestContext) =>
  (await api.get("/api/system/state")).json();
const kiosk = async (api: APIRequestContext) =>
  (await api.get("/api/system/kiosk-status")).json();

/** Uploads a clip and drives the screen into "playing, but the browser refused the sound". */
async function playIntoRefusal(api: APIRequestContext, screen: Page) {
  const upload = await api.post("/api/library/videos", {
    multipart: {
      file: {
        name: "autoplay-video.mp4",
        mimeType: "video/mp4",
        buffer: readFileSync("../../artifacts/fixtures/video.mp4"),
      },
    },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  const video = (await upload.json()).asset;

  await command(api, "system", "stopAll");
  await command(api, "visual", "clear");
  await command(api, "visual", "setMuted", { value: true });

  await screen.addInitScript(REFUSE_AUDIBLE_AUTOPLAY);
  await screen.goto("/screen");
  await expect.poll(async () => (await state(api)).screen.connected).toBe(true);

  // Ask for sound before the source starts: an audible first play is what the browser refuses.
  await command(api, "visual", "setMuted", { value: false });
  await command(api, "visual", "setVolume", { value: 80 });
  await command(api, "visual", "setSource", {
    source: { kind: "localVideo", assetId: video.id },
    autoplay: true,
  });

  // The video runs anyway, muted, and the screen says so without covering the picture.
  await expect
    .poll(async () =>
      screen.locator("video").evaluate((e) => !(e as HTMLVideoElement).paused),
    )
    .toBe(true);
  await expect(screen.locator("button.unlock")).toBeVisible();
  expect(
    await screen
      .locator("video")
      .evaluate((e) => (e as HTMLVideoElement).muted),
  ).toBe(true);
  await expect
    .poll(async () => (await state(api)).observed.visual?.error?.code)
    .toBe("autoplayMuted");
}

async function expectSoundRestored(api: APIRequestContext, screen: Page) {
  await expect(screen.locator("button.unlock")).toHaveCount(0);
  await expect
    .poll(async () =>
      screen.locator("video").evaluate((e) => (e as HTMLVideoElement).muted),
    )
    .toBe(false);
  expect(
    await screen
      .locator("video")
      .evaluate((e) => (e as HTMLVideoElement).volume),
  ).toBeCloseTo(0.8, 1);
  expect(
    await screen
      .locator("video")
      .evaluate((e) => !(e as HTMLVideoElement).paused),
  ).toBe(true);
  await expect
    .poll(async () => (await state(api)).observed.visual?.status)
    .toBe("playing");
  await expect
    .poll(async () => (await state(api)).observed.visual?.error)
    .toBeNull();
}

test.use({ viewport: { width: 1280, height: 720 } });

test("the screen recovers sound on its own, with no gesture, once the browser permits it", async ({
  request,
  page: screen,
}) => {
  try {
    await playIntoRefusal(request, screen);

    // An SSH-only operator can see this state without touching the device.
    const status = await kiosk(request);
    expect(status.soundWaitingForGesture).toBe(true);
    expect(status.playbackStalled).toBe(false);

    // Permit sound without any user gesture. evaluate() grants no user activation, so the only way
    // the screen can notice is its own silent probe.
    await screen.evaluate(() => {
      (window as Window & { audiblePermitted?: boolean }).audiblePermitted =
        true;
    });
    await expectSoundRestored(request, screen);
    await expect
      .poll(async () => (await kiosk(request)).soundWaitingForGesture)
      .toBe(false);
  } finally {
    await command(request, "system", "stopAll");
  }
});

test("a click on the screen restores sound immediately and the banner never covers the picture", async ({
  request,
  page: screen,
}) => {
  const pageErrors: string[] = [];
  screen.on("pageerror", (e) => pageErrors.push(e.message));
  try {
    await playIntoRefusal(request, screen);

    // The prompt is a corner banner, not a full-screen overlay: the video stays visible under it.
    const banner = await screen.locator("button.unlock").boundingBox();
    expect(banner!.height).toBeLessThan(160);
    expect(banner!.width).toBeLessThan(640);

    // A signage surface carries no player chrome and never swallows a click.
    expect(
      await screen
        .locator("video")
        .evaluate((e) => (e as HTMLVideoElement).controls),
    ).toBe(false);
    expect(
      await screen
        .locator("video")
        .evaluate((e) => getComputedStyle(e).pointerEvents),
    ).toBe("none");

    await screen.locator("button.unlock").click();
    await expectSoundRestored(request, screen);
    expect(pageErrors).toEqual([]);
  } finally {
    await command(request, "system", "stopAll");
  }
});
