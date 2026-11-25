import { describe, expect, it } from "vitest";
import { webContentHidden } from "../src/core/uitree.js";
import { parseAndroidXml } from "../src/driver/android/xml.js";
import { parseFlow } from "../src/engine/flow.js";
import { Runner } from "../src/engine/runner.js";
import { actionRiskQuestion, redactPII, screenState } from "../src/jev/questions.js";
import { FAST, FakeDriver, screen } from "./helpers.js";

describe("PII redaction before the screen goes to Jev", () => {
  it("masks e-mails, phone numbers, card numbers and IBANs", () => {
    expect(redactPII("Jane Doe jane.doe+qa@example.co.uk Account")).toBe("Jane Doe <email> Account");
    expect(redactPII("Call +90 532 123 45 67 now")).toBe("Call <phone> now");
    expect(redactPII("Tel: 0532 123 45 67")).toBe("Tel: <phone>");
    expect(redactPII("Card 4111 1111 1111 1111 exp")).toBe("Card <card-number> exp");
    expect(redactPII("IBAN TR33 0006 1005 1978 6457 8413 26")).toBe("IBAN <iban>");
  });

  it("leaves ordinary numbers, times, dates and amounts alone", () => {
    for (const s of [
      "84",
      "12 Çarpı 7",
      "25/25",
      "07:55",
      "30 Kasım 2026",
      "1.234,56 TL",
      "Sayfa 1 / 3",
      "6.64Saniye",
      "v0.2.4",
      "En az 50 milyon kez indirildi",
    ]) {
      expect(redactPII(s)).toBe(s);
    }
  });

  it("is applied to the state sent to Jev", () => {
    const snap = parseAndroidXml(screen([{ text: "Signed in as someone@example.com", b: [0, 0, 1080, 100] }]));
    expect(String(screenState(snap).SCREEN)).toContain("<email>");
    expect(String(screenState(snap).SCREEN)).not.toContain("someone@example.com");
  });
});

describe("parsing and hints", () => {
  it("decodes numeric character references in attributes", () => {
    const xml = screen([{ desc: "Wikipedia&#10;Wikimedia Foundation", clickable: true, b: [0, 0, 1080, 200] }]);
    expect(parseAndroidXml(xml).elements[0]!.desc).toBe("Wikipedia Wikimedia Foundation");
  });

  it("explains failures on web views whose content isn't exposed", async () => {
    const web = screen([
      { cls: "FrameLayout", desc: "Web View", b: [0, 200, 1080, 2200] },
      { cls: "EditText", text: "en.wikipedia.org/wiki/Istanbul", clickable: true, b: [100, 50, 900, 150] },
    ]);
    expect(webContentHidden(parseAndroidXml(web))).toBe(true);
    const r = await new Runner(new FakeDriver(web), undefined, { config: { ...FAST, riskGuard: false } }).start(
      parseFlow('app: com.android.chrome\nsteps:\n  - see: "Bosphorus"'),
    );
    expect(r.steps[0]!.detail).toMatch(/web view whose content isn't exposed/);
  });

  it("counts installing or uninstalling apps as risky", () => {
    const q = actionRiskQuestion('tap the "Install" button');
    expect(String(q.instructions)).toMatch(/install, update or uninstall an app/);
  });
});
