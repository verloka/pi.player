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
