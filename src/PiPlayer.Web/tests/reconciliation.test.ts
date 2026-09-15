import { describe, expect, it, vi } from "vitest";
import {
  defaultCircle,
  defaultTransform,
  StateEnvelope,
  Source,
} from "../src/app/core/contracts";
import { ChannelRenderer } from "../src/app/screen/reconciliation";
import { capabilities, PlayerAdapter } from "../src/app/screen/adapters/player";
import { youtubeError } from "../src/app/screen/adapters/youtube";
import { VisualStage } from "../src/app/screen/visual-stage";
function state(): StateEnvelope {
  return {
    serverInstanceId: "server",
    revision: 1,
    desired: {
      visual: {
        source: { kind: "localVideo", assetId: "a" },
        visible: true,
        transform: defaultTransform,
        playback: { loop: false, muted: true, volume: 70, playbackRate: 1 },
        transport: "playing",
        playbackGeneration: 1,
        startPositionSeconds: 0,
        startPlaylistIndex: null,
      },
      audio: {
        source: null,
        playback: { loop: false, muted: false, volume: 50 },
        transport: "stopped",
        playbackGeneration: 0,
        startPositionSeconds: 0,
      },
      background: { color: "#000000" },
      circle: defaultCircle,
    },
    observed: {},
    screen: {
      connected: true,
      stale: false,
      descriptor: null,
      lastHeartbeatAgeSeconds: 0,
    },
    persistence: "saved",
    cause: { commandId: null, reason: "startup" },
    telemetrySequence: 0,
    checkpoints: { visual: null, audio: null },
    warnings: [],
    enableExperimentalYouTubeRotation: false,
  };
}
function adapter(source: Source): PlayerAdapter {
  return {
    source,
    load: vi.fn().mockResolvedValue(undefined),
    apply: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    suspend: vi.fn(),
    observation: () => ({
      status: "playing",
      positionSeconds: 12,
      durationSeconds: 100,
      seekable: true,
      actualMuted: true,
      actualVolume: 70,
      actualPlaybackRate: 1,
      currentVideoId: null,
      playlistIndex: null,
      playlistLength: null,
      error: null,
      capabilities: capabilities({ canSeek: true }),
    }),
  };
}
describe("renderer lifecycle", () => {
  it("empty channel acknowledges a new stop generation without creating media", async () => {
    const initial = state();
    initial.desired.visual.source = null;
    initial.desired.visual.transport = "stopped";
    const factory = vi.fn();
    const report = vi.fn();
    const renderer = new ChannelRenderer("visual", factory, report);
    renderer.setActive(true);
    await renderer.reconcile(initial);
    const next = structuredClone(initial);
    next.revision++;
    next.desired.visual.playbackGeneration++;
    await renderer.reconcile(next);
    expect(factory).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "idle",
        playbackGeneration: 2,
        lastAppliedRevision: 2,
      }),
    );
  });
  it("ignores a checkpoint for a different source and preserves an ended checkpoint", async () => {
    const initial = state();
    initial.desired.visual.transport = "paused";
    initial.checkpoints.visual = {
      sourceFingerprint: "localVideo:other",
      playbackGeneration: 1,
      positionSeconds: 100,
      durationSeconds: 100,
      ended: true,
      playlistIndex: null,
      currentVideoId: null,
      capturedAtUtc: "",
    };
    const a = adapter(initial.desired.visual.source!);
    const report = vi.fn();
    const renderer = new ChannelRenderer("visual", () => a, report);
    renderer.setActive(true);
    await renderer.reconcile(initial);
    expect(a.apply).toHaveBeenLastCalledWith(initial.desired.visual, 0, null);
    renderer.dispose();
    initial.checkpoints.visual.sourceFingerprint = "localVideo:a";
    const ended = adapter(initial.desired.visual.source!);
    const base = ended.observation();
    ended.observation = () => ({
      ...base,
      status: "paused",
      positionSeconds: 100,
    });
    const restored = new ChannelRenderer("visual", () => ended, report);
    restored.setActive(true);
    await restored.reconcile(initial);
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "ended" }),
    );
  });
  it("geometry, mute, volume and reconnect never reload or re-seek media", async () => {
    const a = adapter(state().desired.visual.source!);
    const factory = vi.fn(() => a);
    const renderer = new ChannelRenderer("visual", factory, vi.fn());
    renderer.setActive(true);
    const first = state();
    await renderer.reconcile(first);
    const next = structuredClone(first);
    next.revision++;
    next.desired.visual.transform = {
      ...defaultTransform,
      x: 100,
      y: 20,
      rotation: 33,
    };
    next.desired.visual.playback.volume = 30;
    await renderer.reconcile(next);
    await renderer.reconcile(next);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(a.load).toHaveBeenCalledTimes(1);
    expect(a.apply).toHaveBeenLastCalledWith(next.desired.visual, null, null);
    expect(a.dispose).not.toHaveBeenCalled();
  });
  it("late source A never overrides source B", async () => {
    let finish!: () => void;
    const a = adapter(state().desired.visual.source!),
      b = adapter({ kind: "localVideo", assetId: "b" });
    a.load = () => new Promise<void>((resolve) => (finish = resolve));
    const factory = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b);
    const renderer = new ChannelRenderer("visual", factory, vi.fn());
    renderer.setActive(true);
    const loading = renderer.reconcile(state());
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    const next = state();
    next.revision = 2;
    next.desired.visual.source = b.source as typeof next.desired.visual.source;
    next.desired.visual.playbackGeneration = 2;
    await renderer.reconcile(next);
    finish();
    await loading;
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(a.apply).not.toHaveBeenCalled();
    expect(b.apply).toHaveBeenCalledOnce();
  });
  it("reload restores matching checkpoint and explicit seek overrides it", async () => {
    const s = state();
    s.checkpoints.visual = {
      sourceFingerprint: "localVideo:a",
      playbackGeneration: 1,
      positionSeconds: 12,
      durationSeconds: 100,
      ended: false,
      playlistIndex: null,
      currentVideoId: null,
      capturedAtUtc: "",
    };
    const a = adapter(s.desired.visual.source!);
    const renderer = new ChannelRenderer("visual", () => a, vi.fn());
    renderer.setActive(true);
    await renderer.reconcile(s);
    expect(a.apply).toHaveBeenLastCalledWith(s.desired.visual, 12, null);
    s.revision++;
    s.desired.visual.playbackGeneration++;
    s.desired.visual.startPositionSeconds = 44;
    await renderer.reconcile(s);
    expect(a.apply).toHaveBeenLastCalledWith(s.desired.visual, 44, null);
  });
  it("lease suspension preserves intent and stops adapters", async () => {
    const a = adapter(state().desired.visual.source!);
    const renderer = new ChannelRenderer("visual", () => a, vi.fn());
    renderer.setActive(true);
    await renderer.reconcile(state());
    renderer.setActive(false);
    expect(a.suspend).toHaveBeenCalledOnce();
    renderer.dispose();
    expect(a.dispose).toHaveBeenCalledOnce();
  });
  it("distinguishes missing Referer from embedding restrictions", () => {
    expect(youtubeError(153).message).toContain("Referer");
    expect(youtubeError(101).message).toContain("embedding");
  });
});

