import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("mobile shell", () => {
  it("keeps the shared stream inside the Capacitor app and omits push", () => {
    const config = readFileSync("apps/mobile/capacitor.config.ts", "utf8");
    const app = readFileSync("apps/desktop/src/App.vue", "utf8");
    const host = readFileSync("apps/desktop/src/mobile-host.ts", "utf8");
    const activity = readFileSync(
      "apps/mobile/android/app/src/main/java/app/shakespeare/mobile/MainActivity.java",
      "utf8",
    );
    const plugin = readFileSync(
      "apps/mobile/android/app/src/main/java/app/shakespeare/mobile/ShakespearePlugin.java",
      "utf8",
    );
    const manifest = readFileSync("apps/mobile/android/app/src/main/AndroidManifest.xml", "utf8");
    const style = readFileSync("apps/desktop/src/style.css", "utf8");

    expect(config).toContain('webDir: "../desktop/dist"');
    expect(app).toContain('data-testid="message-row"');
    expect(app).toContain('data-testid="download-file"');
    expect(app).toContain('data-testid="show-catch-up"');
    expect(app).toContain("createMobileHost()");
    expect(host).toContain('registerPlugin<ShakespeareBridge>("Shakespeare")');
    expect(activity).toContain("registerPlugin(ShakespearePlugin.class)");
    expect(plugin).toContain("10.0.2.2");
    expect(plugin).toContain("127.0.0.1");
    expect(plugin).not.toContain("0.0.0.0");
    expect(style).toContain("max-width: 40rem");
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).not.toContain("firebase");
    expect(existsSync("apps/mobile/android/app/google-services.json")).toBe(false);
  });
});
