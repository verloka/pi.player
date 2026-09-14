import {
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  signal,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormBuilder, ReactiveFormsModule } from "@angular/forms";
import { Api, ApiError } from "../core/api";
import {
  Asset,
  AudioPreset,
  AudioSource,
  Circle,
  Collection,
  Command,
  defaultCircle,
  defaultTransform,
  DeviceStatus,
  Receipt,
  Source,
  Startup,
  StateEnvelope,
  Target,
  Transform,
  Viewport,
  VisualPreset,
  VisualSource,
  uuid,
  youtube,
} from "../core/contracts";
import { I18n, Locale, LOCALES } from "../core/i18n";
import { Realtime } from "../core/realtime";
import {
  angleAt,
  bounds,
  centre,
  centred,
  centreOffset,
  circleBounds,
  corners,
  fit,
  maxScale,
  placeCentre,
  previewBounds,
  resizeRotated,
  rotateBy,
  rotateHandle,
} from "../shared/geometry";

/**
 * A live edit of the video. Every step goes out as an uncommitted setTransform under one interaction id
 * and the last step commits, so the screen follows a mouse drag, a slider or the arrow keys without a
 * disk write per step.
 */
interface Interaction {
  id: string;
  sequence: number;
  generation: number;
  pending: Transform | null;
  final: boolean;
  inFlight: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Commits after a quiet spell: a slider let go, the last arrow key pressed. */
  settle?: ReturnType<typeof setTimeout>;
  pointer?: {
    id: number;
    target: Element;
    mode: "move" | "resize" | "rotate";
    startX: number;
    startY: number;
    initial: Transform;
    scale: number;
    pivotX: number;
    pivotY: number;
    startAngle: number;
  };
}
/** How long sliders and arrow keys must stay quiet before their edit commits. */
const SETTLE_MS = 300;
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
/** Half-range of a slider centred on 0: the given size, widened so the current value is never clamped. */
function span(size: number, value: number): number {
  return Math.ceil(Math.max(size, Math.abs(value)));
}

