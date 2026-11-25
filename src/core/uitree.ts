import { createHash } from "node:crypto";

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Platform-neutral UI element. Android (uiautomator / UiAutomator2) and iOS (WebDriverAgent) parsers produce these. */
export interface UiElement {
  /** Stable index within one snapshot, used as the option key for Jev choice questions. */
  index: number;
  cls: string;
  text: string;
  desc: string;
  /** Android resource-id or iOS accessibility identifier. */
  resourceId: string;
  /** Text gathered from descendants, for clickable containers without their own label. */
  childText: string;
  /**
   * For clickable elements with no label at all: the label of the element they overlap or touch
   * (e.g. an unlabeled tap target sitting right above a field's "Date is required" text).
   */
  near?: string;
  pkg: string;
  bounds: Bounds;
  clickable: boolean;
  editable: boolean;
  scrollable: boolean;
  checkable: boolean;
  checked: boolean;
  enabled: boolean;
  focused: boolean;
  password: boolean;
  selected: boolean;
}

export interface UiSnapshot {
  elements: UiElement[];
  /** Android packages / iOS app names present on screen. */
  packages: string[];
  /** Hash of the compact representation; equal hashes ⇒ screen considered unchanged. */
  hash: string;
  /**
   * Like `hash` but with digits masked, so a running timer, clock or counter doesn't make the
   * screen look unstable forever. Used only to decide when the screen has settled.
   */
  settleHash: string;
  /** Order-independent signature of actionable elements; used as a cache key. */
  fingerprint: string;
  screen: { width: number; height: number };
}

export function makeSnapshot(elements: UiElement[], packages: string[], screen: UiSnapshot["screen"]): UiSnapshot {
  elements.forEach((el, i) => {
    el.index = i;
  });
  annotateNear(elements);
  const compact = elements.map(describeElement).join("\n");
  const hash = createHash("sha1").update(compact).digest("hex").slice(0, 12);
  const settleHash = createHash("sha1").update(compact.replace(/\d/g, "#")).digest("hex").slice(0, 12);
  const sig = [
    ...new Set(
      elements
        .filter((e) => e.clickable || e.editable)
        .map((e) => `${e.cls}|${idSuffix(e.resourceId)}|${e.text || e.desc}`)
        .sort(),
    ),
  ].join("\n");
  const fingerprint = createHash("sha1").update(sig).digest("hex").slice(0, 12);
  return { elements, packages, hash, settleHash, fingerprint, screen };
}

const NEAR_GAP_PX = 24;

/** Give unlabeled clickable elements the label of a labelled element they overlap or directly touch. */
function annotateNear(elements: UiElement[]) {
  for (const el of elements) {
    if (!el.clickable || el.text || el.desc || el.childText || el.resourceId) continue;
    let best: { label: string; score: number } | undefined;
    for (const other of elements) {
      if (other === el) continue;
      const label = other.text || other.desc || other.childText;
      if (!label) continue;
      const a = el.bounds;
      const b = other.bounds;
      const xOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (xOverlap < 0.5 * Math.min(a.right - a.left, b.right - b.left)) continue;
      // Vertical distance between the boxes (0 when they overlap or touch).
      const gap = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
      if (gap > NEAR_GAP_PX) continue;
      const score = gap - (Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) ? 1000 : 0); // prefer overlap
      if (!best || score < best.score) best = { label: label.slice(0, 80), score };
    }
    if (best) el.near = best.label;
  }
}

export function center(b: Bounds): { x: number; y: number } {
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
}

export const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Human-readable label for an element (what a user would call it). */
export function labelOf(el: UiElement): string {
  return el.text || el.desc || el.childText || idSuffix(el.resourceId) || (el.near ? `near ${el.near}` : "");
}

export function idSuffix(resourceId: string): string {
  return resourceId.includes("/") ? resourceId.split("/").pop()! : resourceId;
}

/** One compact line per element, e.g. `[12] Button "Log in" id=btn_login {clickable}`. */
export function describeElement(el: UiElement): string {
  const parts = [`[${el.index}]`, el.cls || "View"];
  const label = el.password && el.text ? "••••" : el.text || el.desc;
  if (label) parts.push(JSON.stringify(label.slice(0, 120)));
  if (el.text && el.desc && el.desc !== el.text) parts.push(`desc=${JSON.stringify(el.desc.slice(0, 80))}`);
  if (!label && el.childText) parts.push(`contains=${JSON.stringify(el.childText)}`);
  if (!label && !el.childText && el.near) parts.push(`near=${JSON.stringify(el.near)}`);
  if (el.resourceId && idSuffix(el.resourceId) !== label) parts.push(`id=${idSuffix(el.resourceId)}`);
  const flags = [
    el.clickable && "clickable",
    el.editable && "editable",
    el.password && "password",
    el.scrollable && "scrollable",
    el.checkable && (el.checked ? "checked" : "unchecked"),
    el.focused && "focused",
    el.selected && "selected",
    !el.enabled && "disabled",
  ].filter(Boolean);
  if (flags.length) parts.push(`{${flags.join(",")}}`);
  return parts.join(" ");
}

