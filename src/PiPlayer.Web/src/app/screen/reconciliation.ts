import {
  Channel,
  Checkpoint,
  fingerprint,
  Observed,
  Source,
  StateEnvelope,
  youtube,
} from "../core/contracts";
import { PlayerAdapter, playbackError, capabilities } from "./adapters/player";

export type AdapterFactory = (
  source: Source,
  changed: () => void,
) => PlayerAdapter;
/** Optional owner for visual layers retained during a source change. Audio stays immediate. */
export interface ChannelPresentation {
  replace(previous: PlayerAdapter | null, next: Source | null): void;
  prepare(adapter: PlayerAdapter, channel: Channel): Channel;
  present(adapter: PlayerAdapter, channel: Channel): Promise<void>;
  suspend(): void;
  dispose(): void;
}
export class ChannelRenderer {
  private adapter: PlayerAdapter | null = null;
  private sourceKey = "";
  private instance = "";
  private generation = -1;
  private epoch = 0;
  private ready = false;
  private active = false;
  private applying = false;
  private pending = false;
  private needsPosition = false;
  private latest: StateEnvelope | null = null;
  private hash = "none";
  private lastAppliedRevision = 0;
  private appliedGeneration = -1;
  private failure: Observed["error"] = null;
  private position: number | null = null;
  private playlistIndex: number | null = null;
  private restoredEnded = false;
  constructor(
    private target: "visual" | "audio",
    private factory: AdapterFactory,
    private report: (state: Observed) => void,
    private presentation?: ChannelPresentation,
  ) {}
  setActive(active: boolean): void {
    const changed = this.active !== active;
    this.active = active;
    if (!active && changed) {
      this.adapter?.suspend();
      this.presentation?.suspend();
    }
  }
  async reconcile(state: StateEnvelope): Promise<void> {
    const previous = this.latest;
    if (
      previous?.serverInstanceId === state.serverInstanceId &&
      state.revision < previous.revision
    )
      return;
    this.latest = state;
    if (!this.active) return;
    const channel = state.desired[this.target];
    const key = JSON.stringify(channel.source);
    const newSource =
      key !== this.sourceKey || this.instance !== state.serverInstanceId;
    const newGeneration = channel.playbackGeneration !== this.generation;
    if (newSource) {
      const epoch = ++this.epoch;
      if (this.presentation)
        this.presentation.replace(this.adapter, channel.source);
      else this.adapter?.dispose();
      this.adapter = null;
      this.sourceKey = key;
      this.instance = state.serverInstanceId;
      this.ready = false;
      this.failure = null;
      this.applying = false;
      this.generation = channel.playbackGeneration;
      this.lastAppliedRevision = 0;
      this.appliedGeneration = this.generation;
      const checkpoint = state.checkpoints[this.target];
      this.position = channel.startPositionSeconds;
      this.restoredEnded = false;
      this.playlistIndex =
        this.target === "visual"
          ? state.desired.visual.startPlaylistIndex
          : null;
      this.needsPosition = true;
      this.hash = await fingerprint(channel.source);
      if (epoch !== this.epoch) return;
      if (
        checkpoint &&
        checkpoint.sourceFingerprint === this.hash &&
        this.matches(checkpoint, channel)
      ) {
        this.position = checkpoint.positionSeconds;
        this.restoredEnded = checkpoint.ended;
        this.playlistIndex = checkpoint.playlistIndex;
      }
      if (!channel.source) {
        this.ready = true;
        this.lastAppliedRevision = state.revision;
        this.emit();
        return;
      }
      const adapter = this.factory(channel.source, () => {
        if (epoch !== this.epoch) return;
        if (this.failure && this.adapter?.observation().status === "playing") {
          this.failure = null;
          this.ready = true;
          void this.drain();
        }
        this.emit();
      });
      this.adapter = adapter;
      adapter.updateIntent?.(channel);
      try {
        await adapter.load();
        if (epoch !== this.epoch) return;
        this.ready = true;
        await this.drain();
      } catch {
        if (epoch !== this.epoch) return;
        this.failure =
          this.adapter?.observation().error ??
          playbackError(
            youtube(channel.source) ? "providerUnavailable" : "mediaLoadFailed",
            youtube(channel.source)
              ? "The YouTube API or its player is unavailable."
              : "The media could not be loaded. Check the file and that the source is reachable.",
          );
        this.emit();
      }
      return;
    }
    this.adapter?.updateIntent?.(channel);
    if (newGeneration) {
      this.restoredEnded = false;
      if (this.failure && !this.ready) {
        this.sourceKey = "";
        await this.reconcile(state);
        return;
      }
      this.generation = channel.playbackGeneration;
      this.position = channel.startPositionSeconds;
      this.playlistIndex =
        this.target === "visual"
          ? state.desired.visual.startPlaylistIndex
          : null;
      this.needsPosition = true;
      this.failure = null;
    }
    if (!channel.source) {
      this.appliedGeneration = channel.playbackGeneration;
      this.lastAppliedRevision = state.revision;
      this.emit();
      return;
    }
    await this.drain();
  }
  private matches(cp: Checkpoint, channel: Channel): boolean {
    return (
      cp.playbackGeneration === channel.playbackGeneration &&
      !(
        channel.source?.kind === "remoteAudioUrl" &&
        channel.source.streamMode === "live"
      )
    );
  }
  private async drain(): Promise<void> {
    this.pending = true;
    if (this.applying || !this.ready || !this.adapter || !this.active) return;
    this.applying = true;
    const epoch = this.epoch;
    try {
      while (
        this.pending &&
        this.latest &&
        this.active &&
        epoch === this.epoch
      ) {
        this.pending = false;
        const state = this.latest;
        const channel = state.desired[this.target];
        const adapter = this.adapter;
        const seek = this.needsPosition ? this.position : null;
        this.needsPosition = false;
        await adapter.apply(
          this.presentation?.prepare(adapter, channel) ?? channel,
          seek,
          this.playlistIndex,
        );
        if (epoch !== this.epoch || !this.active) return;
        await this.presentation?.present(adapter, channel);
        if (epoch !== this.epoch || !this.active) return;
        this.lastAppliedRevision = state.revision;
        this.appliedGeneration = channel.playbackGeneration;
        this.emit();
      }
    } catch (error) {
      if (epoch === this.epoch) {
        // Carry the underlying reason: an operator with only SSH reads this out of diagnostics.
        const reason = error instanceof Error ? error.message : String(error);
        console.error("[piplayer] reconciliation failed", this.target, error);
        this.failure =
          this.adapter?.observation().error ??
          playbackError(
            "reconciliationFailed",
            "The player did not apply the configuration: " + reason,
          );
        this.emit();
      }
    } finally {
      if (epoch === this.epoch) this.applying = false;
    }
  }
  emit(): void {
    if (!this.active || !this.latest) return;
    const observation = this.adapter?.observation() ?? {
      status: "idle" as const,
      positionSeconds: 0,
      durationSeconds: null,
      seekable: false,
      actualMuted: false,
      actualVolume: 0,
      actualPlaybackRate: 1,
      currentVideoId: null,
      playlistIndex: null,
      playlistLength: null,
      error: null,
      capabilities: capabilities(),
    };
    this.report({
      ...observation,
      ...(this.restoredEnded &&
      this.latest.desired[this.target].transport === "paused" &&
      ["ready", "paused", "ended"].includes(observation.status)
        ? { status: "ended" as const }
        : {}),
      ...(this.failure
        ? { status: "error" as const, error: this.failure }
        : {}),
      sourceFingerprint: this.hash,
      playbackGeneration: this.appliedGeneration,
      lastAppliedRevision: this.lastAppliedRevision,
    });
  }
  block(code: string, message: string): void {
    this.adapter?.suspend();
    this.presentation?.suspend();
    this.failure = playbackError(code, message);
    this.emit();
  }
  dispose(): void {
    this.active = false;
    this.epoch++;
    if (this.presentation) this.presentation.dispose();
    else this.adapter?.dispose();
    this.adapter = null;
    this.sourceKey = "";
    this.ready = false;
  }
}