@Component({
  selector: "app-admin",
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: "./admin.component.html",
})
export class AdminComponent implements OnInit, OnDestroy {
  readonly booting = signal(true);
  readonly error = signal("");
  readonly notice = signal("");
  readonly tab = signal("dashboard");
  readonly busy = signal(false);
  readonly uploadProgress = signal<number | null>(null);
  readonly diagnostics = signal<unknown>(null);
  readonly videoLibrary = signal<Collection<Asset> | null>(null);
  readonly audioLibrary = signal<Collection<Asset> | null>(null);
  readonly visualPresets = signal<Collection<VisualPreset> | null>(null);
  readonly audioPresets = signal<Collection<AudioPreset> | null>(null);
  readonly startup = signal<Startup | null>(null);
  readonly channels = ["visual", "audio"] as const;
  readonly device = signal<DeviceStatus | null>(null);
  readonly deviceError = signal("");
  /** A volume on its way to the device, shown until the device confirms it. */
  readonly volumeDraft = signal<number | null>(null);
  readonly deviceVolume = computed(
    () => this.volumeDraft() ?? this.device()?.volumePercent ?? null,
  );
  readonly temperatureLevel = computed(() => {
    const celsius = this.device()?.temperatureCelsius;
    if (celsius == null) return "unknown";
    return celsius >= 80 ? "hot" : celsius >= 65 ? "warm" : "normal";
  });
  /** The dashboard action on its way (a channel, "all" or a preset id), so a double tap does not repeat it. */
  readonly pendingAction = signal<string | null>(null);
  readonly anyPlaying = computed(() => {
    const d = this.realtime.state()?.desired;
    return (
      !!d &&
      this.channels.some((c) => !!d[c].source && d[c].transport === "playing")
    );
  });
  readonly anyPlayable = computed(() => {
    const d = this.realtime.state()?.desired;
    return (
      !!d &&
      this.channels.some((c) => !!d[c].source && d[c].transport !== "playing")
    );
  });
  /** A preset counts as on screen while the scene still matches it: its source and, for video, its geometry. */
  readonly activePresets = computed(() => {
    const d = this.realtime.state()?.desired;
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a) === JSON.stringify(b);
    return {
      visual: d
        ? (this.visualPresets()?.items.find(
            (p) =>
              !!p.source &&
              same(p.source, d.visual.source) &&
              same(p.transform, d.visual.transform),
          ) ?? null)
        : null,
      audio: d
        ? (this.audioPresets()?.items.find(
            (p) => !!p.source && same(p.source, d.audio.source),
          ) ?? null)
        : null,
    };
  });
  /** Which channel's presets a phone lists; wider screens show both side by side. */
  readonly presetChannel = signal<"visual" | "audio">("visual");
  readonly previewTransform = signal<Transform>({ ...defaultTransform });
  readonly viewport = computed<Viewport | null>(
    () => this.realtime.state()?.screen.descriptor?.viewport ?? null,
  );
  readonly previewViewport = computed<Viewport>(
    () =>
      this.viewport() ?? { cssWidth: 960, cssHeight: 540, devicePixelRatio: 1 },
  );
  /**
   * The circle as the panel shows it: a local draft while slider commands are on their way, so a slider
   * never jumps back to a value the backend has not caught up with, and the scene itself otherwise.
   */
  private readonly circleDraft = signal<Circle | null>(null);
  readonly circle = computed<Circle>(
    () =>
      this.circleDraft() ??
      this.realtime.state()?.desired.circle ??
      defaultCircle,
  );
  /** Where the circle lands on the schematic, or null while it draws nothing on the screen. */
  readonly circleShape = computed(() => {
    const c = this.circle();
    return c.visible && c.diameter > 0
      ? circleBounds(c, this.previewViewport())
      : null;
  });
  readonly circleRange = computed(() => {
    const v = this.previewViewport(),
      c = this.circle();
    return {
      x: span(v.cssWidth, c.x),
      y: span(v.cssHeight, c.y),
      diameter: span(Math.hypot(v.cssWidth, v.cssHeight), c.diameter),
    };
  });
  readonly previewBox = computed(() =>
    previewBounds(
      this.previewTransform(),
      this.previewViewport(),
      this.circleShape(),
    ),
  );
  readonly viewBox = computed(() => {
    const b = this.previewBox();
    return `${b.x} ${b.y} ${b.width} ${b.height}`;
  });
  readonly polygon = computed(() =>
    corners(this.previewTransform())
      .map((p) => `${p.x},${p.y}`)
      .join(" "),
  );
  readonly anchor = computed(() => centre(this.previewTransform()));
  readonly resizePoint = computed(() => corners(this.previewTransform())[2]);
  readonly rotateGrip = computed(() =>
    rotateHandle(this.previewTransform(), 46),
  );
  readonly bounding = computed(() => bounds(this.previewTransform()));
  /** The video sliders read the centre's offset from the screen centre: a centred video sits at 0, 0. */
  readonly videoOffset = computed(() =>
    centreOffset(this.previewTransform(), this.previewViewport()),
  );
  readonly videoRange = computed(() => {
    const v = this.previewViewport(),
      o = this.videoOffset(),
      t = this.previewTransform();
    // YouTube refuses a frame under 200 px, so a smaller size would only produce rejected commands.
    const smallest = this.isYouTube()
      ? Math.ceil(Math.max(200 / t.width, 200 / t.height) * 100) / 100
      : 0;
    return {
      x: span(v.cssWidth, o.x),
      y: span(v.cssHeight, o.y),
      minScale: Math.max(0.05, smallest),
      maxScale: Math.max(t.scale, Math.floor(maxScale(t) * 100) / 100),
    };
  });
  readonly isYouTube = computed(() =>
    youtube(this.realtime.state()?.desired.visual.source ?? null),
  );
  readonly bothAudible = computed(() => {
    const s = this.realtime.state()?.desired;
    return (
      !!s &&
      !!s.visual.source &&
      !!s.audio.source &&
      !s.visual.playback.muted &&
      s.visual.playback.volume > 0 &&
      !s.audio.playback.muted &&
      s.audio.playback.volume > 0
    );
  });
  readonly geometry = this.fb.nonNullable.group({
    ...defaultTransform,
    lockAspect: true,
  });
  readonly visualSource = this.fb.nonNullable.group({
    kind: "localVideo",
    assetId: "",
    url: "",
    videoOnly: false,
  });
  readonly audioSource = this.fb.nonNullable.group({
    kind: "localFile",
    assetId: "",
    url: "",
    streamMode: "auto",
  });
  readonly presetName = this.fb.nonNullable.control("");
  readonly startupForm = this.fb.group({
    startupMode: this.fb.nonNullable.control<"defaults" | "resumeLast">(
      "defaults",
    ),
    defaultVisualPresetId: this.fb.control<string | null>(null),
    defaultAudioPresetId: this.fb.control<string | null>(null),
    startVisualOnBoot: this.fb.nonNullable.control(true),
    startAudioOnBoot: this.fb.nonNullable.control(false),
    backgroundColor: this.fb.nonNullable.control("#000000"),
  });
  readonly transformFields = [
    "x",
    "y",
    "width",
    "height",
    "scale",
    "rotation",
    "opacity",
  ] as const;
  private formRevision = 0;
  private lastRevision = -1;
  private lastInstance = "";
  private uploadAbort?: AbortController;
  private drag?: Interaction;
  /** An edit made while the previous interaction was committing. It opens the next one once that lands. */
  private queued: Transform | null = null;
  private circlePending: Circle | null = null;
  private circleSending = false;
  /** The newest revision this panel's own live commands produced; pushed state may still lag behind it. */
  private ownRevision = { instance: "", revision: -1 };
  private devicePending: { volumePercent?: number; muted?: boolean } | null =
    null;
  private deviceSending = false;
  private devicePoll?: ReturnType<typeof setInterval>;
  private geometrySubscription = this.geometry.valueChanges.subscribe(() => {
    const next = this.transform();
    const previous = this.previewTransform();
    if (
      this.geometry.dirty &&
      !this.drag &&
      this.geometry.controls.lockAspect.value
    ) {
      if (
        next.width !== previous.width &&
        next.height === previous.height &&
        previous.width > 0
      ) {
        next.height = (next.width * previous.height) / previous.width;
        this.geometry.controls.height.setValue(next.height, {
          emitEvent: false,
        });
      } else if (
        next.height !== previous.height &&
        next.width === previous.width &&
        previous.height > 0
      ) {
        next.width = (next.height * previous.width) / previous.height;
        this.geometry.controls.width.setValue(next.width, { emitEvent: false });
      }
    }
    this.previewTransform.set(next);
  });
  readonly locales = LOCALES;
  /** Bound so templates can call it directly; it reads the locale signal and stays reactive. */
  readonly t = (key: string, params?: Record<string, string | number>) =>
    this.i18n.t(key, params);
  constructor(
    public realtime: Realtime,
    public i18n: I18n,
    private api: Api,
    private fb: FormBuilder,
  ) {
    effect(() => {
      const state = realtime.state();
      if (state) this.receive(state);
    });
    effect(() => {
      if (realtime.libraryVersion()) void this.refreshLibraries();
    });
  }
  async ngOnInit(): Promise<void> {
    // Temperature and volume change on the device itself, so the open dashboard keeps asking.
    this.devicePoll = setInterval(() => {
      if (
        this.tab() === "dashboard" &&
        document.visibilityState === "visible" &&
        !this.deviceSending
      )
        void this.refreshDevice();
    }, 5000);
    void this.refreshDevice();
    try {
      await this.initialize();
    } catch (e) {
      this.fail(e);
    } finally {
      this.booting.set(false);
    }
  }
  private async initialize(): Promise<void> {
    await Promise.all([
      this.refreshLibraries(),
      this.refreshPresets(),
      this.refreshStartup(),
    ]);
    await this.realtime.start("admin");
  }
  async refreshLibraries(): Promise<void> {
    const [v, a] = await Promise.all([
      this.api.get<Collection<Asset>>("/api/library/videos"),
      this.api.get<Collection<Asset>>("/api/library/audio"),
    ]);
    this.videoLibrary.set(v);
    this.audioLibrary.set(a);
  }
  async refreshPresets(): Promise<void> {
    const [v, a] = await Promise.all([
      this.api.get<Collection<VisualPreset>>("/api/presets/visual"),
      this.api.get<Collection<AudioPreset>>("/api/presets/audio"),
    ]);
    this.visualPresets.set(v);
    this.audioPresets.set(a);
  }
  async refreshStartup(): Promise<void> {
    const s = await this.api.get<Startup>("/api/settings/startup");
    this.startup.set(s);
    this.startupForm.patchValue(s);
    this.startupForm.markAsPristine();
  }
  private receive(state: StateEnvelope): void {
    if (
      state.revision === this.lastRevision &&
      state.serverInstanceId === this.lastInstance
    )
      return;
    this.lastRevision = state.revision;
    this.lastInstance = state.serverInstanceId;
    if (!this.geometry.dirty && !this.drag) this.resetForm(state);
  }
  private resetForm(state: StateEnvelope): void {
    this.geometry.patchValue(state.desired.visual.transform);
    this.previewTransform.set(state.desired.visual.transform);
    this.geometry.markAsPristine();
    this.formRevision = state.revision;
  }
  transform(): Transform {
    const { lockAspect: _, ...transform } = this.geometry.getRawValue();
    return transform;
  }
  private fail(error: unknown): void {
    if (error instanceof ApiError) {
      const p = error.problem;
      this.error.set(
        `${p.title} [${p.code}]${p.details ? " " + JSON.stringify(p.details) : ""}`,
      );
      if (p.state) {
        this.realtime.accept(p.state);
        this.resetForm(p.state);
      }
    } else
      this.error.set(
        error instanceof Error ? error.message : this.t("error.unknown"),
      );
  }
  async run(action: () => Promise<unknown>): Promise<void> {
    this.error.set("");
    try {
      await action();
    } catch (e) {
      this.fail(e);
    }
  }
  async command(
    target: Target,
    type: string,
    payload: unknown = {},
    expectedRevision?: number,
  ): Promise<void> {
    await this.run(async () => {
      const state = this.realtime.state();
      if (!state) throw new Error(this.t("error.noStateYet"));
      const command: Command = {
        commandId: uuid(),
        target,
        type,
        payload,
        expectedRevision: expectedRevision ?? state.revision,
        expectedPlaybackGeneration:
          target === "system" ? null : state.desired[target].playbackGeneration,
        interactionId: null,
        clientSequence: null,
        commit: true,
      };
      const receipt = await this.api.request<Receipt>(
        "POST",
        "/api/commands",
        command,
      );
      this.realtime.receipt.set(receipt);
      this.notice.set(
        receipt.screenOnline
          ? this.t("notice.commandAccepted")
          : this.t("notice.commandOffline"),
      );
      const fresh = await this.api.get<StateEnvelope>("/api/system/state");
      this.realtime.accept(fresh);
    });
  }
  async selectVisual(autoplay: boolean): Promise<void> {
    await this.run(async () => {
      const f = this.visualSource.getRawValue();
      const source: VisualSource =
        f.kind === "localVideo"
          ? { kind: "localVideo", assetId: f.assetId }
          : await this.api.request("POST", "/api/sources/youtube/normalize", {
              url: f.url,
              videoOnly: f.videoOnly,
            });
      await this.command("visual", "setSource", { source, autoplay });
    });
  }
  async selectAudio(autoplay: boolean): Promise<void> {
    const f = this.audioSource.getRawValue();
    const source: AudioSource =
      f.kind === "localFile"
        ? { kind: "localFile", assetId: f.assetId }
        : {
            kind: "remoteAudioUrl",
            url: f.url,
            streamMode: f.streamMode as "auto" | "file" | "live",
          };
    await this.command("audio", "setSource", { source, autoplay });
  }
  async applyGeometry(): Promise<void> {
    await this.command(
      "visual",
      "setTransform",
      this.transform(),
      this.formRevision,
    );
    const state = this.realtime.state();
    if (state && !this.error()) this.resetForm(state);
  }
  geometryTool(tool: "fit" | "center" | "reset"): void {
    let t = this.transform();
    const viewport = this.viewport();
    if (tool === "reset") t = { ...defaultTransform };
    else if (!viewport) {
      this.error.set(this.t("error.viewportRequired"));
      return;
    } else if (tool === "fit") t = fit(t, viewport);
    else t = { ...t, ...centred(t, viewport) };
    this.geometry.patchValue(t);
    this.geometry.markAsDirty();
  }
  resizeDimension(field: "width" | "height", oldValue: number): void {
    if (!this.geometry.controls.lockAspect.value || !oldValue) return;
    const t = this.previewTransform();
    const changed = this.geometry.controls[field].value;
    const other = field === "width" ? "height" : "width";
    this.geometry.controls[other].setValue((t[other] * changed) / oldValue);
  }
  playbackMessage(error: { code: string; message: string } | null): string {
    if (!error) return "";
    const key = "playback." + error.code;
    const localised = this.t(key);
    return localised === key ? error.message : localised;
  }
  use(locale: string): void {
    this.i18n.use(locale as Locale);
  }
  value(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }
  checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
  /** Whole numbers for slider captions, never "-0". */
  round(n: number): number {
    return Math.round(n) || 0;
  }
  label(source: Source | null | undefined): string {
    if (!source) return this.t("source.none");
    if (source.kind === "localVideo")
      return (
        this.videoLibrary()?.items.find((a) => a.id === source.assetId)
          ?.displayName ?? this.t("source.videoMissing")
      );
    if (source.kind === "localFile")
      return (
        this.audioLibrary()?.items.find((a) => a.id === source.assetId)
          ?.displayName ?? this.t("source.audioMissing")
      );
    if (source.kind === "youtubeVideo") return "YouTube · " + source.videoId;
    if (source.kind === "youtubePlaylist")
      return "YouTube playlist · " + source.playlistId;
    try {
      return "Audio · " + new URL(source.url).host;
    } catch {
      return "Remote audio";
    }
  }
  onPointerDown(
    event: PointerEvent,
    svg: HTMLElement | SVGElement,
    mode: "move" | "resize" | "rotate" = "move",
  ): void {
    if (event.button !== 0 || this.drag?.pointer || this.drag?.final) return;
    event.preventDefault();
    event.stopPropagation();
    // preventDefault also keeps the click from focusing the schematic, and the arrow keys need that focus.
    svg.focus({ preventScroll: true });
    const d = this.interaction();
    if (!d) return;
    clearTimeout(d.settle);
    d.settle = undefined;
    svg.setPointerCapture(event.pointerId);
    const box = svg.getBoundingClientRect();
    // The drawn area zooms out when the block overflows, so pointer pixels convert through it.
    const view = this.previewBox();
    const scale = box.width / view.width;
    const initial = this.transform();
    // The rotation centre in client pixels: angles are measured around it as the pointer moves.
    const pivot = centre(initial);
    const pivotX = box.left + (pivot.x - view.x) * scale;
    const pivotY = box.top + (pivot.y - view.y) * scale;
    d.pointer = {
      id: event.pointerId,
      target: svg,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      initial,
      scale,
      pivotX,
      pivotY,
      startAngle: angleAt(pivotX, pivotY, event.clientX, event.clientY),
    };
  }
  onPointerMove(event: PointerEvent): void {
    const p = this.drag?.pointer;
    if (!p || event.pointerId !== p.id || this.drag?.final) return;
    const dx = event.clientX - p.startX,
      dy = event.clientY - p.startY;
    this.live(
      p.mode === "rotate"
        ? rotateBy(
            p.initial,
            p.startAngle,
            angleAt(p.pivotX, p.pivotY, event.clientX, event.clientY),
            event.shiftKey ? 15 : 0,
          )
        : p.mode === "resize"
          ? resizeRotated(
              p.initial,
              dx,
              dy,
              p.scale,
              this.geometry.controls.lockAspect.value,
            )
          : {
              ...p.initial,
              x: p.initial.x + dx / p.scale,
              y: p.initial.y + dy / p.scale,
            },
    );
  }
  onPointerUp(event: PointerEvent): void {
    const p = this.drag?.pointer;
    if (!p || event.pointerId !== p.id) return;
    if (p.target.hasPointerCapture(p.id)) p.target.releasePointerCapture(p.id);
    this.finish();
  }
  /** Video sliders: position moves the centre, size scales about it and rotation turns about it. */
  slideVideo(field: "x" | "y" | "scale" | "rotation", event: Event): void {
    const value = this.value(event),
      t = this.transform(),
      v = this.previewViewport(),
      o = centreOffset(t, v);
    this.live(
      field === "x"
        ? placeCentre(t, v, value, o.y)
        : field === "y"
          ? placeCentre(t, v, o.x, value)
          : field === "scale"
            ? { ...t, scale: value }
            : { ...t, rotation: value },
    );
  }
  settleVideo(): void {
    this.settle(SETTLE_MS);
  }
  /** Back to the middle of the screen at its own size and upright. Width and height are kept. */
  resetVideo(): void {
    this.live({
      ...placeCentre(this.transform(), this.previewViewport(), 0, 0),
      scale: 1,
      rotation: 0,
    });
    this.settle(0);
  }
  /** Arrow keys nudge the video while the schematic has focus: 1 px a press, 10 px with Shift. */
  onSceneKey(event: KeyboardEvent): void {
    const arrow = ARROWS[event.key];
    if (!arrow || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1,
      t = this.transform();
    this.live({ ...t, x: t.x + arrow[0] * step, y: t.y + arrow[1] * step });
    this.settle(SETTLE_MS);
  }
  private interaction(): Interaction | null {
    if (this.drag) return this.drag;
    const state = this.realtime.state();
    if (!state) return null;
    this.drag = {
      id: uuid(),
      sequence: 0,
      generation: state.desired.visual.playbackGeneration,
      pending: null,
      final: false,
      inFlight: false,
    };
    return this.drag;
  }
  /** Shows a transform at once and streams it to the screen within the current interaction. */
  private live(t: Transform): void {
    if (this.drag?.final) {
      this.queued = t;
      this.geometry.patchValue(t);
      return;
    }
    const d = this.interaction();
    if (!d) return;
    clearTimeout(d.settle);
    d.settle = undefined;
    this.geometry.patchValue(t);
    d.pending = t;
    if (!d.timer && !d.inFlight)
      d.timer = setTimeout(() => {
        d.timer = undefined;
        void this.sendDrag();
      }, 50);
  }
  private settle(delay: number): void {
    const d = this.drag;
    if (!d || d.final || d.pointer) return;
    clearTimeout(d.settle);
    d.settle = setTimeout(() => this.finish(), delay);
  }
  private finish(): void {
    const d = this.drag;
    if (!d || d.final) return;
    d.final = true;
    clearTimeout(d.timer);
    clearTimeout(d.settle);
    d.timer = d.settle = undefined;
    d.pending = this.transform();
    void this.sendDrag();
  }
  /**
   * The revision a live command must expect. Any command ends the backend's drag, after which the next
   * step is checked against the current revision again, so the newest one known is always sent.
   */
  private expectedRevision(state: StateEnvelope): number {
    return this.ownRevision.instance === state.serverInstanceId
      ? Math.max(this.ownRevision.revision, state.revision)
      : state.revision;
  }
  private async sendLive(
    command: Omit<Command, "commandId" | "expectedRevision">,
  ): Promise<void> {
    const state = this.realtime.state();
    if (!state) throw new Error(this.t("error.noStateYet"));
    const receipt = await this.api.request<Receipt>("POST", "/api/commands", {
      ...command,
      commandId: uuid(),
      expectedRevision: this.expectedRevision(state),
    } satisfies Command);
    if (
      receipt.serverInstanceId !== this.ownRevision.instance ||
      receipt.revision > this.ownRevision.revision
    )
      this.ownRevision = {
        instance: receipt.serverInstanceId,
        revision: receipt.revision,
      };
  }
  private async sendDrag(): Promise<void> {
    const d = this.drag;
    if (!d || d.inFlight || !d.pending) return;
    if (this.circleSending) {
      // Live commands go one at a time, or each would expect a revision the other is about to change.
      d.timer ??= setTimeout(() => {
        d.timer = undefined;
        void this.sendDrag();
      }, 50);
      return;
    }
    d.inFlight = true;
    const payload = d.pending;
    const final = d.final;
    d.pending = null;
    try {
      await this.sendLive({
        target: "visual",
        type: "setTransform",
        payload,
        expectedPlaybackGeneration: d.generation,
        interactionId: d.id,
        clientSequence: ++d.sequence,
        commit: final,
      });
      if (final) {
        const state = await this.api.get<StateEnvelope>("/api/system/state");
        // Released only now, so an edit made meanwhile waits in the queue instead of racing the commit.
        this.drag = undefined;
        this.realtime.accept(state);
        this.resetForm(state);
        const next = this.queued;
        this.queued = null;
        if (next) {
          this.live(next);
          this.settle(SETTLE_MS);
        }
      }
    } catch (e) {
      if (this.drag === d) this.drag = undefined;
      this.queued = null;
      this.fail(e);
    } finally {
      d.inFlight = false;
      if (this.drag === d && d.pending)
        d.timer = setTimeout(
          () => {
            d.timer = undefined;
            void this.sendDrag();
          },
          d.final ? 0 : 50,
        );
    }
  }
  editCircle(patch: Partial<Circle>): void {
    const next = { ...this.circle(), ...patch };
    this.circleDraft.set(next);
    this.circlePending = next;
    void this.sendCircle();
  }
  /** Back to the centre of the screen at the default diameter. Colour and visibility are kept. */
  resetCircle(): void {
    this.editCircle({
      x: defaultCircle.x,
      y: defaultCircle.y,
      diameter: defaultCircle.diameter,
    });
  }
  /**
   * One setCircle at a time, always the newest value: a slider fires far faster than a command
   * round-trips, so the positions it passed through are dropped rather than queued.
   */
  private async sendCircle(): Promise<void> {
    if (this.circleSending) return;
    this.circleSending = true;
    try {
      while (this.circlePending) {
        while (this.drag?.inFlight)
          await new Promise((resolve) => setTimeout(resolve, 20));
        const payload = this.circlePending;
        this.circlePending = null;
        await this.sendLive({
          target: "system",
          type: "setCircle",
          payload,
          expectedPlaybackGeneration: null,
          interactionId: null,
          clientSequence: null,
          commit: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      this.realtime.accept(
        await this.api.get<StateEnvelope>("/api/system/state"),
      );
    } catch (e) {
      this.circlePending = null;
      this.fail(e);
    } finally {
      this.circleSending = false;
      if (this.circlePending) void this.sendCircle();
      else this.circleDraft.set(null);
    }
  }
  async upload(kind: "videos" | "audio", event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    this.uploadAbort = new AbortController();
    this.uploadProgress.set(0);
    await this.run(async () => {
      for (const file of files) {
        await this.api.upload(
          kind,
          file,
          (n) => this.uploadProgress.set(n),
          this.uploadAbort!.signal,
        );
        await this.refreshLibraries();
      }
    });
    this.uploadProgress.set(null);
    input.value = "";
  }
  cancelUpload(): void {
    this.uploadAbort?.abort();
  }
  async renameAsset(kind: "videos" | "audio", asset: Asset): Promise<void> {
    const name = window.prompt(this.t("prompt.assetName"), asset.displayName);
    if (name === null) return;
    await this.run(async () => {
      await this.api.request(
        "PATCH",
        `/api/library/${kind}/${asset.id}`,
        { displayName: name },
        (kind === "videos" ? this.videoLibrary() : this.audioLibrary())!
          .documentRevision,
      );
      await this.refreshLibraries();
    });
  }
  async deleteAsset(kind: "videos" | "audio", asset: Asset): Promise<void> {
    if (
      !window.confirm(
        this.t("confirm.deleteAsset", { name: asset.displayName }),
      )
    )
      return;
    await this.run(async () => {
      await this.api.request(
        "DELETE",
        `/api/library/${kind}/${asset.id}`,
        undefined,
        (kind === "videos" ? this.videoLibrary() : this.audioLibrary())!
          .documentRevision,
      );
      await this.refreshLibraries();
    });
  }
  chooseAsset(kind: "videos" | "audio", asset: Asset): void {
    if (kind === "videos")
      this.visualSource.patchValue({ kind: "localVideo", assetId: asset.id });
    else this.audioSource.patchValue({ kind: "localFile", assetId: asset.id });
    this.tab.set("studio");
  }
  async savePreset(kind: "visual" | "audio"): Promise<void> {
    const state = this.realtime.state();
    if (!state) return;
    await this.run(async () => {
      const channel = state.desired[kind];
      const body = {
        name: this.presetName.value,
        source: channel.source,
        playback: channel.playback,
        initialPositionSeconds: 0,
        ...(kind === "visual"
          ? {
              visible: state.desired.visual.visible,
              transform: state.desired.visual.transform,
              referenceViewport: this.viewport(),
              circle: state.desired.circle,
            }
          : {}),
      };
      await this.api.request("POST", "/api/presets/" + kind, body);
      await this.refreshPresets();
      this.notice.set(this.t("notice.presetSaved"));
    });
  }
  async applyPreset(
    kind: "visual" | "audio",
    id: string,
    autoplay: boolean,
  ): Promise<void> {
    await this.command("system", "applyPresets", {
      [kind + "PresetId"]: id,
      autoplay,
    });
  }
  async renamePreset(
    kind: "visual" | "audio",
    preset: VisualPreset | AudioPreset,
  ): Promise<void> {
    const name = window.prompt(this.t("prompt.presetName"), preset.name);
    if (name === null) return;
    const { id, createdAtUtc: _, updatedAtUtc: __, ...body } = preset;
    await this.run(async () => {
      await this.api.request(
        "PUT",
        `/api/presets/${kind}/${id}`,
        { ...body, name },
        (kind === "visual" ? this.visualPresets() : this.audioPresets())!
          .documentRevision,
      );
      await this.refreshPresets();
    });
  }
  async deletePreset(
    kind: "visual" | "audio",
    preset: VisualPreset | AudioPreset,
  ): Promise<void> {
    if (!window.confirm(this.t("confirm.deletePreset", { name: preset.name })))
      return;
    await this.run(async () => {
      await this.api.request(
        "DELETE",
        `/api/presets/${kind}/${preset.id}`,
        undefined,
        (kind === "visual" ? this.visualPresets() : this.audioPresets())!
          .documentRevision,
      );
      await this.refreshPresets();
    });
  }
  async saveStartup(): Promise<void> {
    await this.run(async () => {
      const startup = await this.api.request<Startup>(
        "PUT",
        "/api/settings/startup",
        this.startupForm.getRawValue(),
        this.startup()!.documentRevision,
      );
      this.startup.set(startup);
      this.startupForm.markAsPristine();
      this.notice.set(this.t("notice.startupSaved"));
    });
  }
  async applyStartup(): Promise<void> {
    const s = this.startupForm.getRawValue();
    await this.command("system", "applyPresets", {
      visualPresetId: s.startVisualOnBoot ? s.defaultVisualPresetId : null,
      audioPresetId: s.startAudioOnBoot ? s.defaultAudioPresetId : null,
      autoplay: true,
    });
  }
  async loadDiagnostics(): Promise<void> {
    this.tab.set("diagnostics");
    await this.run(async () =>
      this.diagnostics.set(await this.api.get("/api/system/diagnostics")),
    );
  }
  /** Pauses or resumes one channel. "play" also restarts a stopped or finished source. */
  async toggle(target: "visual" | "audio"): Promise<void> {
    const channel = this.realtime.state()?.desired[target];
    if (!channel?.source || this.pendingAction()) return;
    this.pendingAction.set(target);
    try {
      await this.command(
        target,
        channel.transport === "playing" ? "pause" : "play",
      );
    } finally {
      this.pendingAction.set(null);
    }
  }
  /** One button for the whole scene: pauses whatever plays, otherwise resumes everything that has a source. */
  async toggleAll(): Promise<void> {
    if (this.pendingAction()) return;
    const pause = this.anyPlaying();
    this.pendingAction.set("all");
    try {
      for (const target of this.channels) {
        const channel = this.realtime.state()?.desired[target];
        if (!channel?.source || (channel.transport === "playing") !== pause)
          continue;
        await this.command(target, pause ? "pause" : "play");
        if (this.error()) break;
      }
    } finally {
      this.pendingAction.set(null);
    }
  }
  async quickPreset(kind: "visual" | "audio", id: string): Promise<void> {
    if (this.pendingAction()) return;
    this.pendingAction.set(id);
    try {
      await this.applyPreset(kind, id, true);
    } finally {
      this.pendingAction.set(null);
    }
  }
  /** What a channel is doing, as the dashboard names it. */
  channelState(
    target: "visual" | "audio",
  ): "noSource" | "failed" | "starting" | "playing" | "paused" | "stopped" {
    const state = this.realtime.state();
    const channel = state?.desired[target];
    const observed = state?.observed[target];
    if (!channel?.source) return "noSource";
    if (observed?.status === "error" || observed?.status === "blocked")
      return "failed";
    if (channel.transport !== "playing") return channel.transport;
    // Without a screen nothing can confirm playback, and "starting" would never end.
    return !state?.screen.connected || observed?.status === "playing"
      ? "playing"
      : "starting";
  }
  /** How far the channel has played, 0–100, or null for live streams and unknown lengths. */
  progress(target: "visual" | "audio"): number | null {
    const observed = this.realtime.state()?.observed[target];
    if (!observed?.durationSeconds || observed.capabilities.isLive) return null;
    return Math.min(
      100,
      (observed.positionSeconds / observed.durationSeconds) * 100,
    );
  }
  /** m:ss, or h:mm:ss past an hour. */
  clock(seconds: number | null | undefined): string {
    const total = Math.max(0, Math.floor(seconds ?? 0));
    const h = Math.floor(total / 3600),
      m = Math.floor((total % 3600) / 60),
      s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }
  async refreshDevice(): Promise<void> {
    try {
      const status = await this.api.get<DeviceStatus>("/api/device");
      this.device.set(status);
      if (!this.deviceSending) this.volumeDraft.set(null);
    } catch {
      this.device.set(null);
    }
  }
  /** −/+ move to the next multiple of 5, so a volume of 33 goes to 30 or 35. */
  stepVolume(direction: -1 | 1): void {
    const current = this.deviceVolume();
    if (current === null) return;
    this.changeVolume(
      direction > 0
        ? Math.floor(current / 5) * 5 + 5
        : Math.ceil(current / 5) * 5 - 5,
    );
  }
  changeVolume(percent: number): void {
    const volumePercent = Math.max(0, Math.min(100, Math.round(percent)));
    this.volumeDraft.set(volumePercent);
    this.sendDevice({ volumePercent });
  }
  toggleMute(): void {
    const muted = this.device()?.muted;
    if (muted != null) this.sendDevice({ muted: !muted });
  }
  /** One request at a time; a newer value replaces one still waiting, so repeated taps never pile up. */
  private sendDevice(change: {
    volumePercent?: number;
    muted?: boolean;
  }): void {
    this.devicePending = { ...this.devicePending, ...change };
    void this.flushDevice();
  }
  private async flushDevice(): Promise<void> {
    if (this.deviceSending) return;
    this.deviceSending = true;
    this.deviceError.set("");
    try {
      while (this.devicePending) {
        const body = this.devicePending;
        this.devicePending = null;
        this.device.set(
          await this.api.request<DeviceStatus>(
            "POST",
            "/api/device/audio",
            body,
          ),
        );
      }
    } catch (e) {
      this.devicePending = null;
      this.volumeDraft.set(null);
      this.deviceError.set(
        e instanceof ApiError
          ? e.problem.title
          : e instanceof Error
            ? e.message
            : this.t("error.unknown"),
      );
      void this.refreshDevice();
    } finally {
      this.deviceSending = false;
      this.volumeDraft.set(null);
    }
  }
  ngOnDestroy(): void {
    clearInterval(this.devicePoll);
    this.geometrySubscription.unsubscribe();
    this.uploadAbort?.abort();
    clearTimeout(this.drag?.timer);
    clearTimeout(this.drag?.settle);
    void this.realtime.stop();
  }
}
