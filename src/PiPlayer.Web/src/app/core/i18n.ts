import { Injectable, signal } from "@angular/core";
import { EN, RU } from "./locales";

export type Locale = "en" | "ru";
export const LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "ru", label: "Русский" },
];
const STORAGE_KEY = "piplayer.locale";
const DICTIONARIES: Record<Locale, Record<string, string>> = { en: EN, ru: RU };

function stored(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "en" || value === "ru" ? value : null;
  } catch {
    return null; // private mode or blocked storage: fall back to the browser language
  }
}

/**
 * Runtime translation, not build-time. The appliance ships one bundle that the backend serves from
 * wwwroot, so a per-locale build would mean a second bundle and a language decision on the server.
 * A dictionary behind a signal switches instantly and keeps the release a single artifact.
 */
@Injectable({ providedIn: "root" })
export class I18n {
  readonly locale = signal<Locale>(
    stored() ??
      (typeof navigator !== "undefined" &&
      navigator.language?.toLowerCase().startsWith("ru")
        ? "ru"
        : "en"),
  );
  constructor() {
    this.apply(this.locale());
  }
  /** Reads the locale signal, so every template that calls it re-renders on a language change. */
  readonly t = (key: string, params?: Record<string, string | number>) => {
    const dictionary = DICTIONARIES[this.locale()];
    let text = dictionary[key] ?? EN[key] ?? key;
    if (params)
      for (const [name, value] of Object.entries(params))
        text = text.split(`{${name}}`).join(String(value));
    return text;
  };
  use(locale: Locale): void {
    this.locale.set(locale);
    this.apply(locale);
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* the choice simply does not survive a reload */
    }
  }
  private apply(locale: Locale): void {
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }
}
