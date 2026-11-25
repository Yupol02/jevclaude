import { describe, expect, it } from "vitest";
import { describeElement, labelOf } from "../src/core/uitree.js";
import { parseAndroidXml } from "../src/driver/android/xml.js";
import { parseFlow } from "../src/engine/flow.js";
import { Runner } from "../src/engine/runner.js";
import { FAST, FakeDriver, FakeJev, fixture, pick, screen, yes } from "./helpers.js";

/** Shape of a real Compose form: the tap target over the date field has no label; its error text sits right below. */
const FORM = screen([
  { text: "Yeni Etkinlik", b: [460, 105, 734, 164] },
  { cls: "EditText", clickable: true, desc: "Etkinlik Başlığı", b: [45, 430, 1035, 611] },
  { cls: "View", clickable: true, b: [45, 656, 1035, 797] },
  { cls: "EditText", text: "Tarih boş olamaz", b: [45, 797, 1035, 904] },
  { cls: "View", clickable: true, b: [676, 949, 1035, 1090] },
  { cls: "EditText", text: "Saat boş olamaz", b: [676, 1090, 1035, 1242] },
  { cls: "View", clickable: true, text: "Etkinliği Oluştur", b: [45, 2050, 1035, 2190] },
]);

describe("unlabeled tap targets", () => {
  it("borrow the label of the element they touch", () => {
    const snap = parseAndroidXml(FORM);
    const date = snap.elements[2]!;
    const time = snap.elements[4]!;
    expect(date.near).toBe("Tarih boş olamaz");
    expect(time.near).toBe("Saat boş olamaz");
    expect(describeElement(date)).toBe('[2] View near="Tarih boş olamaz" {clickable}');
    expect(labelOf(time)).toBe("near Saat boş olamaz");
    // labelled elements never get a hint
    expect(snap.elements[1]!.near).toBeUndefined();
  });

  it("are offered to Jev with the hint, so 'the date field' can be picked", async () => {
    const dev = new FakeDriver(FORM);
    const jev = new FakeJev((q, req) => {
      if (q === "pick") {
        const options = (req.questions.pick as { criteria: Record<string, string> }).criteria;
        const key = Object.keys(options).find((k) => options[k]!.includes("Tarih"));
        return pick(key ?? "none");
      }
      return yes(0.01);
    });
    const r = await new Runner(dev, jev, { config: FAST }).start(parseFlow("app: com.example.shop\nsteps:\n  - tap: the date field"));
    expect(r.status).toBe("passed");
    expect(dev.taps).toEqual([[540, 726.5]]);
  });
});

describe("typing and the keyboard", () => {
  const offline = { ...FAST, riskGuard: false, checkErrorsEveryStep: false };

  it("passes the tapped field to the driver so it can set text directly", async () => {
    const dev = new FakeDriver(fixture("login.xml"));
    await new Runner(dev, undefined, { config: offline }).start(
      parseFlow('app: com.example.shop\nsteps:\n  - type: { into: { id: email }, text: "ş@x.test" }'),
    );
    expect(dev.typed).toEqual(["ş@x.test"]);
    expect(dev.typedInto).toEqual(["com.example.shop:id/email"]);
  });

  it("hides the keyboard before tapping something under it, after a text field was used", async () => {
    const dev = new FakeDriver(FORM);
    dev.keyboard = true;
    const r = await new Runner(dev, undefined, { config: offline }).start(
      parseFlow('app: com.example.shop\nsteps:\n  - tap: { desc: "Etkinlik Başlığı" }\n  - tap: { text: "Etkinliği Oluştur" }'),
    );
    expect(r.status).toBe("passed");
    expect(dev.keys).toEqual(["hide_keyboard"]);
    expect(dev.taps.at(-1)).toEqual([540, 2120]);
  });

  it("doesn't probe the keyboard when no text field was used (saves a dumpsys per tap)", async () => {
    const dev = new FakeDriver(FORM);
    dev.keyboard = true;
    let probes = 0;
    const orig = dev.keyboardShown.bind(dev);
    dev.keyboardShown = async () => {
      probes += 1;
      return orig();
    };
    await new Runner(dev, undefined, { config: offline }).start(
      parseFlow('app: com.example.shop\nsteps:\n  - tap: { text: "Etkinliği Oluştur" }'),
    );
    expect(probes).toBe(0);
  });

  it("does not touch the keyboard for targets in the upper half", async () => {
    const dev = new FakeDriver(FORM);
    dev.keyboard = true;
    await new Runner(dev, undefined, { config: offline }).start(
      parseFlow('app: com.example.shop\nsteps:\n  - tap: { desc: "Etkinlik Başlığı" }'),
    );
    expect(dev.keys).toEqual([]);
  });
});

describe("selected tabs", () => {
  const TABS = screen([
    { text: "Başlat", clickable: true, b: [400, 1800, 680, 1900] },
    { cls: "LinearLayout", text: "Alarm", clickable: true, b: [0, 2100, 270, 2200] },
    { cls: "LinearLayout", text: "Kronometre", b: [540, 2100, 810, 2200] },
  ]).replace('text="Kronometre"', 'text="Kronometre" selected="true"');

  it("offers an already-selected tab to Jev and taps it (a no-op) instead of failing", async () => {
    const dev = new FakeDriver(TABS);
    const jev = new FakeJev((q, req) => {
      if (q !== "pick") return yes(0.01);
      const options = (req.questions.pick as { criteria: Record<string, string> }).criteria;
      return pick(Object.keys(options).find((k) => options[k]!.includes("Kronometre")) ?? "none");
    });
    const r = await new Runner(dev, jev, { config: FAST }).start(parseFlow("app: com.example.shop\nsteps:\n  - tap: the Stopwatch tab"));
    expect(r.status).toBe("passed");
    expect(dev.taps).toEqual([[675, 2150]]);
  });
});

