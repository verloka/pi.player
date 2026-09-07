import { beforeEach, describe, expect, it, vi } from "vitest";
import { HtmlMediaAdapter } from "../src/app/screen/adapters/html-media";
import { Channel } from "../src/app/core/contracts";
const channel = (): Channel => ({
  source: { kind: "localVideo", assetId: "a" },
  playback: { loop: false, muted: true, volume: 70 },
  transport: "playing",
  playbackGeneration: 1,
  startPositionSeconds: 0,
});
describe("HTML media adapter", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });
  it("reports rejected autoplay and applies mute before play", async () => {
    const element = document.createElement("video");
    element.src = "/media/a";
    const play = vi.spyOn(element, "play").mockImplementation(() => {
      expect(element.muted).toBe(true);
      expect(element.volume).toBe(0.7);
      return Promise.reject(new DOMException("blocked", "NotAllowedError"));
    });
    const adapter = new HtmlMediaAdapter(channel().source!, element, vi.fn());
    await adapter.apply(channel(), null);
    expect(play).toHaveBeenCalledOnce();
    expect(adapter.observation().status).toBe("blocked");
    expect(adapter.observation().error?.code).toBe("autoplayBlocked");
    adapter.dispose();
  });
  it("live audio disables seek/loop and stop releases network resource", async () => {
    const source = {
      kind: "remoteAudioUrl" as const,
      url: "https://example.org/stream",
      streamMode: "live" as const,
    };
    const element = document.createElement("audio");
    element.src = source.url;
    const adapter = new HtmlMediaAdapter(source, element, vi.fn());
    await adapter.apply({ ...channel(), source, transport: "stopped" }, null);
    expect(element.hasAttribute("src")).toBe(false);
    expect(adapter.observation().capabilities.isLive).toBe(true);
    expect(adapter.observation().capabilities.canSeek).toBe(false);
    adapter.dispose();
  });
});
