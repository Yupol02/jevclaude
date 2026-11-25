import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DeviceInfo {
  serial: string;
  state: string;
  model?: string;
}

/** Thin wrapper around the `adb` binary. Every call is scoped to one device serial. */
export class Adb {
  constructor(
    readonly serial?: string,
    private readonly bin: string = process.env.ADB_PATH ?? "adb",
  ) {}

  private args(extra: string[]): string[] {
    return this.serial ? ["-s", this.serial, ...extra] : extra;
  }

  async run(extra: string[], opts: { timeoutMs?: number; binary?: boolean } = {}): Promise<string> {
    const { stdout } = await execFileAsync(this.bin, this.args(extra), {
      timeout: opts.timeoutMs ?? 20_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  }

  async runBuffer(extra: string[], timeoutMs = 20_000): Promise<Buffer> {
    const { stdout } = await execFileAsync(this.bin, this.args(extra), {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer",
    });
    return stdout;
  }

  shell(cmd: string[], timeoutMs?: number): Promise<string> {
    return this.run(["shell", ...cmd], { timeoutMs });
  }

  static async devices(bin = process.env.ADB_PATH ?? "adb"): Promise<DeviceInfo[]> {
    const { stdout } = await execFileAsync(bin, ["devices", "-l"], { encoding: "utf8" });
    return parseDevices(stdout);
  }

  /** Dump the current UI hierarchy as XML (uiautomator). */
  async dumpUi(): Promise<string> {
    // Writing to a file and cat-ing it is the most portable variant across Android versions.
    const path = "/sdcard/jevclaude_dump.xml";
    try {
      await this.shell(["uiautomator", "dump", "--compressed", path], 30_000);
    } catch (e) {
      // Some devices (seen on Samsung / Android 16) exit non-zero although the dump was written.
      const out = String((e as { stdout?: unknown }).stdout ?? "");
      if (!/dumped to/i.test(out)) throw e;
    }
    const xml = await this.shell(["cat", path]);
    const start = xml.indexOf("<?xml");
    if (start < 0) throw new Error(`uiautomator dump failed: ${xml.slice(0, 200)}`);
    return xml.slice(start);
  }

  tap(x: number, y: number): Promise<string> {
    return this.shell(["input", "tap", String(Math.round(x)), String(Math.round(y))]);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<string> {
    return this.shell(["input", "swipe", ...[x1, y1, x2, y2].map((v) => String(Math.round(v))), String(durationMs)]);
  }

  /** Types text into the focused field. Non-ASCII text is not supported by `input text`. */
  async typeText(text: string): Promise<void> {
    if (/[^\x20-\x7e]/.test(text)) {
      throw new Error("adb `input text` only supports printable ASCII; use an ASCII test value");
    }
    // `input text` uses %s for spaces; shell metacharacters must be escaped for the device shell.
    const escaped = text.replace(/ /g, "%s").replace(/([\\'"`$&|;<>()*?!#~[\]{}])/g, "\\$1");
    await this.shell(["input", "text", escaped]);
  }

  key(keycode: string | number): Promise<string> {
    return this.shell(["input", "keyevent", String(keycode)]);
  }

  back(): Promise<string> {
    return this.key("KEYCODE_BACK");
  }

  /** Start the app's launcher activity (am start -W waits for it); falls back to monkey. */
  async launch(pkg: string): Promise<void> {
    const resolved = await this.shell([
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-c",
      "android.intent.category.LAUNCHER",
      pkg,
    ]).catch(() => "");
    const component = resolved
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${pkg}/`));
    if (component) {
      await this.shell(["am", "start", "-W", "-n", component], 30_000);
    } else {
      await this.shell(["monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
    }
  }

  /** Open a URL / deep link with a VIEW intent, optionally pinned to one package. */
  async openUrl(url: string, pkg?: string): Promise<void> {
    const out = await this.shell(
      ["am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", `'${url.replace(/'/g, "'\\''")}'`, ...(pkg ? ["-p", pkg] : [])],
      30_000,
    );
    if (/Error:|unable to resolve/i.test(out)) throw new Error(`could not open ${url}: ${out.trim().split("\n").pop()}`);
  }

  /** Screen on/off and keyguard state. */
  async screenState(): Promise<{ awake: boolean; locked: boolean }> {
    const power = await this.shell(["dumpsys", "power"]).catch(() => "");
    const awake = /mWakefulness=Awake/.test(power) || !/mWakefulness=/.test(power);
    const win = await this.shell(["dumpsys", "window"]).catch(() => "");
    const locked = /mDreamingLockscreen=true|isKeyguardShowing=true|mShowingLockscreen=true|keyguardShowing=true/i.test(win);
    return { awake, locked };
  }

  async forceStop(pkg: string): Promise<void> {
    await this.shell(["am", "force-stop", pkg]);
  }

  async clearLogcat(): Promise<void> {
    await this.run(["logcat", "-c"]);
  }

  /** Recent error-level logcat lines (crash detection). */
  async logcatErrors(lines = 200): Promise<string> {
    return this.run(["logcat", "-d", "-t", String(lines), "*:E"]);
  }

  screencap(): Promise<Buffer> {
    return this.runBuffer(["exec-out", "screencap", "-p"]);
  }

  install(apkPath: string): Promise<string> {
    return this.run(["install", "-r", "-g", apkPath], { timeoutMs: 120_000 });
  }

  async packages(): Promise<string[]> {
    const out = await this.shell(["pm", "list", "packages"]);
    return out
      .split("\n")
      .map((l) => l.replace(/^package:/, "").trim())
      .filter(Boolean);
  }

  forward(localPort: number, remotePort: number): Promise<string> {
    return this.run(["forward", `tcp:${localPort}`, `tcp:${remotePort}`]);
  }

  /** Long-running device command (instrumentation, screenrecord); caller owns the process. */
  spawn(cmd: string[]): ChildProcess {
    return spawn(this.bin, this.args(["shell", ...cmd]), { stdio: "ignore", detached: false });
  }

  pull(remote: string, local: string): Promise<string> {
    return this.run(["pull", remote, local], { timeoutMs: 60_000 });
  }

  async foregroundPackage(): Promise<string | undefined> {
    const out = await this.shell(["dumpsys", "window"]);
    return parseForegroundPackage(out);
  }
}

export function parseDevices(out: string): DeviceInfo[] {
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial = "", state = "", ...rest] = line.split(/\s+/);
      const model = rest.find((r) => r.startsWith("model:"))?.slice("model:".length);
      return { serial, state, model };
    });
}

export function parseForegroundPackage(dumpsysWindow: string): string | undefined {
  const m =
    dumpsysWindow.match(/mCurrentFocus=Window\{[^}]*\s([\w.]+)\/[\w.$]+\}/) ?? dumpsysWindow.match(/mFocusedApp=.*?\s([\w.]+)\/[\w.$]+/);
  return m?.[1];
}

const CRASH_PATTERNS = [/FATAL EXCEPTION/, /ANR in /, /has died/, /Process: .* PID: \d+/];

/** Returns crash lines that belong to the given package (or any crash if no package given). */
export function findCrashes(logcat: string, pkg?: string): string[] {
  const lines = logcat.split("\n");
  const hits: string[] = [];
  lines.forEach((line, i) => {
    if (!CRASH_PATTERNS.some((p) => p.test(line))) return;
    const window = lines.slice(i, i + 4).join("\n");
    if (!pkg || window.includes(pkg)) hits.push(window.trim());
  });
  return hits;
}
