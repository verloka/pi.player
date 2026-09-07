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
  Collection,
  Command,
  defaultTransform,
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
  corners,
  fit,
  millimetresToPixels,
  previewBounds,
  resizeRotated,
  rotateBy,
  rotateHandle,
} from "../shared/geometry";

@Component({
  selector: "app-admin",
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: "./admin.component.html",
})
export class AdminComponent implements OnInit, OnDestroy {
  readonly booting = signal(true);
  readonly error = signal("");
  readonly notice = signal("");
  readonly tab = signal("studio");
  readonly busy = signal(false);
  readonly uploadProgress = signal<number | null>(null);
  readonly diagnostics = signal<unknown>(null);
  readonly videoLibrary = signal<Collection<Asset> | null>(null);
  readonly audioLibrary = signal<Collection<Asset> | null>(null);
  readonly visualPresets = signal<Collection<VisualPreset> | null>(null);
  readonly audioPresets = signal<Collection<AudioPreset> | null>(null);
  readonly startup = signal<Startup | null>(null);
  readonly previewTransform = signal<Transform>({ ...defaultTransform });
  readonly viewport = computed<Viewport | null>(
    () => this.realtime.state()?.screen.descriptor?.viewport ?? null,
  );
  readonly previewViewport = computed<Viewport>(
    () =>
      this.viewport() ?? { cssWidth: 960, cssHeight: 540, devicePixelRatio: 1 },
  );
  /**
   * Physical alignment ring, fixed to the screen rather than to the block: it marks where a real
   * 225 mm circle sits on the panel, so moving, scaling or rotating the video never moves it. It is
   * decoration only and takes no pointer input.
   */
  readonly guideCircle = computed(() => {
    const guide = this.realtime.state()?.guide;
    if (!guide || guide.diameterMillimetres <= 0) return null;
    const viewport = this.previewViewport();
    const radius =
      millimetresToPixels(
        guide.diameterMillimetres,
        viewport,
        guide.screenWidthMillimetres,
      ) / 2;
    return {
      cx: viewport.cssWidth / 2,
      cy: viewport.cssHeight / 2,
      radius,
      millimetres: guide.diameterMillimetres,
      calibrated: guide.screenWidthMillimetres > 0,
    };
  });
  readonly previewBox = computed(() => {
    const ring = this.guideCircle();
    return previewBounds(
      this.previewTransform(),
      this.previewViewport(),
      ring
        ? {
            minX: ring.cx - ring.radius,
            minY: ring.cy - ring.radius,
            maxX: ring.cx + ring.radius,
            maxY: ring.cy + ring.radius,
          }
        : null,
    );
  });
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
  private drag?: {
    id: string;
    startX: number;
    startY: number;
    initial: Transform;
    scale: number;
    mode: "move" | "resize" | "rotate";
    pivotX: number;
    pivotY: number;
    startAngle: number;
    sequence: number;
    revision: number;
    generation: number;
    pointerId: number;
    target: Element;
    pending: Transform | null;
    final: boolean;
    inFlight: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };
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
    svg: Element,
    mode: "move" | "resize" | "rotate" = "move",
  ): void {
    if (event.button !== 0 || this.drag) return;
    const state = this.realtime.state();
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
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
    this.drag = {
      id: uuid(),
      startX: event.clientX,
      startY: event.clientY,
      initial,
      scale,
      mode,
      pivotX,
      pivotY,
      startAngle: angleAt(pivotX, pivotY, event.clientX, event.clientY),
      sequence: 0,
      revision: state.revision,
      generation: state.desired.visual.playbackGeneration,
      pointerId: event.pointerId,
      target: svg,
      pending: null,
      final: false,
      inFlight: false,
    };
  }
  onPointerMove(event: PointerEvent): void {
    const d = this.drag;
    if (!d || event.pointerId !== d.pointerId || d.final) return;
    const dx = event.clientX - d.startX,
      dy = event.clientY - d.startY;
    const t =
      d.mode === "rotate"
        ? rotateBy(
            d.initial,
            d.startAngle,
            angleAt(d.pivotX, d.pivotY, event.clientX, event.clientY),
            event.shiftKey ? 15 : 0,
          )
        : d.mode === "resize"
          ? resizeRotated(
              d.initial,
              dx,
              dy,
              d.scale,
              this.geometry.controls.lockAspect.value,
            )
          : {
              ...d.initial,
              x: d.initial.x + dx / d.scale,
              y: d.initial.y + dy / d.scale,
            };
    this.geometry.patchValue(t);
    d.pending = t;
    if (!d.timer && !d.inFlight)
      d.timer = setTimeout(() => {
        if (this.drag) this.drag.timer = undefined;
        void this.sendDrag();
      }, 50);
  }
  onPointerUp(event: PointerEvent): void {
    const d = this.drag;
    if (!d || event.pointerId !== d.pointerId) return;
    d.final = true;
    d.pending = this.transform();
    clearTimeout(d.timer);
    d.timer = undefined;
    if (d.target.hasPointerCapture(d.pointerId))
      d.target.releasePointerCapture(d.pointerId);
    void this.sendDrag();
  }
  private async sendDrag(): Promise<void> {
    const d = this.drag;
    if (!d || d.inFlight || !d.pending) return;
    d.inFlight = true;
    const payload = d.pending;
    const final = d.final;
    d.pending = null;
    try {
      const command: Command = {
        commandId: uuid(),
        target: "visual",
        type: "setTransform",
        payload,
        expectedRevision: d.revision,
        expectedPlaybackGeneration: d.generation,
        interactionId: d.id,
        clientSequence: ++d.sequence,
        commit: final,
      };
      await this.api.request("POST", "/api/commands", command);
      if (final) {
        this.drag = undefined;
        const state = await this.api.get<StateEnvelope>("/api/system/state");
        this.realtime.accept(state);
        this.resetForm(state);
      }
    } catch (e) {
      this.drag = undefined;
      this.fail(e);
    } finally {
      d.inFlight = false;
      if (this.drag?.pending)
        this.drag.timer = setTimeout(
          () => {
            if (this.drag) this.drag.timer = undefined;
            void this.sendDrag();
          },
          this.drag.final ? 0 : 50,
        );
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
  ngOnDestroy(): void {
    this.geometrySubscription.unsubscribe();
    this.uploadAbort?.abort();
    clearTimeout(this.drag?.timer);
    void this.realtime.stop();
  }
}
