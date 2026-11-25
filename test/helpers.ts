import { readFileSync } from "node:fs";
import type { UiSnapshot } from "../src/core/uitree.js";
import { parseAndroidXml } from "../src/driver/android/xml.js";
import type { Driver } from "../src/driver/types.js";
import type { JevAnswer, JevClient, JevRequest, JevResponse } from "../src/jev/client.js";

export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export interface N {
  text?: string;
  desc?: string;
  id?: string;
  cls?: string;
  clickable?: boolean;
  scrollable?: boolean;
  /** [left, top, right, bottom] */
  b: [number, number, number, number];
  pkg?: string;
}

/** Build a uiautomator-dump XML screen from a flat list of nodes. */
export function screen(nodes: N[], pkg = "com.example.shop"): string {
  const attrs = (n: N) =>
    `text="${n.text ?? ""}" resource-id="${n.id ? `${n.pkg ?? pkg}:id/${n.id}` : ""}" class="android.widget.${n.cls ?? (n.clickable ? "Button" : "TextView")}" package="${n.pkg ?? pkg}" content-desc="${n.desc ?? ""}" clickable="${n.clickable ?? false}" scrollable="${n.scrollable ?? false}" enabled="true" bounds="[${n.b[0]},${n.b[1]}][${n.b[2]},${n.b[3]}]"`;
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node class="android.widget.FrameLayout" package="${pkg}" bounds="[0,0][1080,2400]">${nodes
    .map((n) => `<node ${attrs(n)} />`)
    .join("")}</node></hierarchy>`;
}

/** Scriptable fake device: `screens[name]` XML, `onTap` decides navigation. */
export class FakeDriver implements Driver {
  readonly platform = "android" as const;
  readonly id = "fake";
  readonly name = "fake";
  unicodeInput = true;
  fastSnapshot = false;
  current: string;
  taps: Array<[number, number]> = [];
  typed: string[] = [];
  keys: string[] = [];
  swipes = 0;
  crashes: string[] = [];
  launched: string[] = [];
  onTap: (x: number, y: number, d: FakeDriver) => void = () => {};
  onSwipe: (d: FakeDriver) => void = () => {};

  constructor(xml: string) {
    this.current = xml;
  }
  async snapshot(): Promise<UiSnapshot> {
    return parseAndroidXml(this.current);
  }
  async tap(x: number, y: number) {
    this.taps.push([x, y]);
    this.onTap(x, y, this);
  }
  async swipe() {
    this.swipes += 1;
    this.onSwipe(this);
  }
  async typeText(t: string) {
    this.typed.push(t);
  }
  async pressKey(k: string) {
    this.keys.push(k);
  }
  async back() {
    this.keys.push("back");
  }
  async hideKeyboard() {}
  async launch(app: string) {
    this.launched.push(app);
  }
  async stop() {}
  async foregroundApp() {
    return undefined;
  }
  async markLogs() {}
  async crashLogs() {
    return this.crashes;
  }
  async screenshot() {
    return Buffer.from("png");
  }
}

type Answerer = (question: string, req: JevRequest) => JevAnswer;

/** Fake Jev: answers each question with a function; records every request. */
export class FakeJev implements JevClient {
  name = "fake";
  requests: JevRequest[] = [];
  constructor(private readonly answer: Answerer) {}
  async ask(req: JevRequest): Promise<JevResponse> {
    this.requests.push(req);
    const answers = Object.fromEntries(Object.keys(req.questions).map((k) => [k, this.answer(k, req)]));
    return { model: "jev-test", answers, usage: { input_tokens: 100, output_tokens: 1 } };
  }
  asked(question: string): number {
    return this.requests.filter((r) => question in r.questions).length;
  }
}

export const yes = (p: number): JevAnswer => ({ type: "noul", noul: p });
export const pick = (choice: string, confidence = 0.93): JevAnswer => ({
  type: "choice",
  choice,
  confidence,
  probabilities: { [choice]: confidence },
});

/** Jev that picks `pickKey`, says actions are safe, no errors, and expectations hold with `expectP`. */
export function safeJev(pickKey = "e3", expectP = 0.95) {
  return new FakeJev((q) => {
    if (q === "risk") return yes(0.02);
    if (q === "error") return yes(0.01);
    if (q === "expect") return yes(expectP);
    return pick(pickKey);
  });
}

export const FAST = {
  settleMs: 0,
  settleMaxMs: 0,
  loadingTimeoutMs: 0,
  assertTimeoutMs: 0,
  waitForTimeoutMs: 0,
};
