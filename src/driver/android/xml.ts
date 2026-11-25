import { type Bounds, clean, makeSnapshot, type UiElement, type UiSnapshot } from "../../core/uitree.js";
import { parseXmlTree, type XNode } from "../../core/xmlwalk.js";

export function parseBounds(s: string | undefined): Bounds {
  const m = s?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return { left: 0, top: 0, right: 0, bottom: 0 };
  const [, l, t, r, b] = m.map(Number) as [number, number, number, number, number];
  return { left: l, top: t, right: r, bottom: b };
}

const isTrue = (v: string | undefined) => v === "true";
const shortClass = (c: string) => c.split(".").pop() ?? c;
const PROGRESS = /ProgressBar|CircularProgress/i;

function collectText(n: XNode, depth = 0): string[] {
  if (depth > 6) return [];
  const own = [clean(n.attrs.text), clean(n.attrs["content-desc"])].filter(Boolean);
  return [...own, ...n.children.flatMap((c) => collectText(c, depth + 1))];
}

/**
 * Parse Android UI XML into a snapshot. Handles both `uiautomator dump` (`<node>` tags) and
 * UiAutomator2 server page source (tags named after the widget class).
 */
export function parseAndroidXml(xml: string): UiSnapshot {
  const roots = parseXmlTree(xml);
  const hierarchy = roots.find((r) => r.tag === "hierarchy");
  const top = hierarchy ? hierarchy.children : roots;
  const elements: UiElement[] = [];
  const packages = new Set<string>();
  let screen = { width: 0, height: 0 };

  // `lifted` = an ancestor clickable container already shows this subtree's text.
  const visit = (n: XNode, lifted: boolean) => {
    const a = n.attrs;
    const bounds = parseBounds(a.bounds);
    if (a.package) packages.add(a.package);
    if (screen.width === 0 && bounds.right > 0) screen = { width: bounds.right, height: bounds.bottom };
    const cls = a.class ?? (n.tag === "node" ? "" : n.tag);
    const el: UiElement = {
      index: -1,
      cls: shortClass(cls),
      text: clean(a.text),
      desc: clean(a["content-desc"]),
      resourceId: a["resource-id"] ?? "",
      childText: "",
      pkg: a.package ?? "",
      bounds,
      clickable: isTrue(a.clickable) || isTrue(a["long-clickable"]),
      editable: /EditText|TextField|AutoComplete/i.test(cls),
      scrollable: isTrue(a.scrollable),
      checkable: isTrue(a.checkable),
      checked: isTrue(a.checked),
      enabled: a.enabled === undefined ? true : isTrue(a.enabled),
      focused: isTrue(a.focused),
      password: isTrue(a.password),
      selected: isTrue(a.selected),
    };
    const visible = bounds.right > bounds.left && bounds.bottom > bounds.top && a.displayed !== "false";
    const actionable = el.clickable || el.editable || el.scrollable || el.checkable || PROGRESS.test(cls);
    const interesting = actionable || (!lifted && (el.text || el.desc));
    let liftsChildren = lifted;
    if (visible && interesting) {
      if (el.clickable && !el.text && !el.desc) {
        el.childText = collectText(n).slice(0, 4).join(" · ").slice(0, 120);
        liftsChildren = liftsChildren || el.childText.length > 0;
      }
      elements.push(el);
    }
    for (const c of n.children) visit(c, liftsChildren);
  };
  for (const r of top) visit(r, false);
  return makeSnapshot(elements, [...packages], screen);
}
