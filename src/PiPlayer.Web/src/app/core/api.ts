import { Injectable } from "@angular/core";
import { uuid } from "./contracts";
export interface Problem {
  code: string;
  title: string;
  status: number;
  details?: unknown;
  state?: import("./contracts").StateEnvelope;
}
export class ApiError extends Error {
  constructor(public problem: Problem) {
    super(problem.title || problem.code);
  }
}
@Injectable({ providedIn: "root" })
export class Api {
  // Editor identity for drag arbitration only. The backend has no accounts and grants nothing for it.
  readonly clientId = uuid();
  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    revision?: number,
  ): Promise<T> {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        "X-PiPlayer-Client-Id": this.clientId,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(revision !== undefined ? { "If-Match": `"${revision}"` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      let problem: Problem;
      try {
        problem = (await response.json()) as Problem;
      } catch {
        problem = {
          code: "requestFailed",
          title: `HTTP ${response.status}`,
          status: response.status,
        };
      }
      throw new ApiError(problem);
    }
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }
  upload(
    kind: string,
    file: File,
    progress: (n: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/library/" + kind);
      xhr.setRequestHeader("X-PiPlayer-Client-Id", this.clientId);
      const abort = () => xhr.abort();
      signal.addEventListener("abort", abort, { once: true });
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          progress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          try {
            reject(new ApiError(JSON.parse(xhr.responseText) as Problem));
          } catch {
            reject(new Error(`Upload HTTP ${xhr.status}`));
          }
        }
      };
      xhr.onerror = () =>
        reject(new Error("The connection was lost during the upload."));
      xhr.onabort = () => reject(new Error("Upload cancelled."));
      xhr.onloadend = () => signal.removeEventListener("abort", abort);
      const data = new FormData();
      data.append("file", file);
      if (signal.aborted) {
        reject(new Error("Upload cancelled."));
        return;
      }
      xhr.send(data);
    });
  }
}
