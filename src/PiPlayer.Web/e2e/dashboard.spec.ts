import { test, expect, APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";

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
}
const audioTransport = async (api: APIRequestContext) =>
  (await (await api.get("/api/system/state")).json()).desired.audio.transport;

// The dashboard is what people keep open on a phone.
test.use({ viewport: { width: 390, height: 844 } });

test("the dashboard opens first and pauses and switches presets on one page", async ({
  page,
  request,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await command(request, "system", "stopAll");
  const upload = await request.post("/api/library/audio", {
    multipart: {
      file: {
        name: "dashboard-audio.wav",
        mimeType: "audio/wav",
        buffer: readFileSync("../../artifacts/fixtures/audio.wav"),
      },
    },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  const asset = (await upload.json()).asset;
  const presetName = `Dashboard music ${Date.now()}`;
  const saved = await request.post("/api/presets/audio", {
    data: {
      name: presetName,
      source: { kind: "localFile", assetId: asset.id },
      playback: { loop: true, muted: false, volume: 50 },
      initialPositionSeconds: 0,
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  try {
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "Quick control" }),
    ).toBeVisible();

    // On a phone one preset list shows at a time; the switch picks the channel.
    await page.getByRole("button", { name: "Audio presets" }).click();
    // A preset starts with one tap, and the dashboard marks the one on screen.
    const tile = page.getByRole("button", { name: presetName });
    await tile.click();
    await expect.poll(() => audioTransport(request)).toBe("playing");
    await expect(tile).toHaveClass(/active/);

    // Each channel has one big button that says what it will do next.
    const audio = page.locator(".now-audio");
    await expect(audio.locator(".state-pill")).toHaveText("Playing");
    await audio
      .getByRole("button", { name: "Pause: Audio", exact: true })
      .click();
    await expect.poll(() => audioTransport(request)).toBe("paused");
    await expect(audio.locator(".state-pill")).toHaveText("Paused");
    await expect(
      audio.getByRole("button", { name: "Play: Audio", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Play everything" }).click();
    await expect.poll(() => audioTransport(request)).toBe("playing");
    await page.getByRole("button", { name: "Pause everything" }).click();
    await expect.poll(() => audioTransport(request)).toBe("paused");

    // Without wpctl (any machine but the Pi) the volume card says why instead of offering dead controls.
    const device = await (await request.get("/api/device")).json();
    if (device.volumePercent === null) {
      await expect(
        page.getByRole("button", { name: "Volume up" }),
      ).toBeDisabled();
      await expect(page.locator(".device-warning")).toContainText("wpctl");
    }

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await command(request, "system", "stopAll");
  }
});
