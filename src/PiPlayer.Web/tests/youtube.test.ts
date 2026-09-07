import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Channel, VisualSource } from "../src/app/core/contracts";
import { YouTubeAdapter } from "../src/app/screen/adapters/youtube";
import { autoplayGate } from "../src/app/screen/autoplay";
type Api = NonNullable<typeof window.YT>;
type Player = InstanceType<Api["Player"]>;
type Options = ConstructorParameters<Api["Player"]>[1];
class FakePlayer implements Player {
  static last: FakePlayer;
  state = 5;
  position = 0;
  volume = 100;
  muted = false;
  rate = 1;
  index = 0;
  playlist: string[] | undefined;
  frame = document.createElement("iframe");
  destroyed = false;
  cueVideoById = vi.fn();
  cuePlaylist = vi.fn(
    (options: { list: string; listType: "playlist"; index?: number }) => {
      this.index = options.index ?? 0;
    },
  );
  playVideo = vi.fn();
  unloadModule = vi.fn();
  setOption = vi.fn();
  getOptions = vi.fn(() => ["captions", "cc"]);
  pauseVideo = vi.fn();
  stopVideo = vi.fn();
  playVideoAt = vi.fn();
  setLoop = vi.fn();
  // Real YouTube reports the cued state a moment after onReady; loading is not done until then.
  static autoCue = true;
  constructor(
    _element: HTMLElement,
    public options: Options,
  ) {
    FakePlayer.last = this;
    queueMicrotask(() => {
      options.events.onReady();
      if (FakePlayer.autoCue) this.emit(5);
    });
  }
  seekTo(seconds: number): void {
    this.position = seconds;
  }
  mute(): void {
    this.muted = true;
  }
  unMute(): void {
    this.muted = false;
  }
  isMuted(): boolean {
    return this.muted;
  }
  setVolume(value: number): void {
    this.volume = value;
  }
  getVolume(): number {
    return this.volume;
  }
  setPlaybackRate(value: number): void {
    this.rate = value;
  }
  getPlaybackRate(): number {
    return this.rate;
  }
  // The real API answers undefined until it has the video data.
  rates: number[] | undefined = [1, 2];
  getAvailablePlaybackRates(): number[] | undefined {
    return this.rates;
  }
  getCurrentTime(): number {
    return this.position;
  }
  getDuration(): number {
    return 120;
  }
  getPlayerState(): number {
    return this.state;
  }
  getPlaylist(): string[] | undefined {
    return this.playlist;
  }
  getPlaylistIndex(): number {
    return this.index;
  }
  getVideoUrl(): string {
    return "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  }
  getIframe(): HTMLIFrameElement {
    return this.frame;
  }
  destroy(): void {
    this.destroyed = true;
  }
  emit(state: number): void {
    this.state = state;
    this.options.events.onStateChange({ data: state });
  }
}
const source: VisualSource = { kind: "youtubeVideo", videoId: "dQw4w9WgXcQ" };
const channel = (s: VisualSource = source): Channel => ({
  source: s,
  playback: { loop: false, muted: true, volume: 70 },
  transport: "playing",
  playbackGeneration: 1,
  startPositionSeconds: 0,
});
describe("official YouTube adapter with SDK double (not a live provider test)", () => {
  let adapter: YouTubeAdapter;
  beforeEach(() => {
    window.YT = { Player: FakePlayer };
    FakePlayer.autoCue = true;
    autoplayGate.reset();
    // jsdom has no media stack: drive the gate directly instead of probing.
    autoplayGate.probeUrl = null;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });
  afterEach(() => {
    adapter?.dispose();
    delete window.YT;
  });
  it("waits for observed playing and handles autoplayBlocked", async () => {
    adapter = new YouTubeAdapter(
      source,
      document.createElement("div"),
      vi.fn(),
      false,
    );
    await adapter.load();
    await adapter.apply(channel(), 0, null);
    expect(adapter.observation().status).toBe("ready");
    expect(FakePlayer.last.playVideo).toHaveBeenCalledOnce();
    expect(FakePlayer.last.muted).toBe(true);
    FakePlayer.last.options.events.onAutoplayBlocked();
    expect(adapter.observation().status).toBe("blocked");
    expect(adapter.observation().error?.code).toBe("autoplayBlocked");
    FakePlayer.last.emit(1);
    expect(adapter.observation().status).toBe("playing");
    expect(adapter.observation().error).toBeNull();
  });
  it("does not issue seek or play until the cued video has landed", async () => {
    // Commanding a player that has only just become ready answers with "invalid parameter" and the
    // video stays stopped, so load() must wait for the cue rather than for onReady.
    FakePlayer.autoCue = false;
    adapter = new YouTubeAdapter(
      source,
      document.createElement("div"),
      vi.fn(),
      false,
    );
    let loaded = false;
    const loading = adapter.load().then(() => (loaded = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(FakePlayer.last.cueVideoById).toHaveBeenCalledOnce();
    expect(loaded).toBe(false);
    FakePlayer.last.emit(5);
    await loading;
    expect(loaded).toBe(true);
    await adapter.apply(channel(), 0, null);
    expect(FakePlayer.last.playVideo).toHaveBeenCalledOnce();
  });
  it("starts even before YouTube reports its available playback rates", async () => {
    adapter = new YouTubeAdapter(
      source,
      document.createElement("div"),
      vi.fn(),
      false,
    );
    await adapter.load();
    FakePlayer.last.rates = undefined;
    // This used to throw and surface as reconciliationFailed, leaving the video permanently stopped.
    await adapter.apply(channel(), 0, null);
    expect(FakePlayer.last.playVideo).toHaveBeenCalledOnce();
    expect(adapter.observation().status).not.toBe("error");
    FakePlayer.last.emit(1);
    expect(adapter.observation().status).toBe("playing");
  });
  it("keeps captions off through cueing, new videos and mid-playback reloads", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    adapter = new YouTubeAdapter(
      source,
      document.createElement("div"),
      vi.fn(),
      false,
    );
    await adapter.load();
    expect(FakePlayer.last.options.playerVars["cc_load_policy"]).toBe(0);
    expect(FakePlayer.last.unloadModule).toHaveBeenCalledWith("captions");
    expect(FakePlayer.last.unloadModule).toHaveBeenCalledWith("cc");
    // The module returns with the next video, so it is unloaded again on each new one.
    FakePlayer.last.unloadModule.mockClear();
    FakePlayer.last.emit(1);
    expect(FakePlayer.last.unloadModule).toHaveBeenCalledWith("captions");
    // It also returns a few seconds into playback, so a guard keeps unloading it.
    FakePlayer.last.unloadModule.mockClear();
    vi.advanceTimersByTime(4100);
    expect(FakePlayer.last.unloadModule).toHaveBeenCalledWith("captions");
    // A module the player does not expose is left alone.
    FakePlayer.last.getOptions.mockReturnValue([]);
    FakePlayer.last.unloadModule.mockClear();
    vi.advanceTimersByTime(2100);
    expect(FakePlayer.last.unloadModule).not.toHaveBeenCalled();
  });
  it("embeds without player chrome and never receives pointer input", async () => {
    adapter = new YouTubeAdapter(
      source,
      document.createElement("div"),
      vi.fn(),
      false,
    );
    await adapter.load();
    const vars = FakePlayer.last.options.playerVars;
    expect(vars["controls"]).toBe(0);
    expect(vars["disablekb"]).toBe(1);
    expect(vars["fs"]).toBe(0);
    expect(vars["rel"]).toBe(0);
    expect(vars["iv_load_policy"]).toBe(3);
    expect(FakePlayer.last.frame.style.pointerEvents).toBe("none");
  });
  it("falls back to muted playback when YouTube refuses audible autoplay", async () => {
    adapter = new YouTubeAdapter(
      source,
      document.createElement("div"),
      vi.fn(),
      false,
    );
    await adapter.load();
    const audible = {
      ...channel(),
      playback: { loop: false, muted: false, volume: 70 },
    };
    await adapter.apply(audible, 0, null);
    expect(FakePlayer.last.muted).toBe(false);
    FakePlayer.last.options.events.onAutoplayBlocked();
    // The picture keeps running, silently, instead of stopping on a blocked status.
    expect(FakePlayer.last.muted).toBe(true);
    expect(adapter.observation().status).not.toBe("blocked");
    expect(adapter.observation().error?.code).toBe("autoplayMuted");
    expect(FakePlayer.last.playVideo).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event("pointerdown"));
    expect(FakePlayer.last.muted).toBe(false);
    expect(FakePlayer.last.volume).toBe(70);
    expect(adapter.observation().error).toBeNull();
  });
  it("does not reload when volume changes and preserves independent mute", async () => {
    adapter = new YouTubeAdapter(
      source,
      document.createElement("div"),
      vi.fn(),
      false,
    );
    await adapter.load();
    await adapter.apply(channel(), 0, null);
    FakePlayer.last.emit(1);
    await adapter.apply(
      { ...channel(), playback: { loop: false, muted: true, volume: 15 } },
      null,
      null,
    );
    expect(FakePlayer.last.cueVideoById).toHaveBeenCalledOnce();
    expect(adapter.observation().actualVolume).toBe(15);
    expect(adapter.observation().actualMuted).toBe(true);
    expect(adapter.observation().capabilities.canRotate).toBe(false);
  });
  it("cues saved playlist index once its context becomes available", async () => {
    const playlist: VisualSource = {
      kind: "youtubePlaylist",
      playlistId: "PL1234567890",
      initialVideoId: null,
    };
    adapter = new YouTubeAdapter(
      playlist,
      document.createElement("div"),
      vi.fn(),
      false,
    );
    await adapter.load();
    await adapter.apply({ ...channel(playlist), transport: "paused" }, 12, 1);
    expect(FakePlayer.last.playVideo).not.toHaveBeenCalled();
    FakePlayer.last.playlist = ["a", "b", "c"];
    FakePlayer.last.emit(5);
    expect(FakePlayer.last.cuePlaylist).toHaveBeenLastCalledWith({
      list: "PL1234567890",
      listType: "playlist",
      index: 1,
      startSeconds: 12,
    });
    expect(FakePlayer.last.playVideo).not.toHaveBeenCalled();
  });
  it("intermediate playlist ending does not end the whole channel", async () => {
    const playlist: VisualSource = {
      kind: "youtubePlaylist",
      playlistId: "PL1234567890",
      initialVideoId: null,
    };
    adapter = new YouTubeAdapter(
      playlist,
      document.createElement("div"),
      vi.fn(),
      false,
    );
    await adapter.load();
    FakePlayer.last.playlist = ["a", "b"];
    await adapter.apply(channel(playlist), 0, null);
    FakePlayer.last.emit(0);
    expect(adapter.observation().status).toBe("buffering");
    FakePlayer.last.index = 1;
    FakePlayer.last.emit(0);
    expect(adapter.observation().status).toBe("ended");
  });
  it("ignores callbacks after disposal and pauses stale play after suspension", async () => {
    adapter = new YouTubeAdapter(
      source,
      document.createElement("div"),
      vi.fn(),
      false,
    );
    await adapter.load();
    await adapter.apply(channel(), 0, null);
    adapter.suspend();
    FakePlayer.last.emit(1);
    expect(FakePlayer.last.pauseVideo).toHaveBeenCalled();
    adapter.updateIntent({
      ...channel(),
      transport: "paused",
      playback: { loop: true, muted: true, volume: 70 },
    });
    FakePlayer.last.playVideo.mockClear();
    FakePlayer.last.emit(0);
    expect(FakePlayer.last.playVideo).not.toHaveBeenCalled();
    adapter.dispose();
    FakePlayer.last.emit(1);
    expect(FakePlayer.last.destroyed).toBe(true);
    expect(adapter.observation().status).not.toBe("playing");
  });
});
