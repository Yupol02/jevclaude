import { type Bounds, clean, makeSnapshot, type UiElement, type UiSnapshot } from "./uitree.js";

/** One visible element of a web page, in CSS pixels relative to the viewport (from PAGE_SCRIPT). */
export interface WebItem {
  /** Tag name, e.g. "a", "button", "input", "p". */
  k: string;
  t: string;
  id?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** clickable */
  c: 0 | 1;
  /** editable */
  e: 0 | 1;
  /** password field */
  p?: 0 | 1;
  /** Link target without query or fragment: a path on the same site, or host + path elsewhere. */
  u?: string;
}

export interface WebPage {
  dpr: number;
  vw: number;
  vh: number;
  url: string;
  title: string;
  items: WebItem[];
}

/**
 * Runs inside the page (Runtime.evaluate). Collects visible interactive elements and text blocks with
 * their viewport rectangles. Kept small and dependency-free; returns a JSON string.
 */
export const PAGE_SCRIPT = `(() => {
  const vw = innerWidth, vh = innerHeight, out = [];
  const vis = (r) => r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const shown = (el) => { const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && +s.opacity !== 0; };
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  // Skip elements covered by an overlay (dialog, search panel, cookie banner): the topmost element at
  // a visible point inside the element must be the element itself or one of its descendants/ancestors.
  const onTop = (el, r) => {
    const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + Math.min(8, r.width / 2), r.top + Math.min(8, r.height / 2)]];
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return true;
    }
    return false;
  };
  const SEL = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=""],[contenteditable=true]';
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (!vis(r) || !shown(el) || !onTop(el, r)) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const editable = (tag === "input" && !/^(button|submit|reset|checkbox|radio|hidden|image|file|range|color)$/.test(type)) || tag === "textarea" || el.isContentEditable;
    const text = norm(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.title || el.getAttribute("alt"));
    // Where a link goes survives machine translation of its text (Chrome's auto-translate). Query
    // strings and fragments are dropped: they can carry tokens or personal data.
    let u = "";
    if (tag === "a" && el.href) {
      try { const h = new URL(el.href); if (/^https?:$/.test(h.protocol)) u = decodeURIComponent((h.host === location.host ? "" : h.host) + h.pathname).slice(0, 80); } catch {}
    }
    out.push({ k: tag, t: text.slice(0, 120), id: el.id || el.getAttribute("name") || "", x: r.left, y: r.top, w: r.width, h: r.height, c: 1, e: editable ? 1 : 0, p: type === "password" ? 1 : 0, u });
    if (out.length >= 150) break;
  }
  const seen = new Set();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode()) && out.length < 300) {
    if (norm(n.textContent).length < 2) continue;
    const el = n.parentElement;
    if (!el || seen.has(el) || el.closest(SEL) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (!vis(r) || !shown(el) || !onTop(el, r)) continue;
    out.push({ k: el.tagName.toLowerCase(), t: norm(el.innerText).slice(0, 200), x: r.left, y: r.top, w: r.width, h: r.height, c: 0, e: 0 });
  }
  return JSON.stringify({ dpr: devicePixelRatio, vw, vh, url: location.href, title: document.title, items: out });
})()`;

const WEB_CONTAINER = /^(web ?view|web görüntüleme)$/i;
/** Chrome's own UI above the page (resource-id suffixes). */
const BROWSER_UI = /(^|\/|:)(toolbar|url_bar|location_bar|control_container|toolbar_container)$/;

/**
 * True when tapping at (x, y) would hit the browser's own UI rather than the page: a native,
 * clickable element outside the page sits there. Used as a last check before tapping web elements.
 */
export function hitsNativeUi(snap: UiSnapshot, x: number, y: number): UiElement | undefined {
  return snap.elements.find(
    (el) =>
      !el.cls.startsWith("Web.") &&
      el.clickable &&
      !el.scrollable &&
      x >= el.bounds.left &&
      x <= el.bounds.right &&
      y >= el.bounds.top &&
      y <= el.bounds.bottom,
  );
}

