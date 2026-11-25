import { describe, expect, it } from "vitest";
import { tapPoint } from "../src/core/tap.js";
import { findBySelector } from "../src/core/uitree.js";
import { parseAndroidXml } from "../src/driver/android/xml.js";
import { parseFlow } from "../src/engine/flow.js";
import { Runner } from "../src/engine/runner.js";
import { FAST, FakeDriver, FakeJev, pick, screen, yes } from "./helpers.js";

describe("tap point", () => {
  // A search bar (clickable) whose center is covered by its own mic button.
  const bar = screen([
    { cls: "LinearLayout", desc: "Search", clickable: true, id: "search_bar", b: [40, 200, 1040, 340] },
    { cls: "ImageButton", desc: "Voice search", clickable: true, id: "mic", b: [480, 210, 600, 330] },
  ]);

  it("avoids a nested clickable sitting at the center", () => {
    const snap = parseAndroidXml(bar);
    const el = findBySelector(snap, { id: "search_bar" })[0]!;
    const p = tapPoint(snap, el);
    expect(p.y).toBe(270);
    expect(p.x < 480 || p.x > 600).toBe(true);
  });

  it("uses the center when nothing nested covers it", () => {
    const snap = parseAndroidXml(screen([{ text: "OK", clickable: true, b: [100, 100, 300, 200] }]));
    expect(tapPoint(snap, snap.elements[0]!)).toEqual({ x: 200, y: 150 });
  });
});

describe("exact selectors stay exact", () => {
  it("never asks Jev to stand in for a missing exact selector", async () => {
    const jev = new FakeJev((q) => (q === "pick" ? pick("e0") : yes(0.01)));
    const dev = new FakeDriver(screen([{ text: "Türkiye", clickable: true, b: [0, 0, 1080, 200] }]));
    const r = await new Runner(dev, jev, { config: FAST }).start(
      parseFlow('app: com.android.chrome\nsteps:\n  - tap: { text: "largest city" }'),
    );
    expect(r.status).toBe("failed");
    expect(jev.asked("pick")).toBe(0);
    expect(dev.taps).toEqual([]);
  });
});
