/**
 * Test plans: a Markdown / text file Claude Code writes in plain Turkish or English
 * ("CihazdaTestEdilecek.md"), turned into flows by rules — no model call.
 *
 *   uygulama: com.example.app
 *   izin: arama                      (optional, plan-wide: calls, permissions)
 *
 *   ## Fener komutu
 *   1. Uygulamayı aç
 *   2. "Yaz ya da konuş" alanına "feneri aç" yaz ve gönder
 *   3. Kontrol: fener açık
 *   4. Kontrol: asistan feneri açtığını söylüyor
 *
 * Each `##` section is one test. List items are steps; other prose is ignored as notes. A step
 * that matches no rule is an error (with its line number), so the plan is fixed rather than guessed.
 */
import type { DeviceCheck } from "../device/state.js";
import type { Flow, Step } from "../engine/flow.js";
import { FlowSchema } from "../engine/flow.js";

export interface PlanTest {
  title: string;
  /** 1-based line of the heading. */
  line: number;
  flow: Flow;
}

export interface Plan {
  app: string;
  platform?: "android" | "ios";
  device?: string;
  tests: PlanTest[];
}

/** Lower-case and fold Turkish letters so rules can be written in ASCII (length is preserved). */
export function fold(s: string): string {
  const map: Record<string, string> = {
    İ: "i",
    I: "i",
    ı: "i",
    Ş: "s",
    ş: "s",
    Ğ: "g",
    ğ: "g",
    Ü: "u",
    ü: "u",
    Ö: "o",
    ö: "o",
    Ç: "c",
    ç: "c",
  };
  return s.replace(/[İIıŞşĞğÜüÖöÇç]/g, (c) => map[c]!).toLowerCase();
}

