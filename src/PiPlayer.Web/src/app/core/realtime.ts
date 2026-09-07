import { Injectable, signal } from "@angular/core";
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from "@microsoft/signalr";
import { Receipt, ScreenDescriptor, StateEnvelope } from "./contracts";
@Injectable({ providedIn: "root" })
export class Realtime {
  readonly state = signal<StateEnvelope | null>(null);
  readonly connection = signal("offline");
  readonly receipt = signal<Receipt | null>(null);
  readonly registered = signal(false);
  readonly libraryVersion = signal(0);
  onSnapshot: ((state: StateEnvelope) => void) | null = null;
  private hub: HubConnection | null = null;
  private closed = true;
  private timer?: ReturnType<typeof setTimeout>;
  private role: "admin" | "screen" = "admin";
  private descriptor?: () => ScreenDescriptor;
  private retiredInstances = new Set<string>();
  accept(state: StateEnvelope): void {
    const old = this.state();
    if (this.retiredInstances.has(state.serverInstanceId)) return;
    if (old && old.serverInstanceId !== state.serverInstanceId)
      this.retiredInstances.add(old.serverInstanceId);
    if (
      old?.serverInstanceId === state.serverInstanceId &&
      (state.revision < old.revision ||
        (state.revision === old.revision &&
          state.telemetrySequence < old.telemetrySequence))
    )
      return;
    this.state.set(state);
    this.onSnapshot?.(state);
  }
  async start(
    role: "admin" | "screen",
    descriptor?: () => ScreenDescriptor,
  ): Promise<void> {
    await this.stop();
    this.closed = false;
    this.role = role;
    this.descriptor = descriptor;
    const hub = new HubConnectionBuilder()
      .withUrl("/hubs/screen")
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (ctx) =>
          Math.min(30000, 1000 * 2 ** Math.min(ctx.previousRetryCount, 5)) *
          (0.8 + Math.random() * 0.4),
      })
      .configureLogging(LogLevel.Error)
      .build();
    this.hub = hub;
    for (const event of [
      "state.sync",
      "state.updated",
      "playback.updated",
      "screen.statusChanged",
    ])
      hub.on(event, (s: StateEnvelope) => this.accept(s));
    hub.on("command.result", (r: Receipt) => this.receipt.set(r));
    hub.on("library.updated", () => this.libraryVersion.update((n) => n + 1));
    hub.onreconnecting(() => {
      this.connection.set("reconnecting");
      this.schedule();
    });
    hub.onreconnected(() => {
      void this.register().catch(() => this.schedule());
    });
    hub.onclose(() => {
      this.connection.set("offline");
      this.registered.set(false);
      this.schedule();
    });
    await this.connect();
  }
  private schedule(): void {
    if (!this.closed) {
      clearTimeout(this.timer);
      this.timer = setTimeout(
        () => void this.connect(),
        2000 + Math.random() * 1000,
      );
    }
  }
  private async connect(): Promise<void> {
    if (this.closed || !this.hub) return;
    try {
      this.connection.set("connecting");
      if (this.hub.state === HubConnectionState.Disconnected)
        await this.hub.start();
      if (this.hub.state === HubConnectionState.Connected)
        await this.register();
      else this.schedule();
    } catch {
      this.connection.set("reconnecting");
      this.schedule();
    }
  }
  async register(): Promise<void> {
    if (!this.hub || this.closed) return;
    if (this.role === "admin") {
      this.accept(await this.hub.invoke<StateEnvelope>("RegisterAdmin"));
      this.registered.set(true);
    } else {
      const result = await this.hub.invoke<{
        accepted: boolean;
        state: StateEnvelope | null;
      }>("RegisterScreen", this.descriptor!());
      this.registered.set(result.accepted);
      if (!result.accepted) {
        this.connection.set("screenAlreadyConnected");
        this.schedule();
        return;
      }
      if (result.state) this.accept(result.state);
    }
    this.connection.set("online");
  }
  invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.hub || this.hub.state !== HubConnectionState.Connected)
      return Promise.reject(
        new Error("There is no connection to the backend."),
      );
    return this.hub.invoke<T>(method, ...args);
  }
  async stop(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    const hub = this.hub;
    this.hub = null;
    this.registered.set(false);
    if (hub) await hub.stop();
  }
}
