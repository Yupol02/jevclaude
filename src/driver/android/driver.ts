import type { ChildProcess } from "node:child_process";
import type { UiElement, UiSnapshot } from "../../core/uitree.js";
import { findWebContainer, mergeWebPage, urlHint } from "../../core/web.js";
import {
  type DeviceCheckKind,
  type DeviceReading,
  notificationContains,
  parseCallState,
  parseMediaPlaying,
  parseNextAlarm,
  parseOnOff,
  parseTorch,
} from "../../device/state.js";
import { type Driver, sleep } from "../types.js";
import { Adb, findCrashes } from "./adb.js";
import { CdpClient } from "./cdp.js";
import { UIA2_SERVER_PKG, UIA2_TEST_PKG, Uia2Client } from "./uia2.js";
import { parseAndroidXml } from "./xml.js";

/** Browsers whose pages are read through Chrome DevTools (their a11y tree often omits web content). */
const CDP_BROWSERS = ["com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary"];

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
  private log: (m: string) => void = () => {};
  private cdp?: CdpClient;
  /** "off" after DevTools turned out to be unavailable, or when disabled with JEVCLAUDE_WEB=off. */
  private webState: "unknown" | "on" | "off" = process.env.JEVCLAUDE_WEB === "off" ? "off" : "unknown";
  private webFailures = 0;
  /** The last text went into a web input through DevTools, so Enter should go there too. */
  private lastTypedWeb = false;
  private recorder?: ChildProcess;

  private constructor(private readonly adb: Adb) {}

  static async connect(serial: string, backend: AndroidBackend = "auto", log: (m: string) => void = () => {}): Promise<AndroidDriver> {
    const d = new AndroidDriver(new Adb(serial));
    d.log = log;
    if (backend !== "adb") {
      const installed = await Uia2Client.isInstalled(d.adb).catch(() => false);
      if (installed) {
        let c = new Uia2Client(d.adb);
        try {
          try {
            await c.start();
          } catch {
            // A stale instrumentation (e.g. after a USB reconnect) can block a fresh start: stop it, retry once.
            await c.stop().catch(() => {});
            await stopUia2Server(d.adb);
            c = new Uia2Client(d.adb);
            await c.start();
          }
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
    return this.withWeb(await this.nativeSnapshot());
  }

  /**
   * When Chrome is in front, read the visible tab through DevTools and merge its elements (text,
   * links, buttons, inputs, with screen coordinates) into the tree. Falls back to the plain tree.
   */
  private async withWeb(snap: UiSnapshot): Promise<UiSnapshot> {
    if (this.webState === "off") return snap;
    if (!snap.packages.some((p) => CDP_BROWSERS.includes(p)) || !findWebContainer(snap)) return snap;
    try {
      if (!this.cdp) {
        const c = new CdpClient(this.adb);
        try {
          await c.start();
        } catch (e) {
          await c.close();
          throw e;
        }
        this.cdp = c;
        this.webState = "on";
      }
      const page = await this.cdp.readPage(urlHint(snap));
      this.webFailures = 0;
      return mergeWebPage(snap, page);
    } catch (e) {
      this.webFailures += 1;
      if (this.webFailures >= 3) {
        this.webState = "off";
        this.log(`web page reading via Chrome DevTools is off: ${(e as Error).message}`);
      }
      return snap;
    }
  }

  private async nativeSnapshot(): Promise<UiSnapshot> {
    if (this.uia2) {
      try {
        return parseAndroidXml(await this.uia2.source());
      } catch (e) {
        // The server dies when USB drops or the instrumentation is killed. Restart it once; if that
        // fails, use uiautomator dump for the rest of the run instead of timing out on every read.
        try {
          await this.uia2.start();
          return parseAndroidXml(await this.uia2.source());
        } catch {
          this.log(`UiAutomator2 server stopped answering (${(e as Error).message.slice(0, 80)}); switching to uiautomator dump`);
          await this.uia2.stop().catch(() => {});
          this.uia2 = undefined;
          await stopUia2Server(this.adb);
        }
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
    if (this.uia2) {
      try {
        return await this.uia2.tap(x, y);
      } catch {
        /* fall back to adb below */
      }
    }
    await this.adb.tap(x, y);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300) {
    if (this.uia2) {
      try {
        return await this.uia2.swipe(x1, y1, x2, y2, durationMs);
      } catch {
        /* fall back to adb below */
      }
    }
    await this.adb.swipe(x1, y1, x2, y2, durationMs);
  }

  async typeText(text: string, target?: UiElement) {
    // Web inputs (read through DevTools): the tap focused them; insert the text in the page itself.
    this.lastTypedWeb = false;
    if (target?.cls.startsWith("Web.") && this.cdp) {
      try {
        await this.cdp.insertText(text);
        this.lastTypedWeb = true;
        return;
      } catch {
        /* fall through to the native paths */
      }
    }
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
    if (this.lastTypedWeb && key.toLowerCase() === "enter" && this.cdp) {
      this.lastTypedWeb = false;
      try {
        return await this.cdp.pressEnter();
      } catch {
        /* fall back to a device key event */
      }
    }
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

  /** Wake the screen and make sure it isn't locked (a PIN/pattern lock needs the user). */
  private async ensureAwakeAndUnlocked() {
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
  }

  async launch(app: string) {
    await this.ensureAwakeAndUnlocked();
    await this.adb.launch(app);
  }

  async openUrl(url: string, app?: string) {
    await this.ensureAwakeAndUnlocked();
    await this.adb.openUrl(url, app);
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

  async readDeviceState(kind: DeviceCheckKind, want: string): Promise<DeviceReading | undefined> {
    const sh = (cmd: string[]) => this.adb.shell(cmd, 10_000);
    switch (kind) {
      case "torch": {
        const v = parseTorch(await sh(["dumpsys", "media.camera"]));
        return v ? { value: v } : undefined;
      }
      case "call": {
        const v = parseCallState(await sh(["dumpsys", "telephony.registry"]));
        return v ? { value: v } : undefined;
      }
      case "alarm":
        return { value: parseNextAlarm(await sh(["dumpsys", "alarm"])) };
      case "media":
        return { value: parseMediaPlaying(await sh(["dumpsys", "media_session"])) };
      case "wifi":
        return { value: parseOnOff(await sh(["settings", "get", "global", "wifi_on"])) };
      case "bluetooth":
        return { value: parseOnOff(await sh(["settings", "get", "global", "bluetooth_on"])) };
      case "airplane":
        return { value: parseOnOff(await sh(["settings", "get", "global", "airplane_mode_on"])) };
      case "notification": {
        const found = notificationContains(await sh(["dumpsys", "notification", "--noredact"]), want);
        return { value: found ? "shown" : "not shown", found };
      }
      case "app":
        return { value: (await this.foregroundApp()) ?? "unknown" };
    }
  }

  async endCall() {
    await this.adb.key("KEYCODE_ENDCALL");
  }

  async close() {
    await this.cdp?.close();
    await this.uia2?.stop();
  }
}

/** Stop a UiAutomator2 server instrumentation (it blocks `uiautomator dump` while running). */
async function stopUia2Server(adb: Adb): Promise<void> {
  await adb.forceStop(UIA2_TEST_PKG).catch(() => {});
  await adb.forceStop(UIA2_SERVER_PKG).catch(() => {});
}