const QUOTE = /["“”«»]([^"“”«»]+)["“”«»]/g;
const quotes = (s: string) => [...s.matchAll(QUOTE)].map((m) => m[1]!.trim()).filter(Boolean);
const withoutQuotes = (s: string) => s.replace(QUOTE, " ").replace(/\s+/g, " ").trim();

const has = (folded: string, re: RegExp) => re.test(folded);

// ---------- checks ----------

const ON = /\b(acik|acildi|aktif|yaniyor|calisiyor|on|enabled|turned on)\b/;
const OFF = /\b(kapali|kapandi|kapatildi|sonuk|devre disi|off|disabled|turned off)\b/;
const NOT_SHOWN =
  /\b(gorunmuyor|gorunmemeli|gorunmez|yok|yazmiyor|cikmiyor|not shown|not visible|isn'?t shown|is not shown|doesn'?t (show|appear)|does not (show|appear)|absent|not displayed|gone)\b/;
const SHOWN = /\b(gorunuyor|gorunmeli|gorunur|yaziyor|yazmali|cikiyor|var|shown|visible|appears|is displayed|displays|shows)\b/;

function onOff(f: string): "on" | "off" | undefined {
  if (OFF.test(f)) return "off";
  if (ON.test(f)) return "on";
  return undefined;
}

/** A device-state check, if the sentence is about one. */
function deviceCheck(text: string): DeviceCheck | undefined {
  // Keywords count only outside quotes: `asistan "fener açıldı" diyor` is about the screen, not the torch.
  const f = fold(withoutQuotes(text));
  if (has(f, /\b(fener|flas|el feneri|flashlight|torch)/)) {
    const v = onOff(f);
    if (v) return { torch: v };
  }
  // "arama" is also "search" in Turkish: only call words or a call-state verb make it a call check.
  const callWord =
    has(f, /\b(cagri|telefon aramasi|sesli arama|phone call|call)\b/) ||
    has(f, /\barama(si)?\b.*\b(basladi|baslatildi|basliyor|yapiliyor|suruyor|baglandi|bitti|sonlandi|yok)\b/);
  if (callWord && !has(f, /\bsonuc/)) {
    if (has(f, /\b(bitti|sonlandi|kapandi|yok|idle|ended|no call|not (active|started))\b/)) return { call: "idle" };
    return { call: "active" };
  }
  if (has(f, /\balarm/)) {
    const t = text.match(/\b(\d{1,2})[:.](\d{2})\b/);
    if (t) return { alarm: `${t[1]!.padStart(2, "0")}:${t[2]}` };
    if (has(f, /\b(yok|kurulu degil|none|not set|no alarm)\b/)) return { alarm: "none" };
    return { alarm: "set" };
  }
  if (has(f, /\b(muzik|medya|sarki|music|media|song)\b/)) {
    if (has(f, /\b(durdu|calmiyor|duraklatildi|stopped|paused|not playing)\b/)) return { media: "stopped" };
    if (has(f, /\b(caliyor|oynatiliyor|playing)\b/)) return { media: "playing" };
  }
  for (const [re, key] of [
    [/\b(wi-?fi|kablosuz)\b/, "wifi"],
    [/\bbluetooth\b/, "bluetooth"],
    [/\b(ucak modu|airplane mode|flight mode)\b/, "airplane"],
  ] as const) {
    if (has(f, re)) {
      const v = onOff(f);
      if (v) return { [key]: v } as DeviceCheck;
    }
  }
  const q = quotes(text);
  if (has(f, /\b(bildirim|notification)/) && q[0]) return { notification: q[0] };
  const pkg = q.find((x) => /^[a-z][\w]*(\.[a-z_][\w]*){2,}$/i.test(x));
  if (pkg && has(f, /\b(on planda|onde|foreground|in front)\b/)) return { app: pkg };
  return undefined;
}

/** `Kontrol: …` → device check, see / not_see for quoted screen text, otherwise a Jev expectation. */
export function parseCheck(text: string, optional: boolean): Step[] {
  const opt = optional ? { optional: true } : {};
  const dev = deviceCheck(text);
  if (dev) return [{ device: dev, ...opt }];
  const f = fold(withoutQuotes(text));
  const q = quotes(text);
  const fuzzy = /\b(gibi|benzeri|like|similar|something like)\b/.test(f);
  if (q.length && !fuzzy) {
    if (NOT_SHOWN.test(f)) return q.map((t) => ({ not_see: t, ...opt }));
    // Quoted text with a "shown" verb, or nothing but the quote(s) and "ekranda"/"on screen".
    const rest = f
      .replace(/\b(ekranda|ekranin|sayfada|on (the )?screen|metni|yazisi|text|the)\b/g, "")
      .replace(SHOWN, "")
      .trim();
    if (SHOWN.test(f) || rest === "" || rest === "ve" || rest === "and") return q.map((t) => ({ see: t, ...opt }));
  }
  return [{ expect: text.trim(), ...opt }];
}

// ---------- actions ----------

const SUBMIT = /\b(ve gonder|gonder|enter'?a bas|ve enter|submit|and send|send it|and press enter|press enter)\b/;

/** Strip the verb and filler from a tap target written in prose ("Ayarlar sekmesine dokun"). */
function tapTarget(text: string): string {
  return text
    .replace(/\b(dokun|bas|tikla|tıkla|sec|seç|tap( on)?|click( on)?|press|select|open)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:]$/, "");
}

const APP_WORD = /\buygulama(yi|ya|nin)?\b|\bthe app\b|\bapp\b/;

/** One plan line (without its list marker) → flow steps. Undefined when no rule matches. */
export function parseStep(raw: string): Step[] | undefined {
  let text = raw.trim().replace(/^\[[ xX]\]\s*/, "");
  let optional = false;
  const optRe = /\s*\((isteğe bağlı|istege bagli|opsiyonel|optional)\)\s*$/i;
  if (optRe.test(text)) {
    optional = true;
    text = text.replace(optRe, "");
  }
  const opt = optional ? { optional: true } : {};
  const f = fold(text);
  const q = quotes(text);

  const check = text.match(/^(kontrol( et)?|dogrula|doğrula|beklenen|check|verify|expect|assert)\s*:\s*(.+)$/i);
  if (check) return parseCheck(check[3]!, optional);

  // App lifecycle
  if (APP_WORD.test(f) && /\b(yeniden baslat|restart|relaunch)\b/.test(f)) return ["stop", "launch"];
  if (APP_WORD.test(f) && /\b(ac|baslat|calistir|open|launch|start)\b/.test(f) && !q.length) return ["stop", "launch"];
  if (APP_WORD.test(f) && /\b(kapat|durdur|close|stop|kill)\b/.test(f) && !q.length) return ["stop"];

  // Calls
  if (/\b(aramayi|cagriyi)\s+(kapat|sonlandir|bitir)|\b(end the call|hang up)\b/.test(f)) return [{ key: "KEYCODE_ENDCALL" }];

  // URL / deep link
  const url = text.match(/\b([a-z][\w+.-]*:\/\/\S+?)(?=["”»]?(\s|$))/i);
  if (url && /\b(ac|git|open|go to|visit)\b/.test(f)) return [{ open: url[1]! }];

  // Waiting
  const until = /\b(gorunene kadar|cikana kadar|gelene kadar|until|wait for)\b/.test(f);
  if (/\b(bekle|wait)\b/.test(f) && until && q[0]) return [{ wait_for: q[0], ...opt }];
  const secs = f.match(/(\d+(?:[.,]\d+)?)\s*(sn|saniye|seconds?|secs?|s)\b/);
  const ms = f.match(/(\d+)\s*ms\b/);
  if (/\b(bekle|wait)\b/.test(f) && (secs || ms)) {
    const n = ms ? Number(ms[1]) : Math.round(Number(secs![1]!.replace(",", ".")) * 1000);
    return [{ wait: Math.min(n, 60_000) }];
  }

  // Keyboard, navigation, scrolling
  if (/\bklavye(yi)?\b.*\b(kapat|gizle|indir)\b|\b(hide|close|dismiss) the keyboard\b/.test(f)) return ["hide_keyboard"];
  if (/^(geri( don| git| gel)?|geri tusuna bas|go back|press back|back)\b/.test(f)) return ["back"];
  if (/\b(ana ekrana (don|git)|home tusuna bas|go home|press home)\b/.test(f)) return [{ key: "home" }];
  if (/^(enter'?a bas|enter tusuna bas|press enter)\b/.test(f)) return [{ key: "enter" }];
  const dirWord = f.match(/\b(asagi|yukari|sola|saga|down|up|left|right)\b/)?.[1];
  if (dirWord && /\b(kaydir|scroll|swipe)\b/.test(f)) {
    const dir = ({ asagi: "down", yukari: "up", sola: "left", saga: "right" } as Record<string, string>)[dirWord] ?? dirWord;
    // "Scroll down" / "aşağı kaydır" means "show what's below": the finger swipes up. "Swipe up" is literal.
    const literal = /\bswipe\b/.test(f) || dir === "left" || dir === "right";
    const swipe = (literal ? dir : dir === "down" ? "up" : "down") as "up" | "down" | "left" | "right";
    return [{ swipe }];
  }

  // Typing: `"Alan" alanına "metin" yaz [ve gönder]` / `Type "text" into "Field" [and send]`
  if (/\b(yaz|gir|type|enter)\b/.test(f) && q.length) {
    const submit = SUBMIT.test(f);
    const en = text.match(
      /^\s*(type|enter)\s+["“«]([^"”»]+)["”»]\s+(?:into the|into|in the|in)\s+(.+?)(\s+and\s+(send|submit|press enter).*)?$/i,
    );
    if (en) {
      const field = quotes(en[3]!)[0] ?? en[3]!.replace(/[.]$/, "").trim();
      return [{ type: { into: field, text: en[2]!, ...(submit ? { submit } : {}) }, ...opt }];
    }
    if (q.length >= 2) return [{ type: { into: q[0]!, text: q[1]!, ...(submit ? { submit } : {}) }, ...opt }];
    // One quote: the field is described in prose before it ("Mesaj alanına "merhaba" yaz").
    const before = text.slice(0, text.search(/["“«]/)).trim();
    if (before) return [{ type: { into: before, text: q[0]!, ...(submit ? { submit } : {}) }, ...opt }];
  }

  // Conditional tap: `Varsa "Daha sonra"ya dokun` / `If "Not now" is shown, tap it`
  if (/^(varsa|gorunurse|cikarsa|if)\b/.test(f) && q[0]) {
    return [{ if_visible: q[0], then: [{ tap: q[0] }] }]; // label match covers text and description
  }

  // Tapping
  if (/\b(dokun|bas|tikla|sec|tap|click|press|select)\b/.test(f)) {
    const target = q[0] ?? tapTarget(text);
    if (target) return [{ tap: target, ...opt }];
  }
  return undefined;
}

// ---------- the file ----------

const LIST_ITEM = /^\s*(?:\d+[.)]|[-*+•])\s+(.*)$/;
const HEADER = /^\s*(uygulama|app|platform|cihaz|device|izin|izinler|allow|permissions?)\s*:\s*(.+)$/i;

function permissions(value: string) {
  const f = fold(value);
  return {
    calls: /\b(arama|aramalar|cagri|calls?|phone)\b/.test(f),
    dialogs: /\b(izinler|izin pencereleri|permissions|dialogs)\b/.test(f),
  };
}

export class PlanError extends Error {}

export function parsePlan(text: string): Plan {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let app: string | undefined;
  let platform: "android" | "ios" | undefined;
  let device: string | undefined;
  let planPerms = { calls: false, dialogs: false };
  const tests: Array<{ title: string; line: number; steps: Step[]; perms: { calls: boolean; dialogs: boolean } }> = [];
  const errors: string[] = [];

  lines.forEach((raw, i) => {
    const line = raw.replace(/\*\*/g, "").replace(/`/g, '"').trimEnd();
    const heading = line.match(/^\s*#{2,4}\s+(.+)$/);
    if (heading) {
      tests.push({ title: heading[1]!.trim(), line: i + 1, steps: [], perms: { calls: false, dialogs: false } });
      return;
    }
    const header = line.match(HEADER);
    if (header && !LIST_ITEM.test(line)) {
      const key = fold(header[1]!);
      const value = header[2]!.trim().replace(/^["“]|["”]$/g, "");
      if (key === "uygulama" || key === "app") app = value;
      else if (key === "platform") platform = /ios/i.test(value) ? "ios" : "android";
      else if (key === "cihaz" || key === "device") device = value;
      else {
        const p = permissions(value);
        const current = tests.at(-1);
        if (current) current.perms = { calls: current.perms.calls || p.calls, dialogs: current.perms.dialogs || p.dialogs };
        else planPerms = { calls: planPerms.calls || p.calls, dialogs: planPerms.dialogs || p.dialogs };
      }
      return;
    }
    const item = line.match(LIST_ITEM);
    if (!item) return; // prose, titles and blank lines are notes
    const current = tests.at(-1);
    if (!current) {
      tests.push({ title: "Test", line: i + 1, steps: [], perms: { calls: false, dialogs: false } });
    }
    const steps = parseStep(item[1]!);
    if (steps) tests.at(-1)!.steps.push(...steps);
    else errors.push(`line ${i + 1}: can't read "${item[1]!.trim()}"`);
  });

  if (!app) errors.unshift('missing "uygulama: <package>" (or "app: <package>") at the top');
  const empty = tests.filter((t) => t.steps.length === 0);
  for (const t of empty) errors.push(`line ${t.line}: test "${t.title}" has no steps`);
  if (tests.length === 0) errors.push("no tests: add a `## Test name` heading followed by numbered steps");
  if (errors.length) throw new PlanError(`Test plan has problems:\n- ${errors.join("\n- ")}\n\n${PLAN_HINT}`);

  return {
    app: app!,
    ...(platform ? { platform } : {}),
    ...(device ? { device } : {}),
    tests: tests.map((t) => {
      const calls = planPerms.calls || t.perms.calls;
      const dialogs = planPerms.dialogs || t.perms.dialogs;
      const flow = FlowSchema.parse({
        name: t.title,
        app: app!,
        ...(platform ? { platform } : {}),
        calls: calls ? "allow" : "block",
        permissions: dialogs ? "allow" : "stop",
        steps: t.steps,
      });
      return { title: t.title, line: t.line, flow };
    }),
  };
}

export const PLAN_HINT = `Step forms (Turkish or English, quotes for exact texts):
  Uygulamayı aç | Uygulamayı kapat | Geri dön | Klavyeyi kapat | Aşağı kaydır | 2 saniye bekle | "Tamam" görünene kadar bekle
  "Ayarlar" sekmesine dokun | Varsa "Daha sonra"ya dokun | "Mesaj" alanına "merhaba" yaz ve gönder | Aramayı kapat
  Kontrol: fener açık | Kontrol: arama başladı | Kontrol: alarm 07:00 | Kontrol: müzik çalıyor | Kontrol: Wi-Fi kapalı
  Kontrol: bildirim "Hatırlatma" | Kontrol: "Kaydedildi" görünüyor | Kontrol: "Hata" görünmüyor | Kontrol: <any sentence, judged by Jev>`;
