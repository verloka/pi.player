import { Channel, Source, VisualState } from "../core/contracts";
import { PlayerAdapter } from "./adapters/player";
import { ChannelPresentation } from "./reconciliation";

type Layer = {
  adapter: PlayerAdapter;
  frame: HTMLDivElement;
  host: HTMLDivElement;
  wake: Set<() => void>;
};
type VisualFactory = (
  source: Source,
  host: HTMLElement,
  changed: () => void,
) => PlayerAdapter;

/** Owns at most the displayed video and its replacement. Geometry belongs to each video. */
export class VisualStage implements ChannelPresentation {
  private layers = new Map<PlayerAdapter, Layer>();
  private displayed: Layer | null = null;
  private desired: VisualState | null = null;
  private animations: Animation[] = [];
  private cancelWait: (() => void) | null = null;
  private fade = 0;

  constructor(
    private root: HTMLElement,
    private factory: VisualFactory,
    private durationMs = 500,
  ) {}

  update(state: VisualState): void {
    const changed =
      this.desired?.playbackGeneration !== state.playbackGeneration ||
      JSON.stringify(this.desired?.source) !== JSON.stringify(state.source);
    this.desired = state;
    if (changed) this.cancelWait?.();
    for (const layer of this.layers.values()) {
      if (JSON.stringify(layer.adapter.source) === JSON.stringify(state.source))
        this.geometry(layer, state);
    }
    if (!state.visible || state.transport !== "playing") this.suspend();
  }

  create(source: Source, changed: () => void): PlayerAdapter {
    const frame = document.createElement("div");
    frame.className = "visual-frame";
    Object.assign(frame.style, {
      position: "absolute",
      inset: "0",
      opacity: "0",
      pointerEvents: "none",
    });
    const host = document.createElement("div");
    host.className = "visual-layer";
    Object.assign(host.style, {
      position: "absolute",
      transformOrigin: "50% 50%",
    });
    frame.append(host);
    this.root.append(frame);
    const wake = new Set<() => void>();
    const adapter = this.factory(source, host, () => {
      for (const notify of wake) notify();
      changed();
    });
    const layer = { adapter, frame, host, wake };
    this.layers.set(adapter, layer);
    if (this.desired) this.geometry(layer, this.desired);
    return adapter;
  }

  replace(previous: PlayerAdapter | null, next: Source | null): void {
    this.cancelWait?.();
    this.finishFade();
    if (!next) {
      this.dispose();
      return;
    }
    // An abandoned candidate must never become visible when its delayed load finishes.
    if (previous && previous !== this.displayed?.adapter)
      this.remove(this.layers.get(previous));
  }

  prepare(adapter: PlayerAdapter, channel: Channel): Channel {
    // Decode the replacement silently; switch the video's sound only at the visual handoff.
    return this.displayed && adapter !== this.displayed.adapter
      ? { ...channel, playback: { ...channel.playback, muted: true } }
      : channel;
  }

  async present(adapter: PlayerAdapter, channel: Channel): Promise<void> {
    const layer = this.layers.get(adapter);
    if (!layer || layer === this.displayed) return;
    if (!(await this.waitForPicture(layer, channel))) return;
    if (
      !this.layers.has(adapter) ||
      this.desired?.playbackGeneration !== channel.playbackGeneration
    )
      return;
    const previous = this.displayed;
    previous?.adapter.suspend();
    this.displayed = layer;
    layer.frame.style.opacity = "1";
    if (!previous || !this.desired.visible || this.durationMs === 0) {
      this.remove(previous);
    } else {
      const token = ++this.fade;
      const incoming = layer.frame.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: this.durationMs,
        easing: "ease-in-out",
      });
      const outgoing = previous.frame.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        {
          duration: this.durationMs,
          easing: "ease-in-out",
          fill: "forwards",
        },
      );
      this.animations = [incoming, outgoing];
      void Promise.allSettled(
        this.animations.map((animation) => animation.finished),
      ).then(() => {
        if (token !== this.fade) return;
        this.finishFade();
      });
    }
    // Start the visual handoff before awaiting audible autoplay: a late promise must not
    // restart an obsolete fade after another source has already been selected.
    await adapter.apply(this.desired, null, null);
  }

  private waitForPicture(layer: Layer, channel: Channel): Promise<boolean> {
    this.cancelWait?.();
    return new Promise((resolve, reject) => {
      const video = layer.host.querySelector("video");
      const events = ["loadeddata", "canplay", "seeked", "playing", "error"];
      const finish = (ready: boolean, error?: Error) => {
        clearTimeout(timer);
        layer.wake.delete(check);
        for (const event of events) video?.removeEventListener(event, check);
        if (this.cancelWait === cancel) this.cancelWait = null;
        error ? reject(error) : resolve(ready);
      };
      const cancel = () => finish(false);
      const check = () => {
        const observed = layer.adapter.observation();
        if (observed.status === "error" || observed.status === "blocked") {
          finish(
            false,
            new Error(
              observed.error?.message ?? "The next video could not start.",
            ),
          );
          return;
        }
        const ready = video
          ? video.readyState >= 2 &&
            !video.seeking &&
            (channel.transport !== "playing" || observed.status === "playing")
          : channel.transport === "playing"
            ? observed.status === "playing"
            : ["ready", "paused", "stopped", "ended"].includes(observed.status);
        if (ready) finish(true);
      };
      const timer = setTimeout(
        () =>
          finish(
            false,
            new Error(
              "The next video did not provide a frame within 20 seconds.",
            ),
          ),
        20000,
      );
      this.cancelWait = cancel;
      layer.wake.add(check);
      for (const event of events) video?.addEventListener(event, check);
      check();
    });
  }

  private geometry(layer: Layer, state: VisualState): void {
    const t = state.transform;
    Object.assign(layer.host.style, {
      left: t.x + "px",
      top: t.y + "px",
      width: t.width + "px",
      height: t.height + "px",
      transform: `rotate(${t.rotation}deg) scale(${t.scale})`,
      opacity: String(t.opacity),
    });
    const video = layer.host.querySelector("video");
    if (video) video.style.objectFit = t.objectFit;
  }

  private remove(layer: Layer | null | undefined): void {
    if (!layer || !this.layers.delete(layer.adapter)) return;
    layer.adapter.dispose();
    layer.frame.remove();
    if (layer === this.displayed) this.displayed = null;
  }

  private finishFade(): void {
    this.fade++;
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    for (const layer of this.layers.values()) {
      // Only an outgoing layer has a visible opacity while it is no longer displayed.
      if (layer !== this.displayed && layer.frame.style.opacity === "1")
        this.remove(layer);
    }
    if (this.displayed) this.displayed.frame.style.opacity = "1";
  }

  suspend(): void {
    this.cancelWait?.();
    this.finishFade();
    for (const layer of this.layers.values()) layer.adapter.suspend();
  }

  dispose(): void {
    this.cancelWait?.();
    this.finishFade();
    for (const layer of this.layers.values()) this.remove(layer);
  }
}
