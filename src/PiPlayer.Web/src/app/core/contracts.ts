export type VisualSource =
  | { kind: "localVideo"; assetId: string }
  | { kind: "youtubeVideo"; videoId: string }
  | {
      kind: "youtubePlaylist";
      playlistId: string;
      initialVideoId: string | null;
    };
export type AudioSource =
  | { kind: "localFile"; assetId: string }
  | { kind: "youtubeAudio"; videoId: string }
  | {
      kind: "remoteAudioUrl";
      url: string;
      streamMode: "auto" | "file" | "live";
    };
export type Source = VisualSource | AudioSource;
export type Target = "visual" | "audio" | "system";
export type Transport = "playing" | "paused" | "stopped";
export interface Transform {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  opacity: number;
  objectFit: "contain" | "cover" | "fill";
}
export interface Playback {
  loop: boolean;
  muted: boolean;
  volume: number;
}
export interface VisualPlayback extends Playback {
  playbackRate: number;
}
export interface Channel<
  S extends Source = Source,
  P extends Playback = Playback,
> {
  source: S | null;
  playback: P;
  transport: Transport;
  playbackGeneration: number;
  startPositionSeconds: number;
}
export interface VisualState extends Channel<VisualSource, VisualPlayback> {
  visible: boolean;
  transform: Transform;
  startPlaylistIndex: number | null;
}
/** A disc on the screen above the background and below the video. x and y offset its centre from the screen centre. */
export interface Circle {
  x: number;
  y: number;
  diameter: number;
  color: string;
  visible: boolean;
}
export interface Desired {
  visual: VisualState;
  audio: Channel<AudioSource>;
  background: { color: string };
  circle: Circle;
}
export interface Capabilities {
  canSeek: boolean;
  canLoop: boolean;
  canSetVolume: boolean;
  canMute: boolean;
  availablePlaybackRates: number[];
  canRotate: boolean;
  rotationStatus: "supported" | "experimental" | "disabled";
  canSetOpacity: boolean;
  isLive: boolean;
}
export interface PlaybackError {
  code: string;
  message: string;
  providerCode: number | null;
  retryable: boolean;
}
export interface Observed {
  status:
    | "idle"
    | "loading"
    | "ready"
    | "playing"
    | "paused"
    | "stopped"
    | "buffering"
    | "ended"
    | "blocked"
    | "error";
  sourceFingerprint: string;
  playbackGeneration: number;
  positionSeconds: number;
  durationSeconds: number | null;
  seekable: boolean;
  actualMuted: boolean;
  actualVolume: number;
  actualPlaybackRate: number;
  currentVideoId: string | null;
  playlistIndex: number | null;
  playlistLength: number | null;
  lastAppliedRevision: number;
  error: PlaybackError | null;
  capabilities: Capabilities;
  receivedAtUtc?: string | null;
}
export interface Viewport {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
}
export interface ScreenDescriptor {
  deviceId: "primary";
  pageSessionId: string;
  viewport: Viewport;
  visibilityState: string;
  userAgent: string;
}
export interface Checkpoint {
  sourceFingerprint: string;
  playbackGeneration: number;
  positionSeconds: number;
  durationSeconds: number | null;
  ended: boolean;
  playlistIndex: number | null;
  currentVideoId: string | null;
  capturedAtUtc: string;
}
export interface StateEnvelope {
  serverInstanceId: string;
  revision: number;
  desired: Desired;
  observed: Partial<Record<"visual" | "audio", Observed>>;
  screen: {
    connected: boolean;
    stale: boolean;
    descriptor: ScreenDescriptor | null;
    lastHeartbeatAgeSeconds: number | null;
  };
  persistence: "saved" | "pending" | "failed";
  cause: { commandId: string | null; reason: string };
  telemetrySequence: number;
  checkpoints: { visual: Checkpoint | null; audio: Checkpoint | null };
  warnings: string[];
  enableExperimentalYouTubeRotation: boolean;
}
/** The Pi's own output volume (wpctl) and temperature (vcgencmd). volumePercent is null when wpctl failed. */
export interface DeviceStatus {
  volumePercent: number | null;
  muted: boolean | null;
  temperatureCelsius: number | null;
  error: string | null;
}
export interface Command {
  commandId: string;
  target: Target;
  type: string;
  payload: unknown;
  expectedRevision: number | null;
  expectedPlaybackGeneration: number | null;
  interactionId: string | null;
  clientSequence: number | null;
  commit: boolean;
}
export interface Receipt {
  commandId: string;
  status: "accepted" | "applied" | "failed" | "superseded" | "timedOut";
  serverInstanceId: string;
  revision: number;
  screenOnline: boolean;
  persistence: string;
}
export interface Document {
  schemaVersion: 2;
  documentRevision: number;
  updatedAtUtc: string;
}
export interface Collection<T> extends Document {
  items: T[];
}
export interface Asset {
  id: string;
  displayName: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  availability: "available" | "missing";
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  createdAtUtc: string;
}
export interface VisualPreset {
  id: string;
  name: string;
  source: VisualSource | null;
  visible: boolean;
  transform: Transform;
  playback: VisualPlayback;
  initialPositionSeconds: number;
  referenceViewport: Viewport | null;
  createdAtUtc: string;
  updatedAtUtc: string;
  /** Null for presets saved before the circle existed: applying them leaves the circle alone. */
  circle: Circle | null;
}
export interface AudioPreset {
  id: string;
  name: string;
  source: AudioSource | null;
  playback: Playback;
  initialPositionSeconds: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}
export interface Startup extends Document {
  startupMode: "defaults" | "resumeLast";
  defaultVisualPresetId: string | null;
  defaultAudioPresetId: string | null;
  startVisualOnBoot: boolean;
  startAudioOnBoot: boolean;
  backgroundColor: string;
}
export const defaultTransform: Transform = {
  x: 0,
  y: 0,
  width: 640,
  height: 360,
  scale: 1,
  rotation: 0,
  opacity: 1,
  objectFit: "contain",
};
export const defaultCircle: Circle = {
  x: 0,
  y: 0,
  diameter: 400,
  color: "#ffffff",
  visible: true,
};
export function youtube(source: Source | null): boolean {
  return (
    source?.kind === "youtubeVideo" ||
    source?.kind === "youtubePlaylist" ||
    source?.kind === "youtubeAudio"
  );
}
export function uuid(): string {
  // UUID v7; Web Crypto randomUUID is unavailable on ordinary LAN HTTP origins.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function fingerprint(source: Source | null): Promise<string> {
  if (!source) return "none";
  switch (source.kind) {
    case "localVideo":
    case "localFile":
      return `${source.kind}:${source.assetId}`;
    case "youtubeVideo":
    case "youtubeAudio":
      return `${source.kind}:${source.videoId}`;
    case "youtubePlaylist":
      return `youtubePlaylist:${source.playlistId}:${source.initialVideoId ?? ""}`;
    case "remoteAudioUrl":
      return (
        "remoteAudioUrl:" +
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(source.url + "|" + source.streamMode),
            ),
          ),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("")
      );
  }
}