export function describeSnapshot(snap: UiSnapshot, maxLines = 250): string {
  const lines = snap.elements.slice(0, maxLines).map(describeElement);
  if (snap.elements.length > maxLines) lines.push(`… ${snap.elements.length - maxLines} more elements`);
  return lines.join("\n");
}

export type Selector = { id?: string; text?: string; desc?: string };

const eq = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * The separate texts a clickable row lifted from its children, e.g. "Network & internet · Mobile,
 * Wi-Fi, hotspot" → ["Network & internet", "Mobile, Wi-Fi, hotspot"], so `{ text: "Network & internet" }`
 * matches a title + summary row.
 */
function childParts(el: UiElement): string[] {
  return el.childText
    ? el.childText
        .split(" · ")
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
}

/** Deterministic lookup. Returns all elements matching the selector exactly (case-insensitive). */
export function findBySelector(snap: UiSnapshot, sel: Selector): UiElement[] {
  return snap.elements.filter(
    (el) =>
      (sel.id === undefined || el.resourceId === sel.id || idSuffix(el.resourceId) === sel.id) &&
      (sel.text === undefined || eq(el.text, sel.text) || eq(el.childText, sel.text) || childParts(el).some((p) => eq(p, sel.text!))) &&
      (sel.desc === undefined || eq(el.desc, sel.desc)),
  );
}

/**
 * Cheap exact match for a natural-language target: if exactly one actionable element's
 * label/id equals the target string, return it without asking Jev.
 */
export function exactLabelMatch(snap: UiSnapshot, target: string, kind: "tap" | "type"): UiElement | undefined {
  const t = target.trim().toLocaleLowerCase();
  const actionable = snap.elements.filter((el) => (kind === "type" ? el.editable : el.clickable || el.editable || el.selected));
  const hits = actionable.filter((el) =>
    [el.text, el.desc, el.childText, idSuffix(el.resourceId), ...childParts(el)].some((v) => v && v.toLocaleLowerCase() === t),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

/** The most specific selector that identifies `el` uniquely on this screen (for the replay cache). */
export function uniqueSelector(snap: UiSnapshot, el: UiElement): Selector | undefined {
  const candidates: Selector[] = [];
  if (el.resourceId) candidates.push({ id: idSuffix(el.resourceId) });
  if (el.text) candidates.push({ text: el.text });
  if (el.desc) candidates.push({ desc: el.desc });
  if (!el.text && el.childText) candidates.push({ text: el.childText });
  if (el.resourceId && el.text) candidates.push({ id: idSuffix(el.resourceId), text: el.text });
  return candidates.find((s) => {
    const hits = findBySelector(snap, s);
    return hits.length === 1 && hits[0] === el;
  });
}

/** Elements that indicate the screen is still loading (deterministic, no model call). */
export function isLoading(snap: UiSnapshot): boolean {
  return snap.elements.some((el) => /ProgressBar|ActivityIndicator|CircularProgress/i.test(el.cls) && !/determinate/i.test(el.desc));
}

/** Text on screen, for `see:` checks. */
export function screenContains(snap: UiSnapshot, needle: string): boolean {
  const n = needle.toLocaleLowerCase();
  return snap.elements.some((el) => `${el.text}\n${el.desc}\n${el.childText}`.toLocaleLowerCase().includes(n));
}

const ERROR_HINT =
  /\b(error|errors|failed|failure|exception|went wrong|try again|retry|not responding|isn't responding|unable to|cannot|can't|invalid|denied|offline|no internet|no connection|timed? ?out)\b|hata|başarısız|tekrar dene|yeniden dene|yanıt vermiyor|durduruldu|geçersiz|bağlantı (yok|kesildi)|internet yok|reddedildi/i;
const DIALOG_CLASS = /^(Alert|AlertDialog|Dialog|Sheet)$/i;

/**
 * Cheap gate for the "is an error visible?" Jev question: true when some text looks like an error
 * message, or an alert/dialog is on screen. Field hints such as "can't be empty" also match, so Jev
 * still makes the final call.
 */
export function looksLikeError(snap: UiSnapshot): boolean {
  return snap.elements.some((el) => DIALOG_CLASS.test(el.cls) || ERROR_HINT.test(`${el.text}\n${el.desc}`));
}

/**
 * True when the screen is dominated by a web view whose content isn't in the accessibility tree
 * (Chrome and some WebViews expose it only intermittently to UiAutomator).
 */
export function webContentHidden(snap: UiSnapshot): boolean {
  const web = snap.elements.some((el) => /WebView/i.test(el.cls) || /^(web ?view|web görüntüleme)$/i.test(el.desc || el.text));
  if (!web) return false;
  const textual = snap.elements.filter(
    (el) => !el.clickable && (el.text || el.desc) && !/^(web ?view|web görüntüleme)$/i.test(el.desc || el.text),
  );
  return textual.length <= 2;
}
