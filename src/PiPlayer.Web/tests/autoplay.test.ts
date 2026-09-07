import { beforeEach, describe, expect, it, vi } from "vitest";
import { Channel, VisualSource } from "../src/app/core/contracts";
import { HtmlMediaAdapter } from "../src/app/screen/adapters/html-media";
import { autoplayGate } from "../src/app/screen/autoplay";

const source: VisualSource = { kind: "localVideo", assetId: "a" };
const audible = (): Channel => ({
  source,
  playback: { loop: false, muted: false, volume: 80 },
  transport: "playing",
  playbackGeneration: 1,
  startPositionSeconds: 0,
});

describe("autoplay gate", () => {
  beforeEach(() => {
    autoplayGate.reset();
    // jsdom has no media stack: drive the gate directly instead of probing.
    autoplayGate.probeUrl = null;
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  it("unlocks itself with no gesture once the browser starts permitting sound", async () => {
    // The Raspberry Pi screen has no input devices, so the gate must not depend on a human.
    autoplayGate.probeUrl = "/media/silence.wav";
    vi.useFakeTimers();
    let permitted = false;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      if (!permitted)
        return Promise.reject(new DOMException("blocked", "NotAllowedError"));
      Object.defineProperty(this, "paused", {
        value: false,
        configurable: true,
      });
      return Promise.resolve();
    });
    try {
      const resume = vi.fn();
      autoplayGate.require(resume);
      await vi.advanceTimersByTimeAsync(100);
      expect(autoplayGate.blocked).toBe(true);
      expect(resume).not.toHaveBeenCalled();

      permitted = true;
      await vi.advanceTimersByTimeAsync(5100);
      expect(autoplayGate.unlocked).toBe(true);
      expect(resume).toHaveBeenCalledOnce();
      expect(autoplayGate.blocked).toBe(false);
    } finally {
      vi.useRealTimers();
      autoplayGate.probeUrl = null;
    }
  });

  it("reports blocked only while a channel waits and clears on a real gesture", () => {
    const seen: boolean[] = [];
    autoplayGate.watch((blocked) => seen.push(blocked));
    const resume = vi.fn();
    autoplayGate.require(resume);
    expect(autoplayGate.blocked).toBe(true);
    document.dispatchEvent(new Event("pointerdown"));
    expect(resume).toHaveBeenCalledOnce();
    expect(autoplayGate.unlocked).toBe(true);
    expect(seen).toEqual([false, true, false]);
    const later = vi.fn();
    autoplayGate.require(later);
    expect(later).toHaveBeenCalledOnce();
    expect(autoplayGate.blocked).toBe(false);
  });

  it("keeps the picture by falling back to muted playback and restores sound after the gesture", async () => {
    const element = document.createElement("video");
    element.src = "/media/videos/a";
    let allowed = false;
    vi.spyOn(element, "play").mockImplementation(() => {
      if (!allowed && !element.muted)
        return Promise.reject(new DOMException("blocked", "NotAllowedError"));
      Object.defineProperty(element, "paused", {
        value: false,
        configurable: true,
      });
      return Promise.resolve();
    });
    const adapter = new HtmlMediaAdapter(source, element, vi.fn());
    await adapter.apply(audible(), null);
    expect(element.muted).toBe(true);
    expect(adapter.observation().status).not.toBe("blocked");
    expect(adapter.observation().error?.code).toBe("autoplayMuted");
    expect(autoplayGate.blocked).toBe(true);

    allowed = true;
    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(element.muted).toBe(false);
    expect(element.volume).toBeCloseTo(0.8);
    expect(adapter.observation().error).toBeNull();
    adapter.dispose();
  });

  it("stays blocked when even muted playback is refused", async () => {
    const element = document.createElement("video");
    element.src = "/media/videos/a";
    vi.spyOn(element, "play").mockRejectedValue(
      new DOMException("blocked", "NotAllowedError"),
    );
    const adapter = new HtmlMediaAdapter(source, element, vi.fn());
    await adapter.apply(audible(), null);
    expect(adapter.observation().status).toBe("blocked");
    expect(adapter.observation().error?.code).toBe("autoplayBlocked");
    expect(autoplayGate.blocked).toBe(true);
    adapter.dispose();
    expect(autoplayGate.blocked).toBe(false);
  });
});
