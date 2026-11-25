/**
 * Device-state checks: things a test wants to verify that aren't (reliably) on the screen —
 * is the flashlight on, did a phone call start, is an alarm set, is music playing.
 * Android reads them with adb (`dumpsys`, `settings`); the parsers are pure so they can be tested.
 */
import { z } from "zod";

export const DeviceCheckSchema = z
  .object({
    torch: z.enum(["on", "off"]).optional(),
    call: z.enum(["active", "idle"]).optional(),
    /** "set", "none", or a local time "HH:MM" the next alarm clock must ring at. */
    alarm: z.union([z.enum(["set", "none"]), z.string().regex(/^\d{1,2}[:.]\d{2}$/)]).optional(),
    media: z.enum(["playing", "stopped"]).optional(),
    wifi: z.enum(["on", "off"]).optional(),
    bluetooth: z.enum(["on", "off"]).optional(),
    airplane: z.enum(["on", "off"]).optional(),
    /** A posted notification contains this text (case-insensitive). */
    notification: z.string().min(1).optional(),
    /** This package / bundle id is in the foreground. */
    app: z.string().min(1).optional(),
  })
  .strict()
  .refine((c) => Object.values(c).filter((v) => v !== undefined).length === 1, "device: needs exactly one check");
export type DeviceCheck = z.infer<typeof DeviceCheckSchema>;

export type DeviceCheckKind = keyof DeviceCheck;

export function checkKind(c: DeviceCheck): { kind: DeviceCheckKind; want: string } {
  const [kind, want] = Object.entries(c).find(([, v]) => v !== undefined) as [DeviceCheckKind, string];
  return { kind, want };
}

export function describeCheck(c: DeviceCheck): string {
  const { kind, want } = checkKind(c);
  return `${kind} ${kind === "notification" ? JSON.stringify(want) : want}`;
}

/** What the device reported, normalised to the same vocabulary as the check ("on", "active", "07:00", …). */
export interface DeviceReading {
  value: string;
  /** For `notification`: whether the text was found. */
  found?: boolean;
}

export function matches(c: DeviceCheck, r: DeviceReading): boolean {
  const { kind, want } = checkKind(c);
  if (kind === "notification") return r.found === true;
  if (kind === "alarm" && want !== "set" && want !== "none") return r.value === normaliseTime(want);
  if (kind === "alarm" && want === "set") return r.value !== "none";
  return r.value === want;
}

const normaliseTime = (t: string) => {
  const [h, m] = t.split(/[:.]/) as [string, string];
  return `${h.padStart(2, "0")}:${m}`;
};

// ---------- parsers for adb output ----------

/**
 * `dumpsys media.camera`. Some builds print a status per camera ("Torch status for camera 0:
 * AVAILABLE_ON"); others (e.g. Samsung, Android 16) only keep the events log, newest first:
 * "Torch for camera id 0 turned on for client PID 5322". The newest event per camera wins; with an
 * events log but no torch event since boot, the torch is off.
 */
export function parseTorch(dump: string): "on" | "off" | undefined {
  const status = dump.split("\n").filter((l) => /torch status/i.test(l));
  if (status.some((l) => /AVAILABLE_ON\b/.test(l))) return "on";
  if (status.some((l) => /AVAILABLE_OFF\b|NOT_AVAILABLE\b/.test(l))) return "off";
  const latest = new Map<string, string>();
  for (const m of dump.matchAll(/Torch for camera id (\S+) turned (on|off)/gi)) {
    if (!latest.has(m[1]!)) latest.set(m[1]!, m[2]!.toLowerCase());
  }
  if (latest.size) return [...latest.values()].includes("on") ? "on" : "off";
  return /events log/i.test(dump) ? "off" : undefined;
}

/** `dumpsys telephony.registry`: mCallState=0 idle, 1 ringing, 2 off-hook (dialing or in a call), per SIM. */
export function parseCallState(dump: string): "active" | "idle" | undefined {
  const states = [...dump.matchAll(/mCallState=(\d)/g)].map((m) => Number(m[1]));
  if (states.length === 0) return undefined;
  return states.some((s) => s === 1 || s === 2) ? "active" : "idle";
}

/**
 * `dumpsys alarm`: the "Next alarm clock information" section lists, per user,
 * "user:0 pendingSend:false time:1764133200000 = 2026-11-26 07:00:00 = …". Returns local "HH:MM" or "none".
 */
export function parseNextAlarm(dump: string, user = 0): string {
  const at = dump.search(/next alarm clock information/i);
  if (at < 0) return "none";
  const section = dump.slice(at, at + 2000);
  const m = section.match(new RegExp(`user:${user}\\b[^\\n]*?time:(\\d{10,})`));
  if (!m) return "none";
  const d = new Date(Number(m[1]));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `dumpsys media_session`: any session in state 3 (PLAYING). */
export function parseMediaPlaying(dump: string): "playing" | "stopped" {
  return /PlaybackState\s*\{\s*state=3\b/.test(dump) ? "playing" : "stopped";
}

/** `settings get global wifi_on|bluetooth_on|airplane_mode_on`: "0" off, anything else (1, 2) on. */
export function parseOnOff(value: string): "on" | "off" {
  return value.trim() === "0" || value.trim() === "" || value.trim() === "null" ? "off" : "on";
}

/** `dumpsys notification --noredact`: does a posted notification's title/text contain `needle`? */
export function notificationContains(dump: string, needle: string): boolean {
  const n = needle.toLocaleLowerCase();
  return dump
    .split("\n")
    .filter((l) => /android\.(title|text|bigText|subText|infoText|summaryText)=|tickerText=/.test(l))
    .some((l) => l.toLocaleLowerCase().includes(n));
}