describe("settling on screens with running timers", () => {
  it("treats a screen whose only change is a ticking number as settled", async () => {
    const at = (secs: string) =>
      screen([
        { text: `${secs}Saniye`, b: [300, 500, 780, 700] },
        { text: "Dur", clickable: true, b: [400, 1800, 680, 1900] },
      ]);
    const a = parseAndroidXml(at("6.64"));
    const b = parseAndroidXml(at("6.91"));
    expect(a.hash).not.toBe(b.hash);
    expect(a.settleHash).toBe(b.settleHash);

    let tick = 0;
    const dev = new FakeDriver(at("1.00"));
    dev.snapshot = async () => parseAndroidXml(at(`${(tick++ / 10).toFixed(2)}`));
    dev.fastSnapshot = true;
    const t0 = performance.now();
    const r = await new Runner(dev, undefined, {
      config: { ...FAST, settleMs: 0, settleMaxMs: 4_000, riskGuard: false, checkErrorsEveryStep: false },
    }).start(parseFlow('app: com.example.shop\nsteps:\n  - tap: { text: "Dur" }'));
    expect(r.status).toBe("passed");
    expect(performance.now() - t0).toBeLessThan(1_500); // not the 4 s settle cap
  });
});

describe("quick settle", () => {
  const keypad = (formula: string) =>
    screen([
      { cls: "EditText", text: formula, id: "formula", b: [0, 200, 1080, 400] },
      { text: "1", clickable: true, id: "k1", b: [0, 1500, 270, 1700] },
      { text: "Next", clickable: true, id: "next", b: [810, 1500, 1080, 1700] },
    ]);

  it("accepts the first read when only digits changed (no confirmation read)", async () => {
    let formula = "";
    const dev = new FakeDriver(keypad(""));
    dev.fastSnapshot = true;
    let reads = 0;
    dev.snapshot = async () => {
      reads += 1;
      return parseAndroidXml(keypad(formula));
    };
    dev.onTap = () => {
      formula += "1";
    };
    const r = await new Runner(dev, undefined, { config: { ...FAST, riskGuard: false, checkErrorsEveryStep: false } }).start(
      parseFlow("app: com.example.shop\nsteps:\n  - tap: { id: k1 }\n  - tap: { id: k1 }\n  - tap: { id: k1 }"),
    );
    expect(r.status).toBe("passed");
    // 1 initial read + 1 read per tap (no second confirmation read)
    expect(reads).toBe(4);
  });

  it("re-reads once before giving up when the target is missing after a quick settle", async () => {
    const page2 = screen([{ text: "Done", clickable: true, id: "done", b: [0, 1500, 1080, 1700] }]);
    let tapped = false;
    let readsAfterTap = 0;
    const dev = new FakeDriver(keypad(""));
    dev.fastSnapshot = true;
    // The app navigates only after a delay: the first read after the tap still shows the old screen.
    dev.snapshot = async () => {
      if (!tapped) return parseAndroidXml(keypad(""));
      readsAfterTap += 1;
      return parseAndroidXml(readsAfterTap === 1 ? keypad("") : page2);
    };
    dev.onTap = () => {
      tapped = true;
    };
    const r = await new Runner(dev, undefined, { config: { ...FAST, riskGuard: false, checkErrorsEveryStep: false } }).start(
      parseFlow("app: com.example.shop\nsteps:\n  - tap: { id: next }\n  - tap: { id: done }"),
    );
    expect(r.steps.map((s) => `${s.status}:${s.detail ?? ""}`)).toEqual(["passed:", "passed:"]);
    expect(dev.taps.at(-1)).toEqual([540, 1600]);
  });
});

describe("settling on sliding layouts", () => {
  it("waits for element positions to stop moving after launch (keypad slides in and pauses)", async () => {
    // C slides 871 → 513 (pause, two identical reads) → 76; % ends up where C paused.
    const frames = [871, 513, 513, 76, 76, 76, 76];
    let i = 0;
    const at = (cx: number) =>
      screen([
        { text: "C", clickable: true, id: "clear", b: [cx, 1063, cx + 190, 1255] },
        { text: "%", clickable: true, id: "pct", b: [566, 1063, 758, 1255] },
      ]);
    const dev = new FakeDriver(at(871));
    dev.fastSnapshot = true;
    dev.snapshot = async () => parseAndroidXml(at(frames[Math.min(i++, frames.length - 1)]!));
    const r = await new Runner(dev, undefined, {
      config: { ...FAST, settleMaxMs: 4_000, riskGuard: false, checkErrorsEveryStep: false },
    }).start(parseFlow("app: com.example.shop\nsteps:\n  - launch\n  - tap: { id: clear }"));
    expect(r.status).toBe("passed");
    expect(dev.taps).toEqual([[171, 1159]]); // the final position, not the paused one (608)
  });
});
