import type { ChildProcess } from "node:child_process";
import { sleep } from "../types.js";
import type { Adb } from "./adb.js";

export const UIA2_SERVER_PKG = "io.appium.uiautomator2.server";
export const UIA2_TEST_PKG = "io.appium.uiautomator2.server.test";
/** Port the UiAutomator2 server listens on inside the device. */
export const UIA2_DEVICE_PORT = 6790;

/**
 * Minimal client for the Appium UiAutomator2 server (Apache-2.0), used for fast page source
 * (~0.2 s instead of 1–2 s for `uiautomator dump`) and Unicode text input.
 */
export class Uia2Client {
  private session?: string;
  private proc?: ChildProcess;

  constructor(
    private readonly adb: Adb,
    private readonly localPort = 8200 + Math.floor(Math.random() * 500),
  ) {}

  private get base() {
    return `http://127.0.0.1:${this.localPort}`;
  }

  static async isInstalled(adb: Adb): Promise<boolean> {
    const pkgs = await adb.packages();
    return pkgs.includes(UIA2_SERVER_PKG) && pkgs.includes(UIA2_TEST_PKG);
  }

  private async req(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { value?: unknown };
    if (!res.ok) throw new Error(`UiAutomator2 ${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json.value ?? json;
  }

  async alive(): Promise<boolean> {
    try {
      await this.req("GET", "/status", undefined, 1_500);
      return true;
    } catch {
      return false;
    }
  }

  /** Forward the port, start the instrumentation if needed, and open a session. */
  async start(): Promise<void> {
    await this.adb.forward(this.localPort, UIA2_DEVICE_PORT);
    if (!(await this.alive())) {
      this.proc = this.adb.spawn([
        "am",
        "instrument",
        "-w",
        "-e",
        "disableAnalytics",
        "true",
        `${UIA2_TEST_PKG}/androidx.test.runner.AndroidJUnitRunner`,
      ]);
      const deadline = Date.now() + 20_000;
      while (!(await this.alive())) {
        if (Date.now() > deadline) throw new Error("UiAutomator2 server did not start within 20 s");
        await sleep(400);
      }
    }
    const v = (await this.req("POST", "/session", { capabilities: { firstMatch: [{}], alwaysMatch: {} } })) as {
      sessionId?: string;
    };
    this.session = v.sessionId ?? (v as Record<string, string>).sessionId;
    if (!this.session) throw new Error("UiAutomator2 server returned no session id");
  }

  async source(): Promise<string> {
    const v = await this.req("GET", `/session/${this.session}/source`);
    if (typeof v !== "string") throw new Error("UiAutomator2 source was not a string");
    return v;
  }

  /** Types Unicode text into the focused element. */
  async keys(text: string): Promise<void> {
    await this.req("POST", `/session/${this.session}/keys`, { text, replace: false });
  }

  /** Set the text of the element at exactly these bounds (works for Compose fields that report no focus). */
  async setTextAt(bounds: { left: number; top: number; right: number; bottom: number }, text: string): Promise<void> {
    const b = `[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]`;
    const find = async (selector: string) =>
      (await this.req("POST", `/session/${this.session}/element`, { strategy: "xpath", selector })) as Record<string, string>;
    let el: Record<string, string>;
    try {
      el = await find(`//*[@bounds='${b}' and contains(@class,'EditText')]`);
    } catch {
      el = await find(`//*[@bounds='${b}']`);
    }
    const id = el.ELEMENT ?? el["element-6066-11e4-a52e-4f735466cecf"];
    if (!id) throw new Error("UiAutomator2 returned no element id");
    await this.req("POST", `/session/${this.session}/element/${id}/value`, { text, replace: false });
  }

  async stop(): Promise<void> {
    if (this.session) await this.req("DELETE", `/session/${this.session}`).catch(() => {});
    this.proc?.kill();
  }
}
