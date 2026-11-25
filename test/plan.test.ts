import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DeviceCheckKind,
  type DeviceReading,
  notificationContains,
  parseCallState,
  parseMediaPlaying,
  parseNextAlarm,
  parseOnOff,
  parseTorch,
} from "../src/device/state.js";
import { parseFlow } from "../src/engine/flow.js";
import { Runner } from "../src/engine/runner.js";
import { PlanError, parseCheck, parsePlan, parseStep } from "../src/plan/parse.js";
import { readPlanText } from "../src/plan/run.js";
import { FakeDriver, screen } from "./helpers.js";

describe("plan steps (Turkish and English)", () => {
  it.each([
    ["Uygulamayı aç", ["stop", "launch"]],
    ["Open the app", ["stop", "launch"]],
    ["Uygulamayı kapat", ["stop"]],
    ['"Ayarlar" sekmesine dokun', [{ tap: "Ayarlar" }]],
    ["Ayarlar sekmesine dokun", [{ tap: "Ayarlar sekmesine" }]],
    ['Tap "Log in"', [{ tap: "Log in" }]],
    ['"Yaz ya da konuş" alanına "feneri aç" yaz ve gönder', [{ type: { into: "Yaz ya da konuş", text: "feneri aç", submit: true } }]],
    ['Mesaj alanına "merhaba" yaz', [{ type: { into: "Mesaj alanına", text: "merhaba" } }]],
    ['Type "hello" into "Message" and send', [{ type: { into: "Message", text: "hello", submit: true } }]],
    ['Type "a@b.c" into the email field', [{ type: { into: "email field", text: "a@b.c" } }]],
    ["Geri dön", ["back"]],
    ["Go back", ["back"]],
    ["Klavyeyi kapat", ["hide_keyboard"]],
    ["Aşağı kaydır", [{ swipe: "up" }]],
    ["Scroll down", [{ swipe: "up" }]],
    ["Yukarı kaydır", [{ swipe: "down" }]],
    ["Sola kaydır", [{ swipe: "left" }]],
    ["Swipe up", [{ swipe: "up" }]],
    ["2 saniye bekle", [{ wait: 2000 }]],
    ["Wait 1.5 seconds", [{ wait: 1500 }]],
    ['"Tamam" görünene kadar bekle', [{ wait_for: "Tamam" }]],
    ['Varsa "Daha sonra"ya dokun', [{ if_visible: "Daha sonra", then: [{ tap: "Daha sonra" }] }]],
    ["https://example.com/a adresini aç", [{ open: "https://example.com/a" }]],
    ["Aramayı kapat", [{ key: "KEYCODE_ENDCALL" }]],
    ['"Atla"ya dokun (isteğe bağlı)', [{ tap: "Atla", optional: true }]],
  ])("%s", (line, steps) => {
    expect(parseStep(line)).toEqual(steps);
  });

  it("returns undefined for lines it can't read", () => {
    expect(parseStep("Biraz düşün")).toBeUndefined();
  });
});

describe("plan checks", () => {
  it.each([
    ["fener açık", [{ device: { torch: "on" } }]],
    ["El feneri kapalı", [{ device: { torch: "off" } }]],
    ["the flashlight is on", [{ device: { torch: "on" } }]],
    ["arama başladı", [{ device: { call: "active" } }]],
    ["telefon araması yok", [{ device: { call: "idle" } }]],
    ["a phone call is in progress", [{ device: { call: "active" } }]],
    ["alarm 7:00 için kurulu", [{ device: { alarm: "07:00" } }]],
    ["alarm kurulu", [{ device: { alarm: "set" } }]],
    ["müzik çalıyor", [{ device: { media: "playing" } }]],
    ["Wi-Fi kapalı", [{ device: { wifi: "off" } }]],
    ["Bluetooth açık", [{ device: { bluetooth: "on" } }]],
    ["uçak modu açık", [{ device: { airplane: "on" } }]],
    ['bildirim "Hatırlatma"', [{ device: { notification: "Hatırlatma" } }]],
    ['"com.example.app" ön planda', [{ device: { app: "com.example.app" } }]],
    ['"Kaydedildi" görünüyor', [{ see: "Kaydedildi" }]],
    ['"Kişilik"', [{ see: "Kişilik" }]],
    ['ekranda "Hoş geldin" yazıyor', [{ see: "Hoş geldin" }]],
    ['"Hata" görünmüyor', [{ not_see: "Hata" }]],
    ['"Temalar" is not shown', [{ not_see: "Temalar" }]],
    ["Ayarlar sayfası açık", [{ expect: "Ayarlar sayfası açık" }]],
    ['asistan "fener açıldı" gibi bir yanıt veriyor', [{ expect: 'asistan "fener açıldı" gibi bir yanıt veriyor' }]],
    // "arama" is also "search": a search check is not a call check
    ["arama sonuçlarında Kişilik çıkıyor", [{ expect: "arama sonuçlarında Kişilik çıkıyor" }]],
  ])("Kontrol: %s", (text, steps) => {
    expect(parseCheck(text, false)).toEqual(steps);
  });
});

