const { chromium, request: pwRequest } = require("@playwright/test");
const { readFileSync } = require("node:fs");
(async () => {
  const api = await pwRequest.newContext({ baseURL: "http://localhost:5000" });
  const cmd = async (target, type, payload = {}) => {
    const st = await (await api.get("/api/system/state")).json();
    const r = await api.post("/api/commands", {
      data: {
        commandId: crypto.randomUUID(),
        target,
        type,
        payload,
        expectedRevision: st.revision,
        expectedPlaybackGeneration:
          target === "system" ? null : st.desired[target].playbackGeneration,
        interactionId: null,
        clientSequence: null,
        commit: true,
      },
    });
    if (!r.ok()) console.log("CMD FAIL", type, await r.text());
  };
  const up = await api.post("/api/library/videos", {
    multipart: {
      file: {
        name: "p2.mp4",
        mimeType: "video/mp4",
        buffer: readFileSync("../../artifacts/fixtures/video.mp4"),
      },
    },
  });
  const video = (await up.json()).asset;
  await cmd("system", "stopAll");
  await cmd("visual", "clear");
  await cmd("visual", "setMuted", { value: true });
  const browser = await chromium.launch({
    args: ["--autoplay-policy=user-gesture-required"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__hist = [];
    window.__gestures = [];
    for (const e of [
      "pointerdown",
      "mousedown",
      "touchstart",
      "keydown",
      "click",
    ])
      document.addEventListener(
        e,
        (ev) =>
          window.__gestures.push({ e, trusted: ev.isTrusted, t: Date.now() }),
        true,
      );
    setInterval(() => {
      const v = document.querySelector("video");
      window.__hist.push({
        t: Date.now(),
        u: !!document.querySelector("button.unlock"),
        m: v ? v.muted : null,
        p: v ? v.paused : null,
      });
    }, 100);
  });
  await page.goto("http://localhost:5000/screen");
  for (let i = 0; i < 100; i++) {
    const st = await (await api.get("/api/system/state")).json();
    if (st.screen.connected) break;
    await page.waitForTimeout(100);
  }
  console.log("--- connected, issuing commands");
  await cmd("visual", "setMuted", { value: false });
  await cmd("visual", "setVolume", { value: 80 });
  await cmd("visual", "setSource", {
    source: { kind: "localVideo", assetId: video.id },
    autoplay: true,
  });
  // mimic expect.poll on !paused
  for (let i = 0; i < 100; i++) {
    const playing = await page
      .locator("video")
      .evaluate((e) => !e.paused)
      .catch(() => false);
    if (playing) {
      console.log("poll saw playing at iteration", i);
      break;
    }
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(1500);
  const h = await page.evaluate(() => ({
    hist: window.__hist.slice(-45),
    gestures: window.__gestures,
  }));
  console.log("gestures:", JSON.stringify(h.gestures));
  console.log(
    "hist:",
    h.hist
      .map(
        (x) =>
          `${x.u ? "U" : "-"}${x.m === null ? "?" : x.m ? "M" : "a"}${x.p === null ? "?" : x.p ? "P" : "r"}`,
      )
      .join(" "),
  );
  await browser.close();
  await api.dispose();
})();
