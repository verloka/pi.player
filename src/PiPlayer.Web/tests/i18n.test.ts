import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18n } from "../src/app/core/i18n";
import { EN, RU } from "../src/app/core/locales";

describe("runtime localisation", () => {
  beforeEach(() => localStorage.clear());

  it("keeps both dictionaries on exactly the same keys", () => {
    // A key present in only one language would silently fall back and look untranslated.
    expect(Object.keys(RU).sort()).toEqual(Object.keys(EN).sort());
    expect(Object.keys(EN).length).toBeGreaterThan(100);
    expect(Object.values(EN).every((value) => value.length > 0)).toBe(true);
    expect(Object.values(RU).every((value) => value.length > 0)).toBe(true);
  });

  it("no English string is left in the Russian dictionary by accident", () => {
    // Words that legitimately stay identical in both: product and protocol names.
    const shared = new Set([
      "geometry.x",
      "geometry.y",
      "option.youtube",
      "library.videoLimits",
      "library.audioLimits",
    ]);
    const untranslated = Object.keys(EN).filter(
      (key) => !shared.has(key) && EN[key] === RU[key],
    );
    expect(untranslated).toEqual([]);
  });

  it("starts in English, follows a Russian browser and remembers a choice", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("en-GB");
    expect(new I18n().locale()).toBe("en");
    vi.spyOn(navigator, "language", "get").mockReturnValue("ru-RU");
    const russian = new I18n();
    expect(russian.locale()).toBe("ru");
    expect(russian.t("tab.studio")).toBe(RU["tab.studio"]);
    russian.use("en");
    expect(russian.t("tab.studio")).toBe(EN["tab.studio"]);
    expect(document.documentElement.lang).toBe("en");
    // A later session picks the stored choice over the browser language.
    expect(new I18n().locale()).toBe("en");
  });

  it("fills placeholders and falls back to the key it does not know", () => {
    const i18n = new I18n();
    i18n.use("en");
    expect(i18n.t("confirm.deleteAsset", { name: "clip.mp4" })).toContain(
      "clip.mp4",
    );
    expect(i18n.t("nothing.here")).toBe("nothing.here");
  });
});