describe("plan files", () => {
  const PLAN = `# Asistan — cihazda test
uygulama: com.example.assistant

Not: her test uygulamayı yeniden başlatır.

## Fener komutu
1. Uygulamayı aç
2. "Yaz ya da konuş" alanına "feneri aç" yaz ve gönder
3. Kontrol: fener açık

## Annemi ara
izin: arama
- [ ] Uygulamayı aç
- [ ] "Yaz ya da konuş" alanına "annemi ara" yaz ve gönder
- [ ] Kontrol: arama başladı
`;

  it("turns each ## section into a flow; calls are blocked unless the test allows them", () => {
    const plan = parsePlan(PLAN);
    expect(plan.app).toBe("com.example.assistant");
    expect(plan.tests.map((t) => t.title)).toEqual(["Fener komutu", "Annemi ara"]);
    expect(plan.tests[0]!.flow.calls).toBe("block");
    expect(plan.tests[1]!.flow.calls).toBe("allow");
    expect(plan.tests[0]!.flow.permissions).toBe("stop");
    expect(plan.tests[0]!.flow.steps).toEqual([
      "stop",
      "launch",
      { type: { into: "Yaz ya da konuş", text: "feneri aç", submit: true } },
      { device: { torch: "on" } },
    ]);
  });

  it("reports every unreadable line with its number, and a missing app", () => {
    let err: Error | undefined;
    try {
      parsePlan("## A\n1. Uygulamayı aç\n2. Biraz düşün\n3. Hmm\n");
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(PlanError);
    expect(err!.message).toContain('missing "uygulama: <package>"');
    expect(err!.message).toContain('line 3: can\'t read "Biraz düşün"');
    expect(err!.message).toContain('line 4: can\'t read "Hmm"');
  });

  it("reads plain text and PDF plans", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jc-plan-"));
    writeFileSync(join(dir, "p.txt"), PLAN);
    expect(parsePlan(await readPlanText(join(dir, "p.txt"))).tests).toHaveLength(2);
    writeFileSync(join(dir, "p.pdf"), tinyPdf(["app: com.example.app", "## Smoke", "1. Open the app", '2. Check: "Home" is shown']));
    const plan = parsePlan(await readPlanText(join(dir, "p.pdf")));
    expect(plan.app).toBe("com.example.app");
    expect(plan.tests[0]!.flow.steps).toEqual(["stop", "launch", { see: "Home" }]);
  });
});

describe("device state parsers", () => {
  it("reads the flashlight from dumpsys media.camera", () => {
    expect(
      parseTorch("== Camera service ==\n  Torch status for camera 0: AVAILABLE_OFF\n  Torch status for camera 1: AVAILABLE_ON\n"),
    ).toBe("on");
    expect(parseTorch("Torch status for camera 0: AVAILABLE_OFF\n")).toBe("off");
    expect(parseTorch("no torch info here? nothing")).toBeUndefined();
    // Samsung / Android 16: only the events log, newest first
    const log = (first: string) =>
      `== Camera service events log (most recent at top): ==\n  11-25 11:08:03 : Torch for camera id 0 turned ${first} for client PID 5322\n  11-25 11:08:01 : Torch for camera id 0 turned on for client PID 5322\n`;
    expect(parseTorch(log("off"))).toBe("off");
    expect(parseTorch(log("on"))).toBe("on");
    expect(parseTorch("== Camera service events log (most recent at top): ==\n  11-25 : Camera 0 opened\n")).toBe("off");
  });

  it("reads the call state, any SIM", () => {
    expect(parseCallState("  mCallState=0\n  mCallState=2\n")).toBe("active");
    expect(parseCallState("  mCallState=0\n  mCallState=0\n")).toBe("idle");
    expect(parseCallState("")).toBeUndefined();
  });

  it("reads the next alarm clock", () => {
    const t = new Date(2026, 10, 26, 7, 0).getTime();
    expect(parseNextAlarm(`Next alarm clock information:\n    user:0 pendingSend:false time:${t} = 2026-11-26 07:00:00\n`)).toBe("07:00");
    expect(parseNextAlarm("Next alarm clock information:\n")).toBe("none");
  });

  it("reads media, switches and notifications", () => {
    expect(parseMediaPlaying("state=PlaybackState {state=3, position=0}")).toBe("playing");
    expect(parseMediaPlaying("state=PlaybackState {state=2, position=0}")).toBe("stopped");
    expect(parseOnOff("1\n")).toBe("on");
    expect(parseOnOff("2")).toBe("on");
    expect(parseOnOff("0")).toBe("off");
    expect(
      notificationContains("      android.title=String (Hatırlatma)\n      android.text=String (Su iç)", "su İÇ".toLocaleLowerCase("tr")),
    ).toBe(true);
    expect(notificationContains("android.title=String (Başka)", "Hatırlatma")).toBe(false);
  });
});

