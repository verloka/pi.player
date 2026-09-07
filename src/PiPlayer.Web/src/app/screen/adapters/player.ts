import {
  Capabilities,
  Channel,
  Observed,
  PlaybackError,
  Source,
} from "../../core/contracts";
export interface PlayerAdapter {
  readonly source: Source;
  updateIntent?(channel: Channel): void;
  load(): Promise<void>;
  apply(
    channel: Channel,
    position: number | null,
    playlistIndex: number | null,
  ): Promise<void>;
  suspend(): void;
  dispose(): void;
  observation(): Omit<
    Observed,
    "sourceFingerprint" | "playbackGeneration" | "lastAppliedRevision"
  >;
}
export const capabilities = (
  overrides: Partial<Capabilities> = {},
): Capabilities => ({
  canSeek: false,
  canLoop: false,
  canSetVolume: true,
  canMute: true,
  availablePlaybackRates: [1],
  canRotate: false,
  rotationStatus: "disabled",
  canSetOpacity: false,
  isLive: false,
  ...overrides,
});
export const playbackError = (
  code: string,
  message: string,
  retryable = false,
  providerCode: number | null = null,
): PlaybackError => ({ code, message, retryable, providerCode });
export function autoplayRejected(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NotAllowedError"
  );
}
export function rejectedPlay(error: unknown): PlaybackError {
  return autoplayRejected(error)
    ? playbackError(
        "autoplayBlocked",
        "Chromium blocked autoplay. Check the dedicated kiosk profile and the autoplay policy.",
      )
    : playbackError("playbackFailed", "The browser could not start playback.");
}
