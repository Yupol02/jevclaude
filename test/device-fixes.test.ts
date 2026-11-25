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

  it("hides the keyboard before tapping something under it", async () => {
    const dev = new FakeDriver(FORM);
    dev.keyboard = true;
    const r = await new Runner(dev, undefined, { config: offline }).start(
      parseFlow('app: com.example.shop\nsteps:\n  - tap: { text: "Etkinliği Oluştur" }'),
    );
    expect(r.status).toBe("passed");
    expect(dev.keys).toEqual(["hide_keyboard"]);
    expect(dev.taps).toEqual([[540, 2120]]);
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
