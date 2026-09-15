import { test, expect, APIRequestContext } from "@playwright/test";

// SDK double: exercises the real UI, API, storage, reconciliation and DOM placement.
// This does not prove YouTube permits off-screen playback or that the Pi outputs sound.
function youtubeDouble() {
  class Player {
    private frame = document.createElement("iframe");
    private status = 5;
    private position = 0;
    private started = 0;
    private volume = 100;
    private muted = true;
    private videoId = "";
    constructor(
      target: HTMLElement,
      private options: {
        events: {
          onReady: () => void;
          onStateChange: (event: { data: number }) => void;
        };
      },
    ) {
      target.replaceWith(this.frame);
      queueMicrotask(() => this.options.events.onReady());
    }
    private emit(status: number) {
      this.status = status;
      this.options.events.onStateChange({ data: status });
    }
    cueVideoById(value: { videoId: string }) {
      this.videoId = value.videoId;
      this.frame.dataset.videoId = value.videoId;
      queueMicrotask(() => this.emit(5));
    }
    getIframe() {
      return this.frame;
    }
    getOptions() {
      return [];
    }
    setLoop() {}
    setVolume(value: number) {
      this.volume = value;
    }
    getVolume() {
      return this.volume;
    }
    mute() {
      this.muted = true;
    }
    unMute() {
      this.muted = false;
    }
    isMuted() {
      return this.muted;
    }
    getAvailablePlaybackRates() {
      return [1];
    }
    getPlaybackRate() {
      return 1;
    }
    getPlayerState() {
      return this.status;
    }
    getDuration() {
      return 120;
    }
    getVideoUrl() {
      return "https://www.youtube.com/watch?v=" + this.videoId;
    }
    getCurrentTime() {
      return (
        this.position +
        (this.status === 1 ? (performance.now() - this.started) / 1000 : 0)
      );
    }
    seekTo(seconds: number) {
      this.position = seconds;
      this.started = performance.now();
    }
    playVideo() {
      if (this.status !== 1) {
        this.started = performance.now();
        this.emit(1);
      }
    }
    pauseVideo() {
      this.position = this.getCurrentTime();
      this.emit(2);
    }
    destroy() {
      this.frame.remove();
    }
  }
  Object.assign(window, { YT: { Player } });
}

const state = async (api: APIRequestContext) =>
  (await api.get("/api/system/state")).json();
async function command(
  api: APIRequestContext,
  target: string,
  type: string,
  payload: unknown = {},
) {
  const current = await state(api);
  const response = await api.post("/api/commands", {
    data: {
      commandId: crypto.randomUUID(),
      target,
      type,
      payload,
      expectedRevision: current.revision,
      expectedPlaybackGeneration:
        target === "system" ? null : current.desired[target].playbackGeneration,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test("experimental YouTube audio: UI selection, off-screen host, independent controls, reload and cleanup", async ({
  context,
  page,
}) => {
  await command(context.request, "system", "stopAll");
  await command(context.request, "audio", "setSource", {
    source: null,
    autoplay: false,
  });
  await command(context.request, "visual", "setSource", {
    source: { kind: "youtubeVideo", videoId: "dQw4w9WgXcQ" },
    autoplay: true,
  });
  const originalVisual = (await state(context.request)).desired.visual;
  const screen = await context.newPage();
  const errors: string[] = [];
  screen.on("pageerror", (e) => errors.push(e.message));
  page.on("pageerror", (e) => errors.push(e.message));
  await screen.addInitScript(youtubeDouble);
  try {
    await screen.goto("/screen");
    await expect
      .poll(async () => (await state(context.request)).observed.visual?.status)
      .toBe("playing");
    await page.goto("/admin");
    await page.getByRole("button", { name: "Studio", exact: true }).click();
    const audio = page.locator(".audio-panel");
    await audio
      .locator('select[formControlName="kind"]')
      .selectOption("youtubeAudio");
    await audio
      .getByLabel("YouTube URL")
      .fill("https://www.youtube.com/watch?v=M7lc1UVf-VE&list=RDM7lc1UVf-VE");
    await audio
      .getByRole("button", { name: "Select and play", exact: true })
      .click();
    await expect
      .poll(async () => (await state(context.request)).observed.audio?.status)
      .toBe("playing");
    const selected = await state(context.request);
    expect(selected.desired.audio.source).toEqual({
      kind: "youtubeAudio",
      videoId: "M7lc1UVf-VE",
    });
    expect(selected.desired.visual).toEqual(originalVisual);
    expect(selected.observed.audio.sourceFingerprint).toBe(
      "youtubeAudio:M7lc1UVf-VE",
    );
    await expect(screen.locator(".audio-layer iframe")).toHaveAttribute(
      "data-video-id",
      "M7lc1UVf-VE",
    );
    await expect(screen.locator(".visual-layer iframe")).toHaveAttribute(
      "data-video-id",
      "dQw4w9WgXcQ",
    );
    const box = await screen.locator(".audio-layer iframe").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBe(320);
    expect(box!.height).toBe(200);
    expect(box!.x + box!.width).toBeLessThan(0);

    await audio.getByLabel("Mute", { exact: true }).check();
    await expect
      .poll(
        async () => (await state(context.request)).observed.audio?.actualMuted,
      )
      .toBe(true);
    await audio.getByRole("button", { name: "Ⅱ Pause", exact: true }).click();
    await expect
      .poll(async () => (await state(context.request)).observed.audio?.status)
      .toBe("paused");
    await command(context.request, "audio", "seek", { seconds: 17 });
    await expect
      .poll(
        async () =>
          (await state(context.request)).checkpoints.audio?.positionSeconds,
      )
      .toBe(17);
    expect((await state(context.request)).observed.visual.status).toBe(
      "playing",
    );

    await screen.reload();
    await expect
      .poll(
        async () =>
          (await state(context.request)).screen.descriptor?.pageSessionId,
      )
      .not.toBe(selected.screen.descriptor.pageSessionId);
    await expect(screen.locator(".audio-layer iframe")).toHaveCount(1);
    await expect
      .poll(
        async () =>
          (await state(context.request)).observed.audio?.positionSeconds,
      )
      .toBe(17);
    await audio.getByRole("button", { name: "Resume", exact: true }).click();
    await expect
      .poll(async () => (await state(context.request)).observed.audio?.status)
      .toBe("playing");

    // Removing/replacing YouTube audio must remove only its own embed.
    await audio
      .getByRole("button", { name: "Clear source", exact: true })
      .click();
    await expect(screen.locator(".audio-layer iframe")).toHaveCount(0);
    await expect(screen.locator(".visual-layer iframe")).toHaveCount(1);
    expect((await state(context.request)).desired.visual).toEqual(
      originalVisual,
    );
    expect((await state(context.request)).observed.visual.status).toBe(
      "playing",
    );
    expect(errors).toEqual([]);
  } finally {
    await command(context.request, "system", "stopAll");
    await screen.close();
  }
});