describe("visual replacement lifecycle", () => {
  function setup(duration = 0) {
    const root = document.createElement("div");
    const players = new Map<
      string,
      {
        player: PlayerAdapter;
        video: HTMLVideoElement;
        ready: number;
        seeking: boolean;
      }
    >();
    const report = vi.fn();
    const stage = new VisualStage(
      root,
      (source, host) => {
        const player = adapter(source);
        const video = document.createElement("video");
        const entry = {
          player,
          video,
          ready: players.size ? 1 : 2,
          seeking: false,
        };
        Object.defineProperties(video, {
          readyState: { get: () => entry.ready },
          seeking: { get: () => entry.seeking },
        });
        host.append(video);
        players.set(JSON.stringify(source), entry);
        return player;
      },
      duration,
    );
    const renderer = new ChannelRenderer(
      "visual",
      (source, changed) => stage.create(source, changed),
      report,
      stage,
    );
    renderer.setActive(true);
    const select = (s: StateEnvelope) => {
      stage.update(s.desired.visual);
      return renderer.reconcile(s);
    };
    const entry = (s: StateEnvelope) =>
      players.get(JSON.stringify(s.desired.visual.source))!;
    const next = (id: string, generation = 2) => {
      const s = state();
      s.revision = generation;
      s.desired.visual.playbackGeneration = generation;
      s.desired.visual.source = { kind: "localVideo", assetId: id };
      s.desired.visual.transform = { ...defaultTransform, x: generation * 100 };
      s.desired.visual.playback.muted = false;
      return s;
    };
    return { root, stage, renderer, select, entry, next, report };
  }

  it("retains the old picture and geometry until a frame at the requested position is decoded", async () => {
    const h = setup();
    const first = state();
    try {
      await h.select(first);
      const a = h.entry(first);
      const second = h.next("b");
      const switching = h.select(second);
      await vi.waitFor(() =>
        expect(h.root.querySelectorAll("video")).toHaveLength(2),
      );
      const b = h.entry(second);
      expect(a.player.dispose).not.toHaveBeenCalled();
      expect(a.player.suspend).not.toHaveBeenCalled();
      expect(
        h.root.querySelector<HTMLElement>(".visual-layer")!.style.left,
      ).toBe("0px");
      expect(h.root.lastElementChild!.getAttribute("style")).toContain(
        "opacity: 0",
      );
      expect(b.player.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          playback: expect.objectContaining({ muted: true }),
        }),
        0,
        null,
      );
      // Metadata alone and a frame belonging to the pre-seek position are insufficient.
      b.ready = 2;
      b.seeking = true;
      b.video.dispatchEvent(new Event("loadeddata"));
      await Promise.resolve();
      expect(a.player.dispose).not.toHaveBeenCalled();
      b.seeking = false;
      b.video.dispatchEvent(new Event("seeked"));
      await switching;
      expect(a.player.suspend).toHaveBeenCalledOnce();
      expect(a.player.dispose).toHaveBeenCalledOnce();
      expect(b.player.apply).toHaveBeenLastCalledWith(
        second.desired.visual,
        null,
        null,
      );
      expect(h.root.querySelectorAll("video")).toHaveLength(1);
      expect(
        h.root.querySelector<HTMLElement>(".visual-layer")!.style.left,
      ).toBe("200px");
      expect(h.report).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sourceFingerprint: "localVideo:b",
          lastAppliedRevision: 2,
        }),
      );
    } finally {
      h.renderer.dispose();
    }
  });

  it("rapid selection cancels the pending reveal and clear releases both layers", async () => {
    const h = setup();
    const first = state();
    try {
      await h.select(first);
      const bState = h.next("b");
      const bLoad = h.select(bState);
      await vi.waitFor(() =>
        expect(h.root.querySelectorAll("video")).toHaveLength(2),
      );
      const b = h.entry(bState);
      const cState = h.next("c", 3);
      const cLoad = h.select(cState);
      await vi.waitFor(() => expect(b.player.dispose).toHaveBeenCalledOnce());
      b.ready = 2;
      b.video.dispatchEvent(new Event("loadeddata"));
      await bLoad;
      expect(h.entry(first).player.dispose).not.toHaveBeenCalled();
      expect(h.root.querySelectorAll("video")).toHaveLength(2);
      const clear = h.next("unused", 4);
      clear.desired.visual.source = null;
      clear.desired.visual.transport = "stopped";
      await h.select(clear);
      await cLoad;
      expect(h.root.childElementCount).toBe(0);
      expect(h.entry(first).player.dispose).toHaveBeenCalledOnce();
      expect(h.entry(cState).player.dispose).toHaveBeenCalledOnce();
    } finally {
      h.renderer.dispose();
    }
  });

  it("a decode error leaves the old video displayed, and lease loss suspends it too", async () => {
    const h = setup();
    const first = state();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await h.select(first);
      const second = h.next("b");
      const switching = h.select(second);
      await vi.waitFor(() =>
        expect(h.root.querySelectorAll("video")).toHaveLength(2),
      );
      const b = h.entry(second);
      const observed = b.player.observation();
      b.player.observation = () => ({
        ...observed,
        status: "error",
        error: {
          code: "decodeError",
          message: "Bad video",
          retryable: false,
          providerCode: null,
        },
      });
      b.video.dispatchEvent(new Event("error"));
      await switching;
      expect(h.entry(first).player.dispose).not.toHaveBeenCalled();
      expect(h.root.firstElementChild!.getAttribute("style")).toContain(
        "opacity: 1",
      );
      expect(h.report).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: "error",
          error: expect.objectContaining({ code: "decodeError" }),
        }),
      );
      h.renderer.setActive(false);
      expect(h.entry(first).player.suspend).toHaveBeenCalled();
      expect(b.player.suspend).toHaveBeenCalled();
    } finally {
      h.renderer.dispose();
    }
  });

  it("interrupting a fade retains the new picture and never accumulates a third player", async () => {
    const animate = vi.fn(() => ({
      finished: new Promise(() => {}),
      cancel: vi.fn(),
    }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    const h = setup(500);
    const first = state();
    try {
      await h.select(first);
      const second = h.next("b");
      const switching = h.select(second);
      await vi.waitFor(() =>
        expect(h.root.querySelectorAll("video")).toHaveLength(2),
      );
      const b = h.entry(second);
      b.ready = 2;
      b.video.dispatchEvent(new Event("loadeddata"));
      await switching;
      expect(animate).toHaveBeenCalledTimes(2);
      expect(h.entry(first).player.dispose).not.toHaveBeenCalled();
      const third = h.next("c", 3);
      const loading = h.select(third);
      await vi.waitFor(() =>
        expect(h.entry(first).player.dispose).toHaveBeenCalledOnce(),
      );
      expect(b.player.dispose).not.toHaveBeenCalled();
      expect(h.root.querySelectorAll("video")).toHaveLength(2);
      h.renderer.dispose();
      await loading;
      expect(h.root.childElementCount).toBe(0);
    } finally {
      h.renderer.dispose();
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });
});