/** The on-screen element that hosts the page (Chrome's content view or an android.webkit.WebView). */
export function findWebContainer(snap: UiSnapshot): UiElement | undefined {
  const candidates = snap.elements.filter((el) => /WebView/i.test(el.cls) || WEB_CONTAINER.test(el.desc || el.text));
  // The largest one is the page; small WebViews (ads, embeds) are ignored.
  return candidates.sort((a, b) => area(b.bounds) - area(a.bounds))[0];
}

const area = (b: Bounds) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
const inside = (b: Bounds, r: Bounds) => {
  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2;
  return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
};

/**
 * Replace whatever the accessibility tree exposed inside the web container with the page's own
 * elements, mapped to screen pixels. Browser UI outside the container (address bar, tabs) is kept.
 */
export function mergeWebPage(snap: UiSnapshot, page: WebPage): UiSnapshot {
  const host = findWebContainer(snap);
  if (!host || !page.vw) return snap;
  const host0 = host.bounds;
  // Prefer the measured ratio between the container and the CSS viewport; fall back to devicePixelRatio.
  const scale = host0.right > host0.left ? (host0.right - host0.left) / page.vw : page.dpr;
  // Drivers disagree about the container's top edge (UiAutomator2 includes the area under Chrome's
  // toolbar, uiautomator dump doesn't), but agree on the bottom. The page's visible height comes
  // from the page itself, so anchor the page at the bottom edge.
  const pageHeight = page.vh * scale;
  let top = pageHeight > 0 && pageHeight <= host0.bottom - host0.top + 4 ? Math.round(host0.bottom - pageHeight) : host0.top;
  // Never start the page under a visible browser toolbar / address bar (seen while Chrome's toolbar
  // animates: the page height and the native tree briefly disagree).
  const toolbarBottom = Math.max(
    0,
    ...snap.elements
      .filter((el) => BROWSER_UI.test(el.resourceId) && el.bounds.bottom < host0.top + (host0.bottom - host0.top) / 2)
      .map((el) => el.bounds.bottom),
  );
  if (toolbarBottom > top) top = toolbarBottom;
  const R: Bounds = { ...host0, top };
  const webEls: UiElement[] = [];
  for (const it of page.items) {
    const left = Math.round(R.left + it.x * scale);
    const top = Math.round(R.top + it.y * scale);
    const b: Bounds = {
      left: Math.max(R.left, left),
      top: Math.max(R.top, top),
      right: Math.min(R.right, Math.round(left + it.w * scale)),
      bottom: Math.min(R.bottom, Math.round(top + it.h * scale)),
    };
    if (b.right - b.left < 2 || b.bottom - b.top < 2) continue;
    webEls.push({
      index: -1,
      cls: `Web.${it.k}`,
      text: clean(it.t),
      desc: it.u ? `link to ${clean(it.u)}` : "",
      resourceId: it.id ? `web:${it.id}` : "",
      childText: "",
      pkg: host.pkg,
      bounds: b,
      clickable: it.c === 1,
      editable: it.e === 1,
      scrollable: false,
      checkable: false,
      checked: false,
      enabled: true,
      focused: false,
      password: it.p === 1,
      selected: false,
    });
  }
  const kept: UiElement[] = [];
  for (const el of snap.elements) {
    if (el === host) {
      // Keep the host (scrollable page) and put the page's elements right after it.
      kept.push({ ...el, scrollable: true, desc: page.title ? `Web page: ${clean(page.title).slice(0, 80)}` : el.desc }, ...webEls);
      continue;
    }
    if (inside(el.bounds, R)) continue; // a11y copies of web content (sometimes partial) are replaced
    kept.push({ ...el });
  }
  return makeSnapshot(kept, snap.packages, snap.screen);
}

/** Address-bar text, used to pick the matching DevTools target among several tabs. */
export function urlHint(snap: UiSnapshot): string | undefined {
  return snap.elements.find((el) => el.editable && /url_bar|location_bar|omnibox/i.test(el.resourceId))?.text || undefined;
}
