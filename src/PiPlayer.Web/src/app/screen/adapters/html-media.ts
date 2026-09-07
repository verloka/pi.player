import { Channel, Observed, PlaybackError, Source } from "../../core/contracts";
import { autoplayGate } from "../autoplay";
import {
  autoplayRejected,
  capabilities,
  playbackError,
  PlayerAdapter,
  rejectedPlay,
} from "./player";

export class HtmlMediaAdapter implements PlayerAdapter {
  private status: Observed["status"] = "loading";
  private error: PlaybackError | null = null;
  private disposed = false;
  private suspended = false;
  private desired: Channel | null = null;
  private abort = new AbortController();
  private retry?: ReturnType<typeof setTimeout>;
  private retryStarted = 0;
  private retryCount = 0;
  private cancelLoad: (() => void) | null = null;
  private url: string;
  private loading = false;
  private policyMuted = false;
  private recoveries = 0;
  private unblock?: ReturnType<typeof setTimeout>;
  private resume = () => this.restoreSound();
  constructor(
    public readonly source: Source,
    public readonly element: HTMLMediaElement,
    private changed: () => void,
    private retrySeconds = [1, 2, 5, 10, 30],
    private retryBudgetSeconds = 120,
  ) {
    if (source.kind === "localVideo")
      this.url = "/media/videos/" + source.assetId;
    else if (source.kind === "localFile")
      this.url = "/media/audio/" + source.assetId;
    else if (source.kind === "remoteAudioUrl") this.url = source.url;
    else throw new Error("Invalid HTML media source");
    for (const [event, status] of Object.entries({
      playing: "playing",
      waiting: "buffering",
      ended: "ended",
      pause: "paused",
      canplay: "ready",
      loadstart: "loading",
    }))
      element.addEventListener(
        event,
        () => {
          if (this.disposed) return;
          if (event === "playing") {
            this.error = null;
            this.retryStarted = 0;
            this.retryCount = 0;
            this.recoveries = 0;
            this.cancelUnblock();
          }
          if (event === "canplay" && !element.paused) return;
          this.status =
            this.desired?.transport === "stopped" && element.paused
              ? "stopped"
              : event === "canplay" && this.desired?.transport === "paused"
                ? "paused"
                : (status as Observed["status"]);
          this.changed();
          if (event === "pause") this.recoverSilentPause();
        },
        { signal: this.abort.signal },
      );
    element.addEventListener("error", () => this.mediaError(), {
      signal: this.abort.signal,
    });
    for (const event of [
      "volumechange",
      "ratechange",
      "durationchange",
      "seeked",
    ])
      element.addEventListener(event, () => this.changed(), {
        signal: this.abort.signal,
      });
  }
  updateIntent(channel: Channel): void {
    const generationChanged =
      this.desired?.playbackGeneration !== channel.playbackGeneration;
    this.desired = channel;
    if (generationChanged || channel.transport !== "playing")
      this.cancelRetry();
    if (channel.transport !== "playing") this.element.pause();
  }
  async load(): Promise<void> {
    if (this.disposed) return;
    this.loading = true;
    this.status = "loading";
    this.error = null;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.element.removeEventListener("loadedmetadata", ready);
        this.element.removeEventListener("error", failed);
        this.cancelLoad = null;
        this.loading = false;
        error ? reject(error) : resolve();
      };
      const ready = () => finish();
      const failed = () => finish(new Error("mediaLoadFailed"));
      const timer = setTimeout(
        () => finish(new Error("mediaLoadTimeout")),
        20000,
      );
      this.cancelLoad = () => finish(new Error("disposed"));
      this.element.addEventListener("loadedmetadata", ready, { once: true });
      this.element.addEventListener("error", failed, { once: true });
      this.element.preload = "auto";
      this.element.src = this.url;
      this.element.load();
    });
    if (!this.disposed) {
      this.status = "ready";
      this.changed();
    }
  }
  async apply(channel: Channel, position: number | null): Promise<void> {
    if (this.disposed) return;
    this.desired = channel;
    this.suspended = false;
    if (this.policyMuted && autoplayGate.unlocked) this.policyMuted = false;
    this.element.muted = channel.playback.muted || this.policyMuted;
    this.element.volume = channel.playback.volume / 100;
    const live = this.isLive();
    this.element.loop = channel.playback.loop && !live;
    if ("playbackRate" in channel.playback)
      this.element.playbackRate = Number(channel.playback.playbackRate);
    if (channel.transport !== "playing") this.cancelRetry();
    if (channel.transport === "stopped") {
      this.element.pause();
      if (Number.isFinite(this.element.duration)) this.element.currentTime = 0;
      if (this.source.kind === "remoteAudioUrl") {
        this.element.removeAttribute("src");
        this.element.load();
      }
      this.status = "stopped";
      this.error = null;
      this.changed();
      return;
    }
    if (!this.element.getAttribute("src")) await this.load();
    if (this.disposed || this.suspended || this.desired !== channel) return;
    if (position !== null && !live && this.element.readyState >= 1)
      this.element.currentTime = Math.min(
        position,
        Number.isFinite(this.element.duration)
          ? this.element.duration
          : position,
      );
    if (channel.transport === "paused") {
      this.element.pause();
      if (this.status !== "ended") this.status = "paused";
      this.changed();
      return;
    }
    if (this.element.paused) await this.start(channel);
  }
  private async start(channel: Channel): Promise<void> {
    try {
      await this.element.play();
      if (
        this.disposed ||
        this.suspended ||
        this.desired?.transport !== "playing"
      )
        this.element.pause();
      else if (this.policyMuted) autoplayGate.require(this.resume);
    } catch (error) {
      if (this.disposed || this.suspended || this.desired !== channel) return;
      if (autoplayRejected(error) && !this.element.muted) {
        // Muted playback is always permitted: keep the picture and add sound on the first gesture.
        this.policyMuted = true;
        this.element.muted = true;
        try {
          await this.element.play();
          if (
            this.disposed ||
            this.suspended ||
            this.desired?.transport !== "playing"
          ) {
            this.element.pause();
            return;
          }
          this.error = playbackError(
            "autoplayMuted",
            "The browser refused audible autoplay: playback runs without sound until the page is clicked.",
          );
          autoplayGate.require(this.resume);
          this.changed();
          return;
        } catch {
          this.policyMuted = false;
          this.element.muted = channel.playback.muted;
        }
      }
      this.error = rejectedPlay(error);
      this.status = this.error.code === "autoplayBlocked" ? "blocked" : "error";
      if (this.status === "blocked") {
        autoplayGate.require(this.resume);
        this.scheduleUnblock();
      }
      this.changed();
    }
  }
  // A screen with no keyboard or mouse cannot answer a prompt, so a refused start retries on its own.
  private scheduleUnblock(): void {
    if (this.unblock || this.disposed) return;
    this.unblock = setTimeout(() => {
      this.unblock = undefined;
      if (this.disposed || this.suspended || this.status !== "blocked") return;
      if (this.desired?.transport !== "playing") return;
      void this.start(this.desired);
    }, 5000);
  }
  private cancelUnblock(): void {
    clearTimeout(this.unblock);
    this.unblock = undefined;
  }
  // Chromium pauses a muted stream the instant script makes it audible without user activation.
  // The element is still loaded, so one play() attempt is enough to land on the muted fallback.
  private recoverSilentPause(): void {
    if (this.disposed || this.suspended || this.element.muted) return;
    if (this.desired?.transport !== "playing") return;
    if (this.element.ended || this.element.seeking) return;
    if (this.recoveries >= 3) return;
    this.recoveries++;
    void this.start(this.desired);
  }
  private restoreSound(): void {
    if (this.disposed || this.suspended || !this.desired) return;
    if (this.policyMuted) {
      this.policyMuted = false;
      this.element.muted = this.desired.playback.muted;
      this.element.volume = this.desired.playback.volume / 100;
    }
    if (this.error?.code === "autoplayMuted" || this.status === "blocked")
      this.error = null;
    if (this.desired.transport === "playing") void this.start(this.desired);
    else this.changed();
  }
  private isLive(): boolean {
    return (
      this.source.kind === "remoteAudioUrl" &&
      (this.source.streamMode === "live" ||
        (this.source.streamMode === "auto" &&
          this.element.duration === Infinity))
    );
  }
  private mediaError(): void {
    if (this.disposed || this.desired?.transport === "stopped") return;
    const code = this.element.error?.code;
    this.error =
      code === 3
        ? playbackError(
            "decodeError",
            "The file could not be decoded. Check the codec against the target Chromium.",
          )
        : code === 4
          ? playbackError(
              "unsupportedSource",
              "The format or source is unavailable. A direct link without extra authorisation is required.",
            )
          : playbackError(
              "networkError",
              "Network error while loading the audio or video.",
              code === 2,
            );
    this.status = "error";
    this.changed();
    if (
      this.source.kind === "remoteAudioUrl" &&
      code === 2 &&
      this.desired?.transport === "playing" &&
      !this.suspended
    )
      this.scheduleRetry();
  }
  private scheduleRetry(): void {
    if (this.retry || this.disposed) return;
    this.retryStarted ||= performance.now();
    const delay =
      (this.retrySeconds[
        Math.min(this.retryCount++, this.retrySeconds.length - 1)
      ] ?? 30) * 1000;
    if (
      performance.now() - this.retryStarted + delay >
      this.retryBudgetSeconds * 1000
    )
      return;
    this.retry = setTimeout(async () => {
      this.retry = undefined;
      if (
        this.disposed ||
        this.suspended ||
        this.desired?.transport !== "playing"
      )
        return;
      try {
        if (!this.loading) await this.load();
        if (this.desired) await this.apply(this.desired, null);
      } catch {
        this.scheduleRetry();
      }
    }, delay);
  }
  private cancelRetry(): void {
    clearTimeout(this.retry);
    this.retry = undefined;
    this.retryStarted = 0;
    this.retryCount = 0;
  }
  suspend(): void {
    this.suspended = true;
    this.cancelRetry();
    this.cancelUnblock();
    autoplayGate.cancel(this.resume);
    this.element.pause();
  }
  dispose(): void {
    this.disposed = true;
    this.cancelRetry();
    this.cancelUnblock();
    autoplayGate.cancel(this.resume);
    this.abort.abort();
    this.cancelLoad?.();
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
    this.element.remove();
  }
  observation(): ReturnType<PlayerAdapter["observation"]> {
    const live = this.isLive();
    const finite = Number.isFinite(this.element.duration);
    const canSeek = !live && this.element.seekable.length > 0;
    return {
      status: this.status,
      positionSeconds: Number.isFinite(this.element.currentTime)
        ? this.element.currentTime
        : 0,
      durationSeconds: finite && !live ? this.element.duration : null,
      seekable: canSeek,
      actualMuted: this.element.muted,
      actualVolume: this.element.volume * 100,
      actualPlaybackRate: this.element.playbackRate,
      currentVideoId: null,
      playlistIndex: null,
      playlistLength: null,
      error: this.error,
      capabilities: capabilities({
        canSeek,
        canLoop: finite && !live,
        isLive: live,
        canRotate: this.source.kind === "localVideo",
        rotationStatus:
          this.source.kind === "localVideo" ? "supported" : "disabled",
        canSetOpacity: this.source.kind === "localVideo",
        availablePlaybackRates:
          this.source.kind === "localVideo"
            ? [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
            : [1],
      }),
    };
  }
}
