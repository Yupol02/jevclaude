import { describe, expect, it } from "vitest";
import { describeElement, findBySelector, labelOf, screenContains } from "../src/core/uitree.js";
import { findWebContainer, mergeWebPage, urlHint, type WebPage } from "../src/core/web.js";
import { pickTarget } from "../src/driver/android/cdp.js";
import { parseAndroidXml } from "../src/driver/android/xml.js";
import { parseFlow } from "../src/engine/flow.js";
import { Runner } from "../src/engine/runner.js";
import { FAST, FakeDriver, screen } from "./helpers.js";

/** Chrome on a 1080-px-wide phone: toolbar on top, the page in a "Web View" below it. */
const CHROME = screen(
  [
    { cls: "EditText", text: "en.wikipedia.org/wiki/Istanbul", id: "url_bar", clickable: true, b: [150, 80, 800, 200] },
    { cls: "ImageButton", desc: "Yeni sekme", clickable: true, id: "optional_toolbar_button", b: [820, 80, 940, 200] },
    { cls: "FrameLayout", desc: "Web Görüntüleme", b: [0, 220, 1080, 2200] },
    // a partial a11y copy of page text that the merge must replace
    { text: "Istanbul (partial a11y copy)", b: [40, 400, 600, 460] },
  ],
  "com.android.chrome",
);

const PAGE: WebPage = {
  dpr: 2.8125,
  vw: 384,
  vh: 704,
  url: "https://en.wikipedia.org/wiki/Istanbul",
  title: "Istanbul - Wikipedia",
  items: [
    { k: "input", t: "Search Wikipedia", id: "searchInput", x: 16, y: 10, w: 300, h: 36, c: 1, e: 1 },
    { k: "a", t: "largest city", x: 100, y: 300, w: 80, h: 20, c: 1, e: 0, u: "/wiki/List_of_largest_cities" },
    { k: "p", t: "Istanbul straddles the Bosphorus strait.", x: 16, y: 260, w: 352, h: 40, c: 0, e: 0 },
    { k: "p", t: "below the fold", x: 16, y: 900, w: 352, h: 40, c: 0, e: 0 },
  ],
};

describe("web pages read through DevTools", () => {
  const snap = parseAndroidXml(CHROME);

  it("finds the web container and the address-bar hint", () => {
    expect(findWebContainer(snap)?.desc).toBe("Web Görüntüleme");
    expect(urlHint(snap)).toBe("en.wikipedia.org/wiki/Istanbul");
  });

  it("maps page elements to screen pixels and replaces a11y copies inside the page", () => {
    const merged = mergeWebPage(snap, PAGE);
    expect(screenContains(merged, "Bosphorus")).toBe(true);
    expect(screenContains(merged, "partial a11y copy")).toBe(false);
    expect(screenContains(merged, "below the fold")).toBe(false); // clipped to the container
    // browser UI outside the page is kept
    expect(findBySelector(merged, { id: "url_bar" })).toHaveLength(1);

    const link = merged.elements.find((e) => e.text === "largest city")!;
    expect(link.cls).toBe("Web.a");
    expect(link.clickable).toBe(true);
    // scale = 1080 / 384 = 2.8125 → x 100 → 281, y 300 → 220 + 844 = 1064
    expect(link.bounds).toEqual({ left: 281, top: 1064, right: 506, bottom: 1120 });
    // the link target is shown next to its (possibly machine-translated) text
    expect(describeElement(link)).toContain('desc="link to /wiki/List_of_largest_cities"');

    const input = findBySelector(merged, { id: "web:searchInput" })[0]!;
    expect(input.editable).toBe(true);
    expect(labelOf(input)).toBe("Search Wikipedia");
  });

  it("lets flows see, tap and type into web content", async () => {
    const dev = new FakeDriver(CHROME);
    const native = dev.snapshot.bind(dev);
    dev.snapshot = async () => mergeWebPage(await native(), PAGE);
    const typedInto: string[] = [];
    dev.typeText = async (t: string, target?: { text?: string; desc?: string; resourceId?: string; cls?: string }) => {
      typedInto.push(`${target?.cls}:${t}`);
    };
    const r = await new Runner(dev, undefined, { config: { ...FAST, riskGuard: false, checkErrorsEveryStep: false } }).start(
      parseFlow(
        'app: com.android.chrome\nsteps:\n  - see: "Bosphorus"\n  - tap: { text: "largest city" }\n  - type: { into: { id: "web:searchInput" }, text: "İstanbul" }',
      ),
    );
    expect(r.status).toBe("passed");
    expect(dev.taps[0]).toEqual([393.5, 1092]);
    expect(typedInto).toEqual(["Web.input:İstanbul"]);
  });

  it("picks the visible tab, else the one matching the address bar", () => {
    const t = (id: string, url: string, visible?: boolean) => ({
      id,
      type: "page",
      url,
      webSocketDebuggerUrl: `ws://localhost/devtools/page/${id}`,
      ...(visible === undefined ? {} : { description: JSON.stringify({ visible }) }),
    });
    expect(pickTarget([t("a", "https://example.com/", false), t("b", "https://en.wikipedia.org/wiki/Istanbul", true)])?.id).toBe("b");
    expect(
      pickTarget([t("a", "https://example.com/"), t("b", "https://en.wikipedia.org/wiki/Istanbul")], "en.wikipedia.org/wiki/Istanbul")?.id,
    ).toBe("b");
    expect(pickTarget([t("a", "https://example.com/"), t("b", "https://m.example.org/x")], "example.com")?.id).toBe("a");
    expect(pickTarget([{ id: "w", type: "service_worker", url: "x" }])).toBeUndefined();
  });
});

