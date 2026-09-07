// Chromium refuses audible playback until the page has been interacted with. The Raspberry Pi kiosk has
// no keyboard or mouse, so a human gesture can never arrive there: the launcher passes
// --autoplay-policy=no-user-gesture-required and playback simply starts. This gate is the safety net for
// every other case. Adapters fall back to muted playback and park a resume callback here; the gate then
// unlocks itself as soon as the browser starts permitting sound, and a real gesture also works.
//
// The self-check plays a one-second silent WAV unmuted at full volume. The autoplay policy inspects the
// element, not the samples, so the probe is a faithful test that makes no sound and disturbs nothing.
type Resume = () => void;
type Watcher = (blocked: boolean) => void;
const GESTURES = ["pointerdown", "mousedown", "touchstart", "keydown"] as const;
const PROBE_INTERVAL_MS = 5000;

export class AutoplayGate {
  /** Set to null to disable the unattended self-check (unit tests drive the gate directly). */
  probeUrl: string | null = "/media/silence.wav";
  private resumes = new Set<Resume>();
  private watchers = new Set<Watcher>();
  private armed = false;
  private granted = false;
  private probing = false;
  private timer?: ReturnType<typeof setInterval>;
  private handler = () => this.unlock();
  get unlocked(): boolean {
    return this.granted;
  }
  get blocked(): boolean {
    return !this.granted && this.resumes.size > 0;
  }
  watch(watcher: Watcher): () => void {
    this.watchers.add(watcher);
    watcher(this.blocked);
    return () => this.watchers.delete(watcher);
  }
  /** Play what you can now, then hand us the callback that finishes the job once sound is permitted. */
  require(resume: Resume): void {
    if (this.granted) {
      resume();
      return;
    }
    this.resumes.add(resume);
    this.arm();
    this.announce();
  }
  cancel(resume: Resume): void {
    if (this.resumes.delete(resume)) {
      if (this.resumes.size === 0) this.disarm();
      this.announce();
    }
  }
  unlock(): void {
    if (this.granted) return;
    this.granted = true;
    this.disarm();
    const pending = [...this.resumes];
    this.resumes.clear();
    this.announce();
    for (const resume of pending)
      try {
        resume();
      } catch {
        /* one stalled channel must not hold back the others */
      }
  }
  reset(): void {
    this.disarm();
    this.resumes.clear();
    this.granted = false;
  }
  private arm(): void {
    if (this.armed || typeof document === "undefined") return;
    this.armed = true;
    for (const event of GESTURES)
      document.addEventListener(event, this.handler, {
        capture: true,
        passive: true,
      });
    if (this.probeUrl !== null) {
      void this.check();
      this.timer = setInterval(() => void this.check(), PROBE_INTERVAL_MS);
    }
  }
  private disarm(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    if (!this.armed || typeof document === "undefined") return;
    this.armed = false;
    for (const event of GESTURES)
      document.removeEventListener(event, this.handler, { capture: true });
  }
  /** Ask the browser whether audible playback is allowed yet, without making a sound. */
  private async check(): Promise<void> {
    if (this.granted || this.probing || this.probeUrl === null) return;
    this.probing = true;
    const probe = new Audio(this.probeUrl);
    probe.muted = false;
    probe.volume = 1;
    try {
      const started = probe.play();
      // A runtime without a real media stack returns undefined; that is not an answer, so keep waiting.
      if (typeof started?.then !== "function") return;
      await started;
      if (!probe.paused) this.unlock();
    } catch {
      /* still refused: the interval asks again */
    } finally {
      probe.pause();
      probe.removeAttribute("src");
      this.probing = false;
    }
  }
  private announce(): void {
    const blocked = this.blocked;
    for (const watcher of [...this.watchers]) watcher(blocked);
  }
}
export const autoplayGate = new AutoplayGate();
