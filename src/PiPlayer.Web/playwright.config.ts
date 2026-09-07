import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://localhost:5000",
    // The panel follows the browser language, so pin one: otherwise the specs would read Russian on a
    // Russian workstation and English on an English one.
    locale: "en-US",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    // Matches the Raspberry Pi kiosk launcher. autoplay.spec.ts launches its own strict browser.
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  reporter: [
    ["list"],
    ["json", { outputFile: "../../artifacts/test-results/browser.json" }],
  ],
});
