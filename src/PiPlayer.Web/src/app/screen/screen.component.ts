import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  signal,
  ViewChild,
} from "@angular/core";
import { Api } from "../core/api";
import { I18n } from "../core/i18n";
import {
  fingerprint,
  Observed,
  ScreenDescriptor,
  Source,
  StateEnvelope,
  uuid,
  youtube,
} from "../core/contracts";
import { capabilities, playbackError } from "./adapters/player";
import { Realtime } from "../core/realtime";
import { youtubeGeometry } from "../shared/geometry";
import { HtmlMediaAdapter } from "./adapters/html-media";
import { YouTubeAdapter } from "./adapters/youtube";
import { autoplayGate } from "./autoplay";
import { ChannelRenderer } from "./reconciliation";
@Component({
  selector: "app-screen",
  template: `<div #root class="screen-root">
    <div #circle class="circle-layer"></div>
    <div #visual class="visual-layer"></div>
    <div #audio class="audio-layer" aria-hidden="true"></div>
    @if (needsGesture()) {
      <button type="button" class="unlock" (click)="unlock()">
        <span class="unlock-glyph">&#9654;</span>
        <span class="unlock-text"
          ><strong>{{ t("screen.soundWaiting") }}</strong>
          <small>{{ t("screen.soundWaitingHint") }}</small></span
        >
      </button>
    }
  </div>`,
  styles: [
    ":host{display:block;width:100%;height:100%}",
    ".screen-root{position:fixed;inset:0;overflow:hidden;background:#000}",
    ".circle-layer{position:absolute;display:none;border-radius:50%;pointer-events:none}",
    ".visual-layer{position:absolute;transform-origin:50% 50%}",
    // Experimental YouTube audio uses its own off-screen player; keep a real viewport for the embed.
    ".audio-layer{position:fixed;left:-10000px;top:0;width:320px;height:200px;pointer-events:none}",
    // A signage screen must never be covered by a prompt nobody can dismiss: this is a corner banner.
    ".unlock{position:absolute;z-index:10;left:16px;bottom:16px;max-width:min(520px,calc(100% - 32px));display:flex;align-items:flex-start;gap:12px;border:1px solid rgba(210,250,89,.35);border-radius:10px;padding:12px 16px;text-align:left;cursor:pointer;color:#e8ebdf;background:rgba(10,12,12,.82);font:inherit}",
    ".unlock-glyph{font-size:22px;line-height:1.2;color:#d2fa59}",
    ".unlock-text{display:flex;flex-direction:column;gap:4px}",
    ".unlock strong{font-size:15px;font-weight:600}",
    ".unlock small{font-size:12px;line-height:1.4;color:#90998e}",
  ],
})
export class ScreenComponent implements AfterViewInit, OnDestroy {
  @ViewChild("root", { static: true }) root!: ElementRef<HTMLDivElement>;
  @ViewChild("circle", { static: true }) circle!: ElementRef<HTMLDivElement>;
  @ViewChild("visual", { static: true }) visual!: ElementRef<HTMLDivElement>;
  @ViewChild("audio", { static: true }) audio!: ElementRef<HTMLDivElement>;
  readonly needsGesture = signal(false);
  private page = uuid();
  private unwatchGate?: () => void;
  private renderers!: { visual: ChannelRenderer; audio: ChannelRenderer };
  private lastAck = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private telemetry?: ReturnType<typeof setInterval>;
  private resize?: ResizeObserver;
  private sequence = 0;
  private destroyed = false;
  private leaseActive = false;
  private retrySeconds = [1, 2, 5, 10, 30];
  private retryBudget = 120;
  private lastDescriptor = "";
  private visibility = () => {
    this.viewportChanged();
    if (this.realtime.state()) this.apply(this.realtime.state()!);
  };
  /** Bound so the template can call it; it reads the locale signal and stays reactive. */
  readonly t = (key: string) => this.i18n.t(key);
  constructor(
    private realtime: Realtime,
    private i18n: I18n,
    private api: Api,
  ) {}
  async ngAfterViewInit(): Promise<void> {
    this.renderers = {
      visual: new ChannelRenderer(
        "visual",
        (s, changed) => this.factory(s, changed),
        (o) => this.report("visual", o),
      ),
      audio: new ChannelRenderer(
        "audio",
        (s, changed) => this.factory(s, changed),
        (o) => this.report("audio", o),
      ),
    };
    this.realtime.onSnapshot = (state) => {
      if (this.realtime.registered()) {
        if (!this.leaseActive) {
          this.lastAck = performance.now();
          this.leaseActive = true;
        }
        this.apply(state);
      }
    };
    this.unwatchGate = autoplayGate.watch((blocked) =>
      this.needsGesture.set(blocked),
    );
    document.addEventListener("visibilitychange", this.visibility);
    this.resize = new ResizeObserver(() => this.viewportChanged());
    this.resize.observe(this.root.nativeElement);
    this.heartbeat = setInterval(() => void this.beat(), 5000);
    this.telemetry = setInterval(() => {
      if (performance.now() - this.lastAck >= 15000) {
        this.leaseActive = false;
        this.renderers.visual.setActive(false);
        this.renderers.audio.setActive(false);
      }
      this.renderers.visual.emit();
      this.renderers.audio.emit();
      this.viewportChanged();
    }, 1000);
    await this.realtime.start("screen", () => this.descriptor());
    try {
      const info = await this.api.get<{
        remoteRetrySeconds: number[];
        remoteRetryBudgetSeconds: number;
      }>("/api/system/info");
      this.retrySeconds = info.remoteRetrySeconds;
      this.retryBudget = info.remoteRetryBudgetSeconds;
    } catch {
      /* defaults remain usable offline */
    }
  }
  private descriptor(): ScreenDescriptor {
    const element = this.root.nativeElement;
    return {
      deviceId: "primary",
      pageSessionId: this.page,
      viewport: {
        cssWidth: element.clientWidth,
        cssHeight: element.clientHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      visibilityState: document.visibilityState,
      userAgent: navigator.userAgent,
    };
  }
  private viewportChanged(): void {
    const descriptor = this.descriptor(),
      key = JSON.stringify(descriptor);
    if (key === this.lastDescriptor || !this.realtime.registered()) return;
    this.lastDescriptor = key;
    void this.realtime.invoke("ReportViewport", descriptor).catch(() => {
      this.lastDescriptor = "";
    });
    const state = this.realtime.state();
    if (state) this.apply(state);
  }
  private async beat(): Promise<void> {
    if (this.destroyed) return;
    try {
      if (!this.realtime.registered() || !this.leaseActive) {
        await this.realtime.register();
        if (!this.realtime.registered()) return;
      }
      const accepted = await this.realtime.invoke<boolean>("Heartbeat", {
        pageSessionId: this.page,
      });
      if (accepted) {
        this.lastAck = performance.now();
        const was = this.leaseActive;
        this.leaseActive = true;
        if (!was && this.realtime.state()) this.apply(this.realtime.state()!);
      } else {
        this.leaseActive = false;
        this.renderers.visual.setActive(false);
        this.renderers.audio.setActive(false);
        await this.realtime.register();
      }
    } catch {
      /* monotonic lease timer suspends playback before server expiry */
    }
  }
  private apply(state: StateEnvelope): void {
    if (!this.leaseActive || this.destroyed) return;
    const v = state.desired.visual,
      t = v.transform;
    const element = this.visual.nativeElement;
    this.root.nativeElement.style.backgroundColor =
      state.desired.background.color;
    // Stacking follows the DOM order: the background, the circle above it, the video above both.
    const c = state.desired.circle;
    Object.assign(this.circle.nativeElement.style, {
      display: c.visible && c.diameter > 0 ? "block" : "none",
      left: `calc(50% + ${c.x - c.diameter / 2}px)`,
      top: `calc(50% + ${c.y - c.diameter / 2}px)`,
      width: c.diameter + "px",
      height: c.diameter + "px",
      backgroundColor: c.color,
    });
    if (
      youtube(v.source) &&
      (!v.visible || document.visibilityState !== "visible")
    ) {
      // Destroy the cross-origin player before hiding: no unconfirmed hidden playback.
      this.renderers.visual.dispose();
      element.style.display = "none";
      void this.visualWithoutPlayer(state, "paused");
    } else {
      const invalid = youtube(v.source)
        ? youtubeGeometry(t, state.enableExperimentalYouTubeRotation)
        : null;
      if (invalid) {
        this.renderers.visual.dispose();
        element.style.display = "none";
        void this.visualWithoutPlayer(state, "blocked", invalid);
      } else {
        element.style.display = v.visible ? "block" : "none";
        Object.assign(element.style, {
          left: t.x + "px",
          top: t.y + "px",
          width: t.width + "px",
          height: t.height + "px",
          transform: `rotate(${t.rotation}deg) scale(${t.scale})`,
          opacity: String(t.opacity),
        });
        const video = element.querySelector("video");
        if (video) video.style.objectFit = t.objectFit;
        this.renderers.visual.setActive(true);
        void this.renderers.visual.reconcile(state);
      }
    }
    this.renderers.audio.setActive(true);
    void this.renderers.audio.reconcile(state);
  }
  private async visualWithoutPlayer(
    state: StateEnvelope,
    status: "paused" | "blocked",
    message?: string,
  ): Promise<void> {
    const fp = await fingerprint(state.desired.visual.source);
    const current = this.realtime.state();
    if (
      !current ||
      current.serverInstanceId !== state.serverInstanceId ||
      current.revision !== state.revision
    )
      return;
    this.report("visual", {
      status,
      sourceFingerprint: fp,
      playbackGeneration: state.desired.visual.playbackGeneration,
      positionSeconds: state.checkpoints.visual?.positionSeconds ?? 0,
      durationSeconds: null,
      seekable: false,
      actualMuted: true,
      actualVolume: 0,
      actualPlaybackRate: 1,
      currentVideoId: null,
      playlistIndex: null,
      playlistLength: null,
      lastAppliedRevision: state.revision,
      error: message ? playbackError("youtubeGeometryInvalid", message) : null,
      capabilities: capabilities(),
    });
  }
  private factory(source: Source, changed: () => void) {
    if (source.kind === "youtubeAudio")
      return new YouTubeAdapter(
        source,
        this.audio.nativeElement,
        changed,
        false,
      );
    if (source.kind === "youtubeVideo" || source.kind === "youtubePlaylist")
      return new YouTubeAdapter(
        source,
        this.visual.nativeElement,
        changed,
        this.realtime.state()?.enableExperimentalYouTubeRotation ?? false,
      );
    const media = document.createElement(
      source.kind === "localVideo" ? "video" : "audio",
    );
    if (media instanceof HTMLVideoElement) {
      media.playsInline = true;
      // A signage surface carries no player chrome and swallows no clicks.
      media.controls = false;
      media.disablePictureInPicture = true;
      media.setAttribute(
        "controlslist",
        "nodownload nofullscreen noremoteplayback",
      );
      Object.assign(media.style, {
        width: "100%",
        height: "100%",
        display: "block",
        pointerEvents: "none",
        objectFit:
          this.realtime.state()?.desired.visual.transform.objectFit ??
          "contain",
      });
    }
    const playback =
      source.kind === "localVideo"
        ? this.realtime.state()?.desired.visual.playback
        : this.realtime.state()?.desired.audio.playback;
    media.muted = playback?.muted ?? true;
    media.volume = (playback?.volume ?? 0) / 100;
    (source.kind === "localVideo"
      ? this.visual
      : this.audio
    ).nativeElement.append(media);
    return new HtmlMediaAdapter(
      source,
      media,
      changed,
      this.retrySeconds,
      this.retryBudget,
    );
  }
  private report(target: "visual" | "audio", state: Observed): void {
    const snapshot = this.realtime.state();
    if (!snapshot || !this.leaseActive) return;
    void this.realtime
      .invoke("ReportPlayback", {
        pageSessionId: this.page,
        serverInstanceId: snapshot.serverInstanceId,
        target,
        sequence: ++this.sequence,
        state,
      })
      .catch(() => {});
  }
  unlock(): void {
    autoplayGate.unlock();
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    this.unwatchGate?.();
    clearInterval(this.heartbeat);
    clearInterval(this.telemetry);
    this.resize?.disconnect();
    document.removeEventListener("visibilitychange", this.visibility);
    this.renderers?.visual.dispose();
    this.renderers?.audio.dispose();
    this.realtime.onSnapshot = null;
    void this.realtime.stop();
  }
}