describe("open: step", () => {
  it("opens a URL or deep link in the flow's app, with ${VAR} interpolation", async () => {
    const dev = new FakeDriver(screen([{ text: "Home", b: [0, 0, 1080, 200] }]));
    const r = await new Runner(dev, undefined, {
      config: { ...FAST, riskGuard: false, checkErrorsEveryStep: false },
      env: { PATH_PART: "Istanbul" },
    }).start(parseFlow('app: com.android.chrome\nsteps:\n  - open: "https://en.wikipedia.org/wiki/${PATH_PART}"\n  - see: "Home"'));
    expect(r.status).toBe("passed");
    expect(dev.opened).toEqual(["https://en.wikipedia.org/wiki/Istanbul"]);
  });
});

describe("web mapping and search direction", () => {
  it("anchors the page at the container's bottom when the container also covers the toolbar", () => {
    // UiAutomator2 reports Chrome's content frame from y=75 (under the toolbar); the page itself
    // is 692 css px tall at 2.8125 → 1946 px, i.e. it starts at 2181 - 1946 = 235.
    const tall = screen(
      [
        { cls: "EditText", text: "en.wikipedia.org/wiki/Istanbul", id: "url_bar", clickable: true, b: [150, 90, 800, 220] },
        { cls: "FrameLayout", desc: "Web Görüntüleme", b: [0, 75, 1080, 2181] },
      ],
      "com.android.chrome",
    );
    const page: WebPage = { ...PAGE, vw: 384, vh: 692, items: [{ k: "a", t: "Hide", x: 330, y: 10, w: 40, h: 20, c: 1, e: 0 }] };
    const hide = mergeWebPage(parseAndroidXml(tall), page).elements.find((e) => e.text === "Hide")!;
    expect(hide.bounds.top).toBe(235 + Math.round(10 * 2.8125));
    // the url bar (y 90–220) is not under the mapped link
    expect(hide.bounds.top).toBeGreaterThan(220);
  });

  it("searches back upwards when the target isn't found below (e.g. a toolbar hidden on scroll)", async () => {
    let offset = 0; // 0 = top of page; each swipe up hides the toolbar
    const view = () =>
      screen([
        { cls: "ScrollView", scrollable: true, b: [0, 0, 1080, 2400] },
        { text: `Para ${offset}`, b: [0, 600, 1080, 700] },
        ...(offset <= 0 ? [{ text: "Tabs", clickable: true, b: [900, 50, 1060, 150] as [number, number, number, number] }] : []),
      ]);
    const dev = new FakeDriver(view());
    dev.snapshot = async () => parseAndroidXml(view());
    (dev as unknown as { swipe: (x1: number, y1: number, x2: number, y2: number) => Promise<void> }).swipe = async (_x1, y1, _x2, y2) => {
      offset += y2 < y1 ? 1 : -1;
      offset = Math.max(-1, Math.min(offset, 3));
      dev.swipes += 1;
    };
    offset = 2; // the run starts scrolled down: toolbar hidden
    const r = await new Runner(dev, undefined, { config: { ...FAST, riskGuard: false, checkErrorsEveryStep: false } }).start(
      parseFlow('app: com.example.shop\nsteps:\n  - tap: { text: "Tabs" }'),
    );
    expect(r.status).toBe("passed");
    expect(dev.taps).toEqual([[980, 100]]);
  });
});

describe("web tap safety", () => {
  it("never starts the page under a visible toolbar", () => {
    const s = screen(
      [
        { cls: "FrameLayout", id: "toolbar", clickable: true, b: [0, 75, 1080, 233] },
        { cls: "WebView", b: [0, 233, 1080, 2182] },
      ],
      "com.android.chrome",
    );
    // page claims to be taller than the space below the toolbar (toolbar mid-animation)
    const page: WebPage = {
      ...PAGE,
      vw: 384,
      vh: 740,
      items: [{ k: "input", t: "Search Wikipedia", x: 10, y: 5, w: 300, h: 30, c: 1, e: 1 }],
    };
    const input = mergeWebPage(parseAndroidXml(s), page).elements.find((e) => e.cls === "Web.input")!;
    expect(input.bounds.top).toBeGreaterThanOrEqual(233);
  });

  it("refuses to tap a web element whose position lands on browser UI", async () => {
    // a stale mapping put the web input on top of the address bar
    const xml = screen(
      [
        { cls: "EditText", id: "url_bar", text: "en.wikipedia.org", clickable: true, b: [100, 80, 900, 200] },
        { cls: "FrameLayout", desc: "Web View", b: [0, 60, 1080, 2200] },
      ],
      "com.android.chrome",
    );
    const dev = new FakeDriver(xml);
    const native = dev.snapshot.bind(dev);
    dev.snapshot = async () => {
      const s = await native();
      const bogus = {
        ...s.elements[0]!,
        cls: "Web.input",
        text: "Search Wikipedia",
        resourceId: "web:q",
        bounds: { left: 100, top: 100, right: 900, bottom: 180 },
      };
      return { ...s, elements: [...s.elements, { ...bogus, index: s.elements.length }] };
    };
    const r = await new Runner(dev, undefined, { config: { ...FAST, riskGuard: false, checkErrorsEveryStep: false } }).start(
      parseFlow('app: com.android.chrome\nsteps:\n  - tap: { id: "web:q" }'),
    );
    expect(r.status).toBe("uncertain");
    expect(r.steps[0]!.detail).toMatch(/not tapping/);
    expect(dev.taps).toEqual([]);
  });
});
