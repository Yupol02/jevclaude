import type { Bounds, UiElement, UiSnapshot } from "./uitree.js";

const inside = (x: number, y: number, b: Bounds) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
const contains = (outer: Bounds, inner: Bounds) =>
  inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;

/**
 * Where to tap an element. Usually its center, but a clickable container (a search bar holding a
 * mic button, a list row with a switch) may have another clickable element at its center: then pick
 * a point inside the container that no nested clickable covers. Seen on a Samsung Settings search bar,
 * where the center tap opened voice search.
 */
export function tapPoint(snap: UiSnapshot, el: UiElement): { x: number; y: number } {
  const b = el.bounds;
  const nested = snap.elements.filter(
    (o) =>
      o !== el &&
      o.clickable &&
      contains(b, o.bounds) &&
      !(o.bounds.left === b.left && o.bounds.right === b.right && o.bounds.top === b.top && o.bounds.bottom === b.bottom),
  );
  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2;
  if (!nested.some((o) => inside(cx, cy, o.bounds))) return { x: cx, y: cy };
  const w = b.right - b.left;
  // Candidate points along the vertical middle, then the corners' insets.
  const xs = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9].map((f) => b.left + w * f);
  for (const x of xs) {
    if (!nested.some((o) => inside(x, cy, o.bounds))) return { x, y: cy };
  }
  return { x: cx, y: cy };
}
