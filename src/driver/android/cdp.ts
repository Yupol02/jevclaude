import { PAGE_SCRIPT, type WebPage } from "../../core/web.js";
import type { Adb } from "./adb.js";

/** DevTools target as listed by GET /json. */
export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  description?: string;
  webSocketDebuggerUrl?: string;
}

/** Pick the tab that is on screen: Chrome marks it `visible` in `description`; else match the address bar. */
export function pickTarget(targets: CdpTarget[], hint?: string): CdpTarget | undefined {
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const visible = pages.filter((t) => {
    try {
      return Boolean(t.description && (JSON.parse(t.description) as { visible?: boolean }).visible);
    } catch {
      return false;
    }
  });
  if (visible.length === 1) return visible[0];
  const pool = visible.length > 1 ? visible : pages;
  if (hint) {
    const h = hint
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .toLowerCase();
    const strip = (u: string) =>
      u
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .toLowerCase();
    const exact = pool.find((t) => strip(t.url) === h || strip(t.url).startsWith(h) || h.startsWith(strip(t.url)));
    if (exact) return exact;
    const host = h.split("/")[0]!;
    const sameHost = pool.find((t) => strip(t.url).split("/")[0] === host);
    if (sameHost) return sameHost;
  }
  return pool[0];
}

/**
 * Minimal Chrome DevTools Protocol client for Chrome on Android, over `adb forward` to the
 * `chrome_devtools_remote` socket. Used to read web pages Chrome doesn't expose to UiAutomator.
 */
export class CdpClient {
  private ws?: WebSocket;
  private wsUrl?: string;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly adb: Adb,
    private readonly localPort = 9300 + Math.floor(Math.random() * 500),
    private readonly socket = "chrome_devtools_remote",
  ) {}

  private get base() {
    return `http://127.0.0.1:${this.localPort}`;
  }

  async start(): Promise<void> {
    if (typeof WebSocket === "undefined") throw new Error("reading web pages needs Node 22+ (global WebSocket)");
    await this.adb.run(["forward", `tcp:${this.localPort}`, `localabstract:${this.socket}`]);
    // The first request right after `adb forward` (or while Chrome is still starting) can fail; retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.targets();
        return;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }

  async targets(): Promise<CdpTarget[]> {
    const res = await fetch(`${this.base}/json`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) throw new Error(`DevTools /json → ${res.status}`);
    return (await res.json()) as CdpTarget[];
  }

  private async attach(url: string): Promise<void> {
    if (this.ws && this.wsUrl === url && this.ws.readyState === WebSocket.OPEN) return;
    this.ws?.close();
    this.pending.clear();
    // Chrome returns ws://localhost/devtools/...; point it at our forwarded port.
    const wsUrl = url.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${this.localPort}`);
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("DevTools websocket timeout")), 3_000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("DevTools websocket error"));
      });
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("DevTools websocket closed"));
      this.pending.clear();
    });
    this.ws = ws;
    this.wsUrl = url;
  }

  private send(method: string, params: Record<string, unknown> = {}, timeoutMs = 3_000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("DevTools not attached"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Attach to the visible tab (matching the address bar if needed) and read its visible elements. */
  async readPage(hint?: string): Promise<WebPage> {
    const target = pickTarget(await this.targets(), hint);
    if (!target?.webSocketDebuggerUrl) throw new Error("no debuggable Chrome tab");
    await this.attach(target.webSocketDebuggerUrl);
    const res = (await this.send("Runtime.evaluate", { expression: PAGE_SCRIPT, returnByValue: true })) as {
      result?: { value?: string };
      exceptionDetails?: unknown;
    };
    if (!res.result?.value) throw new Error("page script returned nothing");
    return JSON.parse(res.result.value) as WebPage;
  }

  /** Type into the focused page element (Unicode-safe). */
  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  /** Press Enter in the page (submits the focused form field). */
  async pressEnter(): Promise<void> {
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
    await this.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...key });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }

  async close(): Promise<void> {
    this.ws?.close();
    await this.adb.run(["forward", "--remove", `tcp:${this.localPort}`]).catch(() => {});
  }
}