/** A device whose state the test scripts; calls start when "call" is tapped. */
class StateDriver extends FakeDriver {
  state: Record<string, string> = { torch: "off", call: "idle" };
  ended = 0;
  async readDeviceState(kind: DeviceCheckKind): Promise<DeviceReading | undefined> {
    return kind in this.state ? { value: this.state[kind]! } : undefined;
  }
  async endCall() {
    this.ended += 1;
    this.state.call = "idle";
  }
}

const HOME = screen([
  { text: "Torch", id: "torch", clickable: true, b: [0, 200, 500, 300] },
  { text: "Call mom", id: "call", clickable: true, b: [0, 400, 500, 500] },
]);

function device() {
  const d = new StateDriver(HOME);
  d.onTap = (_x, y, dd) => {
    if (y < 300) (dd as StateDriver).state.torch = "on";
    else (dd as StateDriver).state.call = "active";
  };
  return d;
}

const run = (d: FakeDriver, steps: unknown[], calls?: "allow" | "block") =>
  new Runner(d, undefined, { config: { riskGuard: false, checkErrorsEveryStep: false, deviceTimeoutMs: 300, callTimeoutMs: 300 } }).start(
    parseFlow({ app: "com.example.shop", ...(calls ? { calls } : {}), steps }),
  );

describe("device checks in the runner", () => {
  it("passes once the device reports the state, fails with what it saw otherwise", async () => {
    const d = device();
    const ok = await run(d, [{ tap: { id: "torch" } }, { device: { torch: "on" } }]);
    expect(ok.status).toBe("passed");
    const bad = await run(device(), [{ device: { torch: "on" } }]);
    expect(bad.status).toBe("failed");
    expect(bad.steps[0]!.detail).toBe("expected torch on, device reports off");
  });

  it("calls: block ends a call the app starts and blocks the step", async () => {
    const d = device();
    const r = await run(d, [{ tap: { id: "call" } }, { see: "Torch" }], "block");
    expect(r.status).toBe("blocked");
    expect(r.steps[0]!.detail).toContain("calls aren't allowed");
    expect(d.ended).toBe(1);
    expect(d.state.call).toBe("idle");
  });

  it("calls: allow confirms the call, then ends it", async () => {
    const d = device();
    const r = await run(d, [{ tap: { id: "call" } }, { device: { call: "active" } }], "allow");
    expect(r.status).toBe("passed");
    expect(r.steps[1]!.detail).toBe("call confirmed, then ended");
    expect(d.ended).toBe(1);
  });

  it("a call still going at the end of the flow is ended", async () => {
    const d = device();
    const r = await run(d, [{ tap: { id: "call" } }], "allow");
    expect(d.ended).toBe(1);
    expect(r.notes?.[0]).toContain("was ended");
  });

  it("never ends a call that was already going when the flow started", async () => {
    const d = device();
    d.state.call = "active";
    const r = await run(d, [{ tap: { id: "torch" } }], "block");
    expect(r.status).toBe("passed");
    expect(d.ended).toBe(0);
  });
});

/** A minimal one-page PDF with one line of Helvetica text per entry (ASCII only). */
function tinyPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = `BT /F1 12 Tf 14 TL 50 780 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
