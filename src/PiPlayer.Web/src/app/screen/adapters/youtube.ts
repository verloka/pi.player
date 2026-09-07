import {
  Channel,
  Observed,
  PlaybackError,
  VisualSource,
} from "../../core/contracts";
import { autoplayGate } from "../autoplay";
import { capabilities, playbackError, PlayerAdapter } from "./player";

interface YouTubePlayer {
  cueVideoById(options: { videoId: string; startSeconds?: number }): void;
  cuePlaylist(options: {
    list: string;
    listType: "playlist";
    index?: number;
    startSeconds?: number;
  }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideoAt(index: number): void;
  mute(): void;
  unMute(): void;
  setVolume(value: number): void;
  getVolume(): number;
  isMuted(): boolean;
  setPlaybackRate(value: number): void;
  getPlaybackRate(): number | undefined;
  getAvailablePlaybackRates(): number[] | undefined;
  setLoop(loop: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getPlaylist(): string[] | undefined;
  getPlaylistIndex(): number;
  getVideoUrl(): string;
  getIframe(): HTMLIFrameElement;
  // Caption controls. Absent on some player builds, so every call site guards them.
  unloadModule?(name: string): void;
  setOption?(module: string, option: string, value: unknown): void;
  getOption?(module: string, option: string): unknown;
  getOptions?(): string[] | undefined;
  destroy(): void;
}
interface YouTubeApi {
  Player: new (
    element: HTMLElement,
    options: {
      width: string;
      height: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: () => void;
        onStateChange: (e: { data: number }) => void;
        onError: (e: { data: number }) => void;
        onAutoplayBlocked: () => void;
        onPlaybackRateChange: () => void;
      };
    },
  ) => YouTubePlayer;
}
declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}
let loading: Promise<YouTubeApi> | null = null;
export function loadYouTube(): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      loading = null;
      reject(new Error("providerUnavailable"));
    };
    const timer = setTimeout(fail, 15000);
    script.onerror = fail;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (window.YT) resolve(window.YT);
      else fail();
    };
    document.head.append(script);
  });
  return loading;
}
export function youtubeError(code: number): PlaybackError {
  const messages: Record<number, string> = {
    2: "Invalid YouTube parameters.",
    5: "YouTube HTML5 player error.",
    100: "The video is deleted, private or unavailable.",
    101: "The owner disallowed embedding.",
    150: "The owner disallowed embedding.",
    153: "YouTube received no Referer or client identity. Check the origin and the Referrer-Policy.",
  };
  return playbackError(
    "youtubeProviderError",
    messages[code] ?? "YouTube error.",
    false,
    code,
  );
}
export class YouTubeAdapter implements PlayerAdapter {
  private player: YouTubePlayer | null = null;
  private disposed = false;
  private suspended = false;
  private status: Observed["status"] = "loading";
  private error: PlaybackError | null = null;
  private desired: Channel | null = null;
  private playTimer?: ReturnType<typeof setTimeout>;
  private captionGuard?: ReturnType<typeof setInterval>;
  private readyCancel?: () => void;
  private disposeLoad?: () => void;
  private indexApplied: number | null = null;
  private startVideoPending = true;
  private policyMuted = false;
  private unblock?: ReturnType<typeof setTimeout>;
  private resume = () => this.restoreSound();
  private pendingPlaylist: {
    index: number | null;
    position: number | null;
  } | null = null;
  constructor(
    public readonly source: Extract<
      VisualSource,
      { kind: "youtubeVideo" | "youtubePlaylist" }
    >,
    private host: HTMLElement,
    private changed: () => void,
    private rotationEnabled: boolean,
  ) {}
  updateIntent(channel: Channel): void {
    this.desired = channel;
    if (channel.transport !== "playing") {
      clearTimeout(this.playTimer);
      this.player?.pauseVideo();
    }
  }
  async load(): Promise<void> {
    const api = await loadYouTube();
    if (this.disposed) return;
    await new Promise<void>((resolve, reject) => {
      const target = document.createElement("div");
      this.host.append(target);
      const finish = (error?: Error) => {
        if (!this.readyCancel) return;
        clearTimeout(timer);
        this.readyCancel = undefined;
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("providerTimeout")),
        20000,
      );
      this.readyCancel = () => finish();
      this.disposeLoad = () => finish(new Error("disposed"));
      this.player = new api.Player(target, {
        width: "100%",
        height: "100%",
        playerVars: {
          enablejsapi: 1,
          origin: window.location.origin,
          playsinline: 1,
          // A signage screen shows the picture only: no control bar, no keyboard, no end-screen links.
          controls: 0,
          disablekb: 1,
          // Captions must never appear on a signage screen.
          cc_load_policy: 0,
          fs: 0,
          rel: 0,
          modestbranding: 1,
          iv_load_policy: 3,
          autoplay: 0,
        },
        events: {
          onReady: () => {
            if (this.disposed || !this.player) return;
            this.player.getIframe().allow =
              "autoplay; encrypted-media; picture-in-picture; fullscreen";
            this.player.getIframe().referrerPolicy =
              "strict-origin-when-cross-origin";
            Object.assign(this.player.getIframe().style, {
              width: "100%",
              height: "100%",
              border: "0",
              display: "block",
              pointerEvents: "none",
            });
            this.player.mute();
            this.hideCaptions();
            this.captionGuard ??= setInterval(() => this.hideCaptions(), 2000);
            if (this.source.kind === "youtubeVideo")
              this.player.cueVideoById({ videoId: this.source.videoId });
            else
              this.player.cuePlaylist({
                listType: "playlist",
                list: this.source.playlistId,
              });
            this.status = "ready";
            this.changed();
          },
          onStateChange: (e) => this.stateChange(e.data),
          onError: (e) => {
            if (this.disposed) return;
            this.error = youtubeError(e.data);
            this.status = "error";
            clearTimeout(this.playTimer);
            // Stop waiting for a cue that will never land, and let the reason reach the panel.
            this.readyCancel?.();
            this.changed();
          },
          onAutoplayBlocked: () => {
            if (this.disposed) return;
            if (this.retryMuted()) return;
            this.error = playbackError(
              "autoplayBlocked",
              "Chromium blocked YouTube autoplay. Check the dedicated kiosk profile.",
            );
            this.status = "blocked";
            clearTimeout(this.playTimer);
            autoplayGate.require(this.resume);
            this.scheduleUnblock();
            this.changed();
          },
          onPlaybackRateChange: () => this.changed(),
        },
      });
    });
  }
  /**
   * A signage screen must never show subtitles. cc_load_policy only sets the initial state, and
   * clearing the caption track does not stick: measured against the live provider, YouTube reloads the
   * captions module and reselects a track a few seconds into playback. Unloading the module does stick,
   * but only until the next reload, so this runs on every state change and on a slow guard timer.
   */
  private hideCaptions(): void {
    const player = this.player;
    if (!player || this.disposed) return;
    try {
      const modules = player.getOptions?.() ?? [];
      for (const module of ["captions", "cc"]) {
        if (!modules.includes(module)) continue;
        player.setOption?.(module, "track", {});
        player.unloadModule?.(module);
      }
    } catch {
      /* this player build does not expose the module; cc_load_policy still applies */
    }
  }
  private stateChange(state: number): void {
    if (this.disposed || !this.player) return;
    // YouTube answers seek/play with "invalid parameter" until the cued video has actually been
    // accepted, so loading is not finished at onReady: it finishes when the cue lands.
    if (this.readyCancel && (state === 5 || state === 3 || state === 1))
      this.readyCancel();
    // The captions module comes back with every new video, including the next playlist item.
    if (state === 5 || state === 1 || state === -1) this.hideCaptions();
    if (
      this.pendingPlaylist &&
      this.player.getPlaylist()?.length &&
      this.desired
    ) {
      const pending = this.pendingPlaylist;
      this.pendingPlaylist = null;
      void this.apply(this.desired, pending.position, pending.index);
    }
    if (
      state === 1 &&
      (this.suspended ||
        this.desired?.transport !== "playing" ||
        document.visibilityState !== "visible")
    ) {
      this.player.pauseVideo();
      return;
    }
    if (
      state === 0 &&
      this.desired?.playback.loop &&
      this.desired.transport === "playing" &&
      this.source.kind === "youtubeVideo" &&
      !this.suspended
    ) {
      this.player.seekTo(0, true);
      this.player.playVideo();
      return;
    }
    if (
      state === 0 &&
      this.source.kind === "youtubePlaylist" &&
      this.desired?.transport === "playing" &&
      (this.desired.playback.loop ||
        this.player.getPlaylistIndex() <
          (this.player.getPlaylist()?.length ?? 0) - 1)
    ) {
      this.status = "buffering";
      this.changed();
      return;
    }
    const status: Record<number, Observed["status"]> = {
      "-1": "loading",
      0: "ended",
      1: "playing",
      2: "paused",
      3: "buffering",
      5: "ready",
    };
    this.status =
      this.desired?.transport === "stopped" &&
      (state === 2 || state === 5 || state === -1)
        ? "stopped"
        : (status[state] ?? "loading");
    if (state === 1) {
      clearTimeout(this.playTimer);
      this.cancelUnblock();
      this.error = null;
    }
    this.changed();
    // Same refusal as a local file: unmuting without user activation stops the embed.
    if (
      state === 2 &&
      this.desired?.transport === "playing" &&
      !this.suspended &&
      !this.player.isMuted() &&
      document.visibilityState === "visible"
    )
      this.retryMuted();
  }
  async apply(
    channel: Channel,
    position: number | null,
    playlistIndex: number | null,
  ): Promise<void> {
    if (this.disposed || !this.player) return;
    this.desired = channel;
    this.suspended = false;
    const player = this.player;
    if (this.policyMuted && autoplayGate.unlocked) this.policyMuted = false;
    player.setVolume(channel.playback.volume);
    channel.playback.muted || this.policyMuted
      ? player.mute()
      : player.unMute();
    player.setLoop(channel.playback.loop);
    if ("playbackRate" in channel.playback) {
      const rate = Number(channel.playback.playbackRate);
      // YouTube only knows its rate list once it has the video data: before that the call returns
      // undefined. Treat that as "not answered yet" instead of failing the whole reconciliation.
      const rates = player.getAvailablePlaybackRates?.();
      if (rates?.length) {
        if (!rates.includes(rate)) {
          this.error = playbackError(
            "capabilityNotSupported",
            "YouTube does not support the selected speed.",
          );
          this.status = "blocked";
          player.pauseVideo();
          this.changed();
          return;
        }
        if (player.getPlaybackRate?.() !== rate) player.setPlaybackRate(rate);
      } else if (rate !== 1) {
        // Ask now, verify on the next apply once the list is known.
        player.setPlaybackRate(rate);
      }
    }
    if (channel.transport === "stopped") {
      clearTimeout(this.playTimer);
      player.pauseVideo();
      player.seekTo(0, true);
      this.status = "stopped";
      this.error = null;
      this.changed();
      return;
    }
    if (this.source.kind === "youtubePlaylist") {
      const playlist = player.getPlaylist();
      if (!playlist?.length) {
        this.pendingPlaylist = { index: playlistIndex, position };
        return;
      }
      let index = playlistIndex;
      if (
        index === null &&
        this.startVideoPending &&
        this.source.initialVideoId &&
        playlist?.length
      )
        index = playlist.indexOf(this.source.initialVideoId);
      if (playlist?.length) {
        this.startVideoPending = false;
        if (index !== null && index !== this.indexApplied) {
          if (index < 0 || index >= playlist.length) {
            this.error = playbackError(
              "playlistItemUnavailable",
              "The saved playlist item is unavailable; the first one is used.",
            );
            index = 0;
          }
          // Cue rather than playVideoAt when paused: no brief unwanted playback.
          this.indexApplied = index;
          player.cuePlaylist({
            list: this.source.playlistId,
            listType: "playlist",
            index,
            startSeconds: position ?? 0,
          });
        }
      }
    }
    if (position !== null) player.seekTo(position, true);
    if (channel.transport === "paused") {
      clearTimeout(this.playTimer);
      player.pauseVideo();
      return;
    }
    if (document.visibilityState !== "visible") {
      this.suspend();
      return;
    }
    if (player.getPlayerState() !== 1 && player.getPlayerState() !== 3)
      this.attemptPlay();
  }
  private attemptPlay(): void {
    if (this.disposed || !this.player) return;
    this.player.playVideo();
    clearTimeout(this.playTimer);
    this.playTimer = setTimeout(() => this.playDidNotStart(), 15000);
  }
  private playDidNotStart(): void {
    if (
      this.disposed ||
      this.desired?.transport !== "playing" ||
      this.status === "playing" ||
      this.status === "buffering" ||
      this.status === "error" ||
      this.status === "blocked"
    )
      return;
    // Silence is the usual reason a cross-origin embed never starts. Try muted before calling it a failure.
    if (this.retryMuted()) return;
    this.error = playbackError(
      "providerTimeout",
      "YouTube did not confirm that playback started.",
    );
    this.status = "error";
    this.changed();
  }
  // A screen with no keyboard or mouse cannot answer a prompt, so a refused start retries on its own.
  private scheduleUnblock(): void {
    if (this.unblock || this.disposed) return;
    this.unblock = setTimeout(() => {
      this.unblock = undefined;
      if (this.disposed || this.suspended || this.status !== "blocked") return;
      if (this.desired?.transport !== "playing") return;
      this.attemptPlay();
    }, 5000);
  }
  private cancelUnblock(): void {
    clearTimeout(this.unblock);
    this.unblock = undefined;
  }
  private retryMuted(): boolean {
    if (!this.player || this.policyMuted || this.player.isMuted()) return false;
    this.policyMuted = true;
    this.player.mute();
    this.error = playbackError(
      "autoplayMuted",
      "The browser refused audible autoplay: YouTube plays without sound until the page is clicked.",
    );
    autoplayGate.require(this.resume);
    this.attemptPlay();
    this.changed();
    return true;
  }
  private restoreSound(): void {
    if (this.disposed || this.suspended || !this.player || !this.desired)
      return;
    if (this.policyMuted) {
      this.policyMuted = false;
      if (!this.desired.playback.muted) {
        this.player.unMute();
        this.player.setVolume(this.desired.playback.volume);
      }
    }
    if (this.error?.code === "autoplayMuted" || this.status === "blocked")
      this.error = null;
    if (
      this.desired.transport === "playing" &&
      this.player.getPlayerState() !== 1
    )
      this.attemptPlay();
    else this.changed();
  }
  suspend(): void {
    this.suspended = true;
    clearTimeout(this.playTimer);
    this.cancelUnblock();
    autoplayGate.cancel(this.resume);
    this.player?.pauseVideo();
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.playTimer);
    clearInterval(this.captionGuard);
    this.captionGuard = undefined;
    this.cancelUnblock();
    autoplayGate.cancel(this.resume);
    this.disposeLoad?.();
    this.player?.destroy();
    this.player = null;
    this.host.replaceChildren();
  }
  observation(): ReturnType<PlayerAdapter["observation"]> {
    const p = this.player;
    const duration = p?.getDuration?.() ?? 0;
    const playlist = p?.getPlaylist?.();
    return {
      status: this.status,
      positionSeconds: p?.getCurrentTime?.() ?? 0,
      durationSeconds: duration > 0 ? duration : null,
      seekable: duration > 0,
      actualMuted: p?.isMuted?.() ?? true,
      actualVolume: p?.getVolume?.() ?? 0,
      actualPlaybackRate: p?.getPlaybackRate?.() ?? 1,
      currentVideoId: this.currentVideoId(),
      playlistIndex: playlist?.length ? p!.getPlaylistIndex() : null,
      playlistLength: playlist?.length ?? null,
      error: this.error,
      capabilities: capabilities({
        canSeek: duration > 0,
        canLoop: true,
        availablePlaybackRates: p?.getAvailablePlaybackRates?.() ?? [1],
        canRotate: this.rotationEnabled,
        rotationStatus: this.rotationEnabled ? "experimental" : "disabled",
      }),
    };
  }
  private currentVideoId(): string | null {
    try {
      const url = this.player?.getVideoUrl?.();
      return url ? new URL(url).searchParams.get("v") : null;
    } catch {
      return null;
    }
  }
}
