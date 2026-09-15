import { test, expect, APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";

const snapshot = async (api: APIRequestContext) =>
  (await api.get("/api/system/state")).json();
async function command(
  api: APIRequestContext,
  target: string,
  type: string,
  payload: unknown = {},
) {
  const state = await snapshot(api);
  const response = await api.post("/api/commands", {
    data: {
      commandId: crypto.randomUUID(),
      target,
      type,
      payload,
      expectedRevision: state.revision,
      expectedPlaybackGeneration:
        target === "system" ? null : state.desired[target].playbackGeneration,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test("real MP4 preset replacement waits for loading, crossfades, preserves audio and survives a failed next file", async ({
  page: screen,
  context,
}) => {
  const api = context.request;
  await command(api, "system", "stopAll");
  await command(api, "visual", "clear");
  await command(api, "audio", "setSource", { source: null, autoplay: false });
  await command(api, "visual", "setTransform", {
    x: 0,
    y: 0,
    width: 640,
    height: 360,
    scale: 1,
    rotation: 0,
    opacity: 1,
    objectFit: "contain",
  });
  await command(api, "visual", "setLoop", { value: true });
  const ids: string[] = [];
  for (const name of [
    "transition-a.mp4",
    "transition-b.mp4",
    "transition-error.mp4",
  ]) {
    const response = await api.post("/api/library/videos", {
      multipart: {
        file: {
          name,
          mimeType: "video/mp4",
          buffer: readFileSync("../../artifacts/fixtures/video.mp4"),
        },
      },
    });
    expect(response.ok()).toBeTruthy();
    ids.push((await response.json()).asset.id);
  }
  const upload = await api.post("/api/library/audio", {
    multipart: {
      file: {
        name: "transition-audio.wav",
        mimeType: "audio/wav",
        buffer: readFileSync("../../artifacts/fixtures/audio.wav"),
      },
    },
  });
  expect(upload.ok()).toBeTruthy();
  const audioId = (await upload.json()).asset.id;
  await command(api, "audio", "setLoop", { value: true });
  await command(api, "audio", "setSource", {
    source: { kind: "localFile", assetId: audioId },
    autoplay: true,
  });
  await command(api, "visual", "setSource", {
    source: { kind: "localVideo", assetId: ids[0] },
    autoplay: true,
  });
  const errors: string[] = [];
  screen.on("pageerror", (error) => errors.push(error.message));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await screen.route(`**/media/videos/${ids[1]}`, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await screen.goto("/screen");
    await expect
      .poll(async () => (await snapshot(api)).observed.visual?.status)
      .toBe("playing");
    await expect
      .poll(async () => (await snapshot(api)).observed.audio?.status)
      .toBe("playing");
    const original = await screen.locator("video").elementHandle();
    const audio = await screen.locator("audio").elementHandle();
    const state = await snapshot(api);
    const response = await api.post("/api/presets/visual", {
      data: {
        name: "Transition B",
        source: { kind: "localVideo", assetId: ids[1] },
        visible: true,
        transform: { ...state.desired.visual.transform, x: 100 },
        playback: state.desired.visual.playback,
        initialPositionSeconds: 0,
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const presetId = (await response.json()).items.at(-1).id;
    await command(api, "system", "applyPresets", {
      visualPresetId: presetId,
      autoplay: true,
    });
    await expect(screen.locator("video")).toHaveCount(2);
    await expect(screen.locator(".visual-frame").first()).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(screen.locator(".visual-frame").last()).toHaveCSS(
      "opacity",
      "0",
    );
    await expect(screen.locator(".visual-layer").first()).toHaveCSS(
      "left",
      "0px",
    );
    await expect(screen.locator(".visual-layer").last()).toHaveCSS(
      "left",
      "100px",
    );
    const before = await original!.evaluate(
      (video) => (video as HTMLVideoElement).currentTime,
    );
    await expect
      .poll(() =>
        original!.evaluate((video) => (video as HTMLVideoElement).currentTime),
      )
      .toBeGreaterThan(before + 0.25);
    expect(
      await original!.evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(false);
    const audioBefore = await audio!.evaluate(
      (element) => (element as HTMLAudioElement).currentTime,
    );
    const frames = screen.evaluate(async () => {
      const samples: number[][] = [];
      const end = performance.now() + 2000;
      while (performance.now() < end) {
        samples.push(
          Array.from(document.querySelectorAll(".visual-frame"), (frame) =>
            Number(getComputedStyle(frame).opacity),
          ),
        );
        await new Promise(requestAnimationFrame);
      }
      return samples;
    });
    release();
    await expect(screen.locator("video")).toHaveCount(1);
    await expect(screen.locator("video")).toHaveAttribute(
      "src",
      `/media/videos/${ids[1]}`,
    );
    await expect(screen.locator(".visual-frame")).toHaveCSS("opacity", "1");
    const samples = await frames;
    expect(
      samples.some(
        (pair) =>
          pair.length === 2 &&
          pair.every((opacity) => opacity > 0 && opacity < 1),
      ),
    ).toBe(true);
    expect(await original!.evaluate((video) => video.isConnected)).toBe(false);
    expect(
      await audio!.evaluate(
        (element) => element === document.querySelector("audio"),
      ),
    ).toBe(true);
    expect(
      await audio!.evaluate((element) => (element as HTMLAudioElement).paused),
    ).toBe(false);
    expect(
      await audio!.evaluate(
        (element) => (element as HTMLAudioElement).currentTime,
      ),
    ).toBeGreaterThan(audioBefore);
    expect((await snapshot(api)).desired.audio).toEqual(state.desired.audio);

    await screen.route(`**/media/videos/${ids[2]}`, (route) =>
      route.abort("failed"),
    );
    await command(api, "visual", "setSource", {
      source: { kind: "localVideo", assetId: ids[2] },
      autoplay: true,
    });
    await expect
      .poll(async () => (await snapshot(api)).observed.visual?.status)
      .toBe("error");
    await expect(screen.locator(".visual-frame").first()).toHaveCSS(
      "opacity",
      "1",
    );
    expect(
      await screen
        .locator(`video[src="/media/videos/${ids[1]}"]`)
        .evaluate((video) => (video as HTMLVideoElement).paused),
    ).toBe(false);
    await command(api, "visual", "clear");
    await expect(screen.locator("video")).toHaveCount(0);
    expect(
      await audio!.evaluate((element) => (element as HTMLAudioElement).paused),
    ).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    release();
    await command(api, "system", "stopAll");
  }
});
