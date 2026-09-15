import { test, expect, BrowserContext, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
// The appliance has no accounts: opening /admin is the whole entry sequence. It lands on the dashboard;
// the geometry editor these specs drive is on the Studio tab.
async function studio(page: Page) {
  await page.getByRole("button", { name: "Studio", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Scene control" }),
  ).toBeVisible();
}
async function open(page: Page) {
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Quick control" }),
  ).toBeVisible();
  await studio(page);
}
async function request(
  context: BrowserContext,
  path: string,
  data: unknown,
  method = "POST",
  revision?: number,
) {
  const response = await context.request.fetch(path, {
    method,
    data,
    headers: {
      Origin: "http://localhost:5000",
      ...(revision !== undefined ? { "If-Match": `"${revision}"` } : {}),
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.status() === 204 ? null : response.json();
}
async function command(
  context: BrowserContext,
  target: string,
  type: string,
  payload: unknown = {},
) {
  const state = await (await context.request.get("/api/system/state")).json();
  return request(context, "/api/commands", {
    commandId: crypto.randomUUID(),
    target,
    type,
    payload,
    expectedRevision: state.revision,
    expectedPlaybackGeneration:
      target === "system" ? null : state.desired[target].playbackGeneration,
    interactionId: null,
    clientSequence: null,
    commit: true,
  });
}
test("real Chromium: upload, transform 100/20/33, independent sound, pause, seek, reload and lease", async ({
  browser,
  page,
  context,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await open(page);
  await expect(page.locator(".topbar")).toHaveCSS("display", "flex");
  await command(context, "system", "stopAll");
  await command(context, "visual", "clear");
  await command(context, "visual", "setTransform", {
    x: 0,
    y: 0,
    width: 640,
    height: 360,
    scale: 1,
    rotation: 0,
    opacity: 1,
    objectFit: "contain",
  });
  const videoResponse = await context.request.post("/api/library/videos", {
    headers: { Origin: "http://localhost:5000" },
    multipart: {
      file: {
        name: "e2e-video.mp4",
        mimeType: "video/mp4",
        buffer: readFileSync("../../artifacts/fixtures/video.mp4"),
      },
    },
  });
  expect(videoResponse.ok(), await videoResponse.text()).toBeTruthy();
  const video = (await videoResponse.json()).asset;
  const audioResponse = await context.request.post("/api/library/audio", {
    headers: { Origin: "http://localhost:5000" },
    multipart: {
      file: {
        name: "e2e-audio.wav",
        mimeType: "audio/wav",
        buffer: readFileSync("../../artifacts/fixtures/audio.wav"),
      },
    },
  });
  expect(audioResponse.ok(), await audioResponse.text()).toBeTruthy();
  const audio = (await audioResponse.json()).asset;
  const screenContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const screen = await screenContext.newPage();
  screen.on("pageerror", (e) => pageErrors.push(e.message));
  await screen.goto("/screen");
  await expect
    .poll(
      async () =>
        (await (await context.request.get("/api/system/state")).json()).screen
          .connected,
    )
    .toBe(true);
  await command(context, "visual", "setSource", {
    source: { kind: "localVideo", assetId: video.id },
    autoplay: true,
  });
  await expect
    .poll(
      async () =>
        (await (await context.request.get("/api/system/state")).json()).observed
          .visual?.status,
    )
    .toBe("playing");
  // Kiosk autoplay policy: playback starts on its own, so the screen must not ask for a gesture.
  await expect(screen.locator("button.unlock")).toHaveCount(0);
  expect(
    await screen
      .locator("video")
      .evaluate((e) => (e as HTMLVideoElement).controls),
  ).toBe(false);
  const originalVideo = await screen.locator("video").elementHandle();
  await page.getByLabel("X, px", { exact: true }).fill("100");
  await page.getByLabel("Y, px", { exact: true }).fill("20");
  await page.getByLabel("Width", { exact: true }).fill("800");
  await page.getByLabel("Height", { exact: true }).fill("450");
  await page.getByLabel("Angle, °", { exact: true }).fill("33");
  await page.getByRole("button", { name: "Apply geometry" }).click();
  await expect(screen.locator(".visual-layer")).toHaveCSS("left", "100px");
  await expect(screen.locator(".visual-layer")).toHaveCSS("top", "20px");
  expect(
    await originalVideo!.evaluate(
      (element) => element === document.querySelector("video"),
    ),
  ).toBe(true);
  // The layer turns around its own centre: 800×450 gives a computed origin of 400px 225px.
  await expect(screen.locator(".visual-layer")).toHaveCSS(
    "transform-origin",
    "400px 225px",
  );
  await command(context, "audio", "setSource", {
    source: { kind: "localFile", assetId: audio.id },
    autoplay: true,
  });
  await expect
    .poll(
      async () =>
        (await (await context.request.get("/api/system/state")).json()).observed
          .audio?.status,
    )
    .toBe("playing");
  expect(
    await screen
      .locator("video")
      .evaluate((e) => !(e as HTMLVideoElement).paused),
  ).toBe(true);
  await command(context, "visual", "setMuted", { value: false });
  await expect
    .poll(async () =>
      screen.locator("video").evaluate((e) => (e as HTMLVideoElement).muted),
    )
    .toBe(false);
  await command(context, "visual", "setMuted", { value: true });
  await command(context, "visual", "pause");
  await expect
    .poll(
      async () =>
        (await (await context.request.get("/api/system/state")).json()).observed
          .visual?.status,
    )
    .toBe("paused");
  expect(
    await screen
      .locator("audio")
      .evaluate((e) => !(e as HTMLAudioElement).paused),
  ).toBe(true);
  await command(context, "visual", "seek", { seconds: 5 });
  await expect
    .poll(async () =>
      screen
        .locator("video")
        .evaluate((e) => (e as HTMLVideoElement).currentTime),
    )
    .toBeCloseTo(5, 0);
  const s = await (await context.request.get("/api/system/state")).json();
  const vdoc = await request(context, "/api/presets/visual", {
    name: "E2E scene 100/20/33",
    source: s.desired.visual.source,
    visible: true,
    transform: s.desired.visual.transform,
    playback: s.desired.visual.playback,
    initialPositionSeconds: 0,
    referenceViewport: s.screen.descriptor.viewport,
  });
  const adoc = await request(context, "/api/presets/audio", {
    name: "E2E music",
    source: s.desired.audio.source,
    playback: s.desired.audio.playback,
    initialPositionSeconds: 0,
  });
  const startup = await (
    await context.request.get("/api/settings/startup")
  ).json();
  await request(
    context,
    "/api/settings/startup",
    {
      startupMode: "defaults",
      defaultVisualPresetId: vdoc.items.at(-1).id,
      defaultAudioPresetId: adoc.items.at(-1).id,
      startVisualOnBoot: true,
      startAudioOnBoot: true,
      backgroundColor: "#000000",
    },
    "PUT",
    startup.documentRevision,
  );
  await page.reload();
  await studio(page);
  expect(
    await screen
      .locator("video")
      .evaluate((e) => (e as HTMLVideoElement).currentTime),
  ).toBeCloseTo(5, 0);
  await screen.reload();
  await expect
    .poll(async () =>
      screen
        .locator("video")
        .evaluate((e) => (e as HTMLVideoElement).currentTime),
    )
    .toBeCloseTo(5, 0);
  const second = await screenContext.newPage();
  await second.goto("/screen");
  await expect(second.locator("video")).toHaveCount(0);
  await expect(second.locator("audio")).toHaveCount(0);
  await page.screenshot({
    path: "../../artifacts/admin-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../../artifacts/admin-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(pageErrors).toEqual([]);
  await second.close();
  await screenContext.close();
});
test("admin never creates a player element and needs no login round trip", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator("iframe,video,audio")).toHaveCount(0);
  const retired = await page.evaluate(async () =>
    Promise.all(
      ["/api/auth/session", "/api/auth/csrf"].map(
        async (path) => (await fetch(path)).status,
      ),
    ),
  );
  expect(retired).toEqual([404, 404]);
});
test("a YouTube outage and a shrinking screen do not stop direct remote Audio", async ({
  browser,
  page,
  context,
}) => {
  await open(page);
  await command(context, "system", "stopAll");
  await command(context, "visual", "clear");
  await command(context, "visual", "setTransform", {
    x: 0,
    y: 0,
    width: 640,
    height: 360,
    scale: 1,
    rotation: 0,
    opacity: 1,
    objectFit: "contain",
  });
  await command(context, "visual", "setPlaybackRate", { value: 1 });
  const uploaded = await context.request.post("/api/library/audio", {
    headers: { Origin: "http://localhost:5000" },
    multipart: {
      file: {
        name: "remote-fixture.wav",
        mimeType: "audio/wav",
        buffer: readFileSync("../../artifacts/fixtures/audio.wav"),
      },
    },
  });
  expect(uploaded.ok()).toBe(true);
  const asset = (await uploaded.json()).asset;
  const sc = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  await sc.route("https://www.youtube.com/iframe_api", (route) =>
    route.abort(),
  );
  const screen = await sc.newPage();
  await screen.goto("/screen");
  await expect
    .poll(
      async () =>
        (await (await context.request.get("/api/system/state")).json()).screen
          .connected,
    )
    .toBe(true);
  await command(context, "audio", "setSource", {
    source: {
      kind: "remoteAudioUrl",
      url: new URL("/media/audio/" + asset.id, page.url()).href,
      streamMode: "file",
    },
    autoplay: true,
  });
  await expect
    .poll(
      async () =>
        (await (await context.request.get("/api/system/state")).json()).observed
          .audio?.status,
    )
    .toBe("playing");
  await command(context, "visual", "setSource", {
    source: { kind: "youtubeVideo", videoId: "dQw4w9WgXcQ" },
    autoplay: true,
  });
  await expect
    .poll(
      async () =>
        (await (await context.request.get("/api/system/state")).json()).observed
          .visual?.error?.code,
    )
    .toBe("providerUnavailable");
  expect(
    await screen
      .locator("audio")
      .evaluate((e) => !(e as HTMLAudioElement).paused),
  ).toBe(true);
  // The frame is allowed to be larger than the screen, so shrinking the viewport changes nothing
  // about the visual channel: the reported reason stays the provider outage, not geometry.
  await screen.setViewportSize({ width: 180, height: 180 });
  await expect
    .poll(
      async () =>
        (await (await context.request.get("/api/system/state")).json()).observed
          .visual?.error?.code,
    )
    .toBe("providerUnavailable");
  expect(
    await screen
      .locator("audio")
      .evaluate((e) => !(e as HTMLAudioElement).paused),
  ).toBe(true);
  await command(context, "audio", "stop");
  await expect
    .poll(
      async () =>
        (await (await context.request.get("/api/system/state")).json()).observed
          .audio?.status,
    )
    .toBe("stopped");
  await expect(screen.locator("iframe")).toHaveCount(0);
  await command(context, "visual", "clear");
  await sc.close();
});
