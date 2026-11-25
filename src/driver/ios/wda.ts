/**
 * Minimal WebDriverAgent (appium/WebDriverAgent, BSD-3) HTTP client.
 * Routes per WebDriverAgentLib/Commands/*.m.
 */
export class WdaClient {
  private session?: string;

  constructor(readonly baseUrl = process.env.WDA_URL ?? "http://127.0.0.1:8100") {}

  private async raw(method: string, path: string, body?: unknown, timeoutMs = 20_000) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { value?: unknown; sessionId?: string };
    return { ok: res.ok, status: res.status, json };
  }

  /** Session-scoped route, falling back to the session-less form some WDA routes also accept. */
  async call(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.session) await this.ensureSession();
    let r = await this.raw(method, `/session/${this.session}${path}`, body, timeoutMs);
    if (r.status === 404) {
      const plain = await this.raw(method, path, body, timeoutMs);
      if (plain.ok) r = plain;
    }
    if (!r.ok) {
      // Session may have expired (e.g. WDA restarted): renew once.
      if (/invalid session|session.*(not|does not) exist/i.test(JSON.stringify(r.json))) {
        this.session = undefined;
        await this.ensureSession();
        r = await this.raw(method, `/session/${this.session}${path}`, body, timeoutMs);
      }
      if (!r.ok) throw new Error(`WDA ${method} ${path} → ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
    }
    return r.json.value;
  }

  async status(): Promise<Record<string, unknown> | undefined> {
    try {
      const r = await this.raw("GET", "/status", undefined, 2_000);
      return r.ok ? ((r.json.value as Record<string, unknown>) ?? {}) : undefined;
    } catch {
      return undefined;
    }
  }

  async ensureSession(): Promise<void> {
    const r = await this.raw("POST", "/session", { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
    const v = r.json.value as { sessionId?: string } | undefined;
    this.session = v?.sessionId ?? r.json.sessionId;
    if (!r.ok || !this.session) throw new Error(`WDA session failed (${r.status}): ${JSON.stringify(r.json).slice(0, 200)}`);
  }

  async source(): Promise<string> {
    const v = await this.call("GET", "/source?format=xml");
    if (typeof v !== "string") throw new Error("WDA source was not XML");
    return v;
  }

  tap(x: number, y: number) {
    return this.call("POST", "/wda/tap", { x, y });
  }

  drag(fromX: number, fromY: number, toX: number, toY: number, seconds: number) {
    return this.call("POST", "/wda/dragfromtoforduration", { fromX, fromY, toX, toY, duration: seconds });
  }

  keys(text: string) {
    return this.call("POST", "/wda/keys", { value: [...text] });
  }

  openUrl(url: string) {
    return this.call("POST", "/url", { url });
  }

  launch(bundleId: string) {
    return this.call("POST", "/wda/apps/launch", { bundleId });
  }

  terminate(bundleId: string) {
    return this.call("POST", "/wda/apps/terminate", { bundleId });
  }

  async activeApp(): Promise<string | undefined> {
    const v = (await this.call("GET", "/wda/activeAppInfo").catch(() => undefined)) as { bundleId?: string } | undefined;
    return v?.bundleId;
  }

  home() {
    return this.call("POST", "/wda/homescreen");
  }

  dismissKeyboard() {
    return this.call("POST", "/wda/keyboard/dismiss", {});
  }

  async screenshot(): Promise<Buffer> {
    const v = await this.call("GET", "/screenshot");
    return Buffer.from(String(v), "base64");
  }
}
