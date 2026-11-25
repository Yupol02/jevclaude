import type { ChildProcess } from "node:child_process";
import type { UiElement, UiSnapshot } from "../../core/uitree.js";
import { type Driver, sleep } from "../types.js";
import { Adb, findCrashes } from "./adb.js";
import { UIA2_SERVER_PKG, UIA2_TEST_PKG, Uia2Client } from "./uia2.js";
import { parseAndroidXml } from "./xml.js";

const KEYS: Record<string, string> = {
  enter: "KEYCODE_ENTER",
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  tab: "KEYCODE_TAB",
  delete: "KEYCODE_DEL",
  search: "KEYCODE_SEARCH",
  escape: "KEYCODE_ESCAPE",
};

export type AndroidBackend = "auto" | "uia2" | "adb";

/**
 * Android driver. Input goes through `adb shell input`; the screen is read through the
 * UiAutomator2 server when available (fast, Unicode typing) and `uiautomator dump` otherwise.
 */
export class AndroidDriver implements Driver {
  readonly platform = "android" as const;
  private uia2?: Uia2Client;
  private recorder?: ChildProcess;

  private constructor(private readonly adb: Adb) {}

  static async connect(serial: string, backend: AndroidBackend = "auto", log: (m: string) => void = () => {}): Promise<AndroidDriver> {
    const d = new AndroidDriver(new Adb(serial));
    if (backend !== "adb") {
      const installed = await Uia2Client.isInstalled(d.adb).catch(() => false);
      if (installed) {
        const c = new Uia2Client(d.adb);
        try {
          await c.start();
          d.uia2 = c;
        } catch (e) {
          if (backend === "uia2") throw e;
          log(`UiAutomator2 server unavailable (${(e as Error).message}); falling back to uiautomator dump`);
        }
      } else if (backend === "uia2") {
        throw new Error("UiAutomator2 server is not installed; run `jevclaude setup android`");
      }
    }
    // On the adb path, make sure no UiAutomator2 server from an earlier run holds the UI automation connection.
    if (!d.uia2) await stopUia2Server(d.adb);
    return d;
  }

  get id() {
    return this.adb.serial ?? "default";
  }
  get name() {
    return `android/${this.uia2 ? "uia2" : "adb"} ${this.id}`;
  }
  get unicodeInput() {
    return Boolean(this.uia2);
  }
  get fastSnapshot() {
    return Boolean(this.uia2);
  }

  async snapshot(): Promise<UiSnapshot> {
    if (this.uia2) {
      try {
        return parseAndroidXml(await this.uia2.source());
      } catch {
        /* server may have died (e.g. app restart); fall back for this read */
      }
    }
    try {
      return parseAndroidXml(await this.adb.dumpUi());
    } catch (e) {
      // A UiAutomator2 server left running by an earlier session blocks `uiautomator dump`.
      if (this.uia2) throw e;
      await stopUia2Server(this.adb);
      return parseAndroidXml(await this.adb.dumpUi());
    }
  }

  async tap(x: number, y: number) {
    await this.adb.tap(x, y);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300) {
    await this.adb.swipe(x1, y1, x2, y2, durationMs);
  }

  async typeText(text: string, target?: UiElement) {
    const ascii = !/[^\x20-\x7e]/.test(text);
    if (this.uia2) {
      const errors: string[] = [];
      // 1. Set the tapped field's text directly (Compose fields often report no focus).
      if (target) {
        try {
          return await this.uia2.setTextAt(target.bounds, text);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      // 2. Type into whatever has focus.
      try {
        return await this.uia2.keys(text);
      } catch (e) {
        errors.push((e as Error).message);
      }
      // 3. Plain adb input as a last resort (ASCII only).
      if (ascii) return this.adb.typeText(text);
      throw new Error(`could not type into the field: ${errors.map((m) => m.slice(0, 120)).join(" | ")}`);
    }
    if (!ascii) throw new Error("Non-ASCII text needs the UiAutomator2 backend: run `jevclaude setup android`");
    await this.adb.typeText(text);
  }

  async pressKey(key: string) {
    const k = KEYS[key.toLowerCase()] ?? (/^\d+$/.test(key) ? key : `KEYCODE_${key.toUpperCase().replace(/^KEYCODE_/, "")}`);
    await this.adb.key(k);
  }

  async back() {
    await this.adb.back();
  }

  async keyboardShown() {
    const out = await this.adb.shell(["dumpsys", "input_method"]).catch(() => "");
    return /mInputShown=true|isInputViewShown=true/.test(out);
  }

  async hideKeyboard() {
    if (await this.keyboardShown()) await this.adb.back();
  }

  async launch(app: string) {
    let state = await this.adb.screenState();
    if (!state.awake) {
      await this.adb.key("KEYCODE_WAKEUP");
      await sleep(500);
      state = await this.adb.screenState();
    }
    if (state.locked) {
      // Swipe-only lock screens open with MENU; a PIN/pattern lock needs the user.
      await this.adb.key("KEYCODE_MENU");
      await sleep(500);
      if ((await this.adb.screenState()).locked) {
        throw new Error("the phone is locked — unlock it (or set Screen lock to None/Swipe on the test phone) and retry");
      }
    }
    await this.adb.launch(app);
  }

  async stop(app: string) {
    await this.adb.forceStop(app);
  }

  foregroundApp() {
    return this.adb.foregroundPackage().catch(() => undefined);
  }

  async markLogs() {
    await this.adb.clearLogcat().catch(() => {});
  }

  async crashLogs(app: string) {
    return findCrashes(await this.adb.logcatErrors(400).catch(() => ""), app);
  }

  screenshot() {
    return this.adb.screencap();
  }

  async startRecording() {
    this.recorder = this.adb.spawn(["screenrecord", "--bit-rate", "4000000", "/sdcard/jevclaude.mp4"]);
  }

  async stopRecording(path: string) {
    if (!this.recorder) return undefined;
    await this.adb.shell(["pkill", "-INT", "screenrecord"]).catch(() => {});
    await sleep(1_500); // let screenrecord finalise the mp4
    this.recorder = undefined;
    await this.adb.pull("/sdcard/jevclaude.mp4", path);
    return path;
  }

  async close() {
    await this.uia2?.stop();
  }
}

/** Stop a UiAutomator2 server instrumentation (it blocks `uiautomator dump` while running). */
async function stopUia2Server(adb: Adb): Promise<void> {
  await adb.forceStop(UIA2_TEST_PKG).catch(() => {});
  await adb.forceStop(UIA2_SERVER_PKG).catch(() => {});
}
