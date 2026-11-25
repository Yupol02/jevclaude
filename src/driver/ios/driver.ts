import type { ChildProcess } from "node:child_process";
import type { UiSnapshot } from "../../core/uitree.js";
import { type Driver, sleep } from "../types.js";
import { crashReportsSince, simctl, startVideo } from "./simctl.js";
import { WdaClient } from "./wda.js";
import { parseIosXml } from "./xml.js";

/** iOS simulator driver: WebDriverAgent for UI, `xcrun simctl` for device-level work. */
export class IosDriver implements Driver {
  readonly platform = "ios" as const;
  readonly unicodeInput = true;
  readonly fastSnapshot = true;
  private mark = Date.now();
  private recorder?: ChildProcess;
  private recordPath?: string;
  private lastSize = { width: 390, height: 844 };

  private constructor(
    readonly id: string,
    private readonly wda: WdaClient,
  ) {}

  static async connect(udid: string, wdaUrl?: string): Promise<IosDriver> {
    const wda = new WdaClient(wdaUrl);
    if (!(await wda.status())) {
      throw new Error(
        `WebDriverAgent is not reachable at ${wda.baseUrl}. Run \`jevclaude setup ios\` to install and start it on the simulator.`,
      );
    }
    await wda.ensureSession();
    return new IosDriver(udid, wda);
  }

  get name() {
    return `ios/wda ${this.id}`;
  }

  async snapshot(): Promise<UiSnapshot> {
    const snap = parseIosXml(await this.wda.source());
    if (snap.screen.width) this.lastSize = snap.screen;
    return snap;
  }

  async tap(x: number, y: number) {
    await this.wda.tap(x, y);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300) {
    await this.wda.drag(x1, y1, x2, y2, Math.max(0.05, durationMs / 1000));
  }

  async typeText(text: string, _target?: unknown) {
    await this.wda.keys(text);
  }

  async pressKey(key: string) {
    switch (key.toLowerCase()) {
      case "enter":
        return void (await this.wda.keys("\n"));
      case "home":
        return void (await this.wda.home());
      case "back":
        return this.back();
      case "delete":
        return void (await this.wda.keys("\b"));
      case "tab":
        return void (await this.wda.keys("\t"));
      default:
        throw new Error(`key "${key}" is not supported on iOS (use enter, home, back, delete, tab)`);
    }
  }

  /** iOS has no system back: tap the navigation bar's back button if present, else edge-swipe. */
  async back() {
    const snap = await this.snapshot();
    const btn = snap.elements.find(
      (e) => e.cls === "Button" && e.bounds.top < 120 && e.bounds.left < 30 && (e.text || e.desc || e.resourceId),
    );
    if (btn) {
      await this.wda.tap((btn.bounds.left + btn.bounds.right) / 2, (btn.bounds.top + btn.bounds.bottom) / 2);
      return;
    }
    const { width, height } = this.lastSize;
    await this.wda.drag(2, height / 2, width * 0.75, height / 2, 0.25);
  }

  async hideKeyboard() {
    await this.wda.dismissKeyboard().catch(() => {});
  }

  async launch(app: string) {
    await this.wda.launch(app);
  }

  async openUrl(url: string, _app?: string) {
    await this.wda.openUrl(url);
  }

  async stop(app: string) {
    await this.wda.terminate(app).catch(() => {});
  }

  foregroundApp() {
    return this.wda.activeApp();
  }

  async markLogs() {
    this.mark = Date.now();
  }

  crashLogs(app: string) {
    return crashReportsSince(app, this.mark);
  }

  screenshot() {
    return this.wda.screenshot().catch(async () => {
      // Fallback via simctl when WDA can't screenshot (e.g. while an alert is animating).
      const { execFile } = await import("node:child_process");
      return new Promise<Buffer>((resolve, reject) =>
        execFile(
          "xcrun",
          ["simctl", "io", this.id, "screenshot", "--type=png", "-"],
          { encoding: "buffer", maxBuffer: 64 << 20 },
          (err, out) => (err ? reject(err) : resolve(out)),
        ),
      );
    });
  }

  async startRecording() {
    this.recordPath = `/tmp/jevclaude-${this.id}-${Date.now()}.mp4`;
    this.recorder = startVideo(this.id, this.recordPath);
  }

  async stopRecording(path: string) {
    if (!this.recorder || !this.recordPath) return undefined;
    this.recorder.kill("SIGINT");
    await sleep(1_500);
    const { rename } = await import("node:fs/promises");
    await rename(this.recordPath, path).catch(async () => {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(this.recordPath!, path);
    });
    this.recorder = undefined;
    return path;
  }
}

/** Install WebDriverAgent (prebuilt simulator .app) on a booted simulator and start it. */
export async function setupWda(udid: string, appPath: string): Promise<void> {
  await simctl(["install", udid, appPath], 180_000);
  await simctl(["launch", udid, "com.facebook.WebDriverAgentRunner.xctrunner"]);
  const wda = new WdaClient();
  const deadline = Date.now() + 60_000;
  while (!(await wda.status())) {
    if (Date.now() > deadline) throw new Error("WebDriverAgent did not answer on :8100 within 60 s");
    await sleep(1_000);
  }
}
