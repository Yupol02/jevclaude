import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SelectorCache } from "../src/engine/cache.js";
import { parseFlow } from "../src/engine/flow.js";
import { Runner } from "../src/engine/runner.js";
import { FAST, FakeDriver, FakeJev, fixture, pick, safeJev, screen, yes } from "./helpers.js";

const LOGIN = fixture("login.xml");
const HOME = LOGIN.replace("Welcome back", "Hello, Test User");
const flow = (steps: string, head = "") => parseFlow(`app: com.example.shop\n${head}steps:\n${steps}`);
const tmpCache = () => new SelectorCache(join(mkdtempSync(join(tmpdir(), "jc-")), "cache.json"));

/** Device where tapping the login button (center y=900) navigates home. */
function loginDevice() {
  const d = new FakeDriver(LOGIN);
  d.onTap = (_x, y, dev) => {
    if (y === 900) dev.current = HOME;
  };
  return d;
}

describe("Runner: resolution layers", () => {
  it("exact matches skip Jev's pick; natural language uses it; screen is wrapped as untrusted", async () => {
    const dev = loginDevice();
    const jev = safeJev("e3");
    const r = await new Runner(dev, jev, { config: FAST, env: { TEST_EMAIL: "qa@example.test" } }).start(
      flow(
        `  - type: { into: Email, text: "\${TEST_EMAIL}" }\n  - tap: "the button that signs me in"\n  - expect: "home screen"\n  - see: "Hello"`,
      ),
    );
    expect(r.status).toBe("passed");
    expect(dev.typed).toEqual(["qa@example.test"]);
    expect(dev.taps.at(-1)).toEqual([540, 900]);
    expect(r.steps.map((s) => s.decidedBy)).toEqual(["deterministic", "jev", "jev", "deterministic"]);
    expect(Object.keys(jev.requests[0]!.questions)).toEqual(["risk"]);
    expect(String((jev.requests[0]!.state as Record<string, string>).SCREEN)).toMatch(/^<<<SCREEN/);
  });

  it("replays from the cache on the second run without asking Jev to pick or judge risk", async () => {
    const cache = tmpCache();
    const steps = `  - tap: "the button that signs me in"`;
    const first = safeJev("e3");
    await new Runner(loginDevice(), first, { config: FAST, cache }).start(flow(steps));
    cache.save();
    expect(first.asked("pick")).toBe(1);

    const second = safeJev("e3");
    const again = new SelectorCache(cache.file);
    const r = await new Runner(loginDevice(), second, { config: FAST, cache: again }).start(flow(steps));
    expect(r.status).toBe("passed");
    expect(r.steps[0]!.decidedBy).toBe("cache");
    expect(second.asked("pick")).toBe(0);
    expect(second.asked("risk")).toBe(0);
  });

  it("self-heals when the cached selector is gone", async () => {
    const cache = tmpCache();
    cache.set(SelectorCache.key("tap", "sign in"), { selector: { id: "old_button" }, label: "Sign in", fingerprint: "x", risk: 0.01 });
    const jev = safeJev("e3");
    const r = await new Runner(loginDevice(), jev, { config: FAST, cache }).start(flow(`  - tap: "sign in"`));
    expect(r.status).toBe("passed");
    expect(r.steps[0]).toMatchObject({ decidedBy: "jev", healed: true });
    expect(cache.get(SelectorCache.key("tap", "sign in"))?.selector).toEqual({ id: "btn_login" });
  });

  it("scrolls to find a target that is off screen", async () => {
    const list = (more: boolean) =>
      screen([
        { cls: "RecyclerView", scrollable: true, b: [0, 0, 1080, 2400] },
        { text: "Item 1", clickable: true, b: [0, 100, 1080, 200] },
        ...(more ? [{ text: "About phone", clickable: true, b: [0, 2000, 1080, 2100] as [number, number, number, number] }] : []),
      ]);
    const dev = new FakeDriver(list(false));
    dev.onSwipe = (d) => {
      d.current = list(true);
    };
    const r = await new Runner(dev, undefined, { config: { ...FAST, riskGuard: false, checkErrorsEveryStep: false } }).start(
      flow(`  - tap: { text: "About phone" }`),
    );
    expect(r.status).toBe("passed");
    expect(r.steps[0]!.scrolls).toBe(1);
    expect(dev.taps).toEqual([[540, 2050]]);
  });
  it("with a cache entry, scrolls deterministically and asks Jev only on the first screen", async () => {
    let page = 0;
    const pages = (n: number) =>
      screen([
        { cls: "RecyclerView", scrollable: true, b: [0, 0, 1080, 2400] },
        { text: `Row ${n}`, clickable: true, b: [0, 100, 1080, 200] },
        ...(n === 3 ? [{ text: "About phone", clickable: true, b: [0, 2000, 1080, 2100] as [number, number, number, number] }] : []),
      ]);
    const dev = new FakeDriver(pages(0));
    dev.onSwipe = (d) => {
      page += 1;
      d.current = pages(page);
    };
    const cache = tmpCache();
    cache.set(SelectorCache.key("tap", "about entry"), {
      selector: { text: "About phone" },
      label: "About phone",
      fingerprint: "x",
      risk: 0.01,
    });
    const jev = new FakeJev((q) => (q === "pick" ? pick("none", 0.9) : yes(0.01)));
    const r = await new Runner(dev, jev, { config: FAST, cache }).start(flow(`  - tap: "about entry"`));
    expect(r.status).toBe("passed");
    expect(r.steps[0]).toMatchObject({ decidedBy: "cache", scrolls: 3 });
    // one Jev request on the first screen (pick + risk together); screens 2–4 are searched without Jev
    expect(jev.asked("pick")).toBe(1);
    expect(jev.requests.filter((q) => "pick" in q.questions || "risk" in q.questions)).toHaveLength(1);
  });
});

describe("Runner: guards and decisions", () => {
  it("blocks risky actions unless allow_risky precedes them", async () => {
    const risky = new FakeJev((q) => (q === "risk" ? yes(0.97) : yes(0.01)));
    const r = await new Runner(new FakeDriver(LOGIN), risky, { config: FAST }).start(
      flow(`  - tap: { text: "Delete account" }\n  - see: "x"`),
    );
    expect(r.status).toBe("blocked");
    expect(r.resumable).toBe(true);
    expect(r.steps.map((s) => s.status)).toEqual(["blocked", "skipped"]);

    const dev = new FakeDriver(LOGIN);
    const r2 = await new Runner(dev, risky, { config: FAST }).start(flow(`  - allow_risky: true\n  - tap: { text: "Delete account" }`));
    expect(r2.status).toBe("passed");
    expect(dev.taps).toEqual([[540, 2250]]);
  });

  it("pauses on uncertain and resumes with Claude's decision", async () => {
    const runner = new Runner(new FakeDriver(LOGIN), safeJev("e3", 0.5), { config: FAST });
    const r = await runner.start(flow(`  - expect: "cart has 2 items"\n  - see: "Welcome back"`));
    expect(r.status).toBe("uncertain");
    expect(r.failureScreen).toContain("Welcome back");

    const resumed = await runner.resume("pass");
    expect(resumed.status).toBe("passed");
    expect(resumed.steps[0]).toMatchObject({ status: "passed", decidedBy: "claude" });
    expect(resumed.steps).toHaveLength(2);
  });

  it("retry re-runs the stopped step; fail ends the run", async () => {
    let p = 0.5;
    const jev = new FakeJev((q) => (q === "expect" ? yes(p) : yes(0.01)));
    const runner = new Runner(new FakeDriver(LOGIN), jev, { config: FAST });
    expect((await runner.start(flow(`  - expect: "logged out screen"`))).status).toBe("uncertain");
    p = 0.95;
    const retried = await runner.resume("retry");
    expect(retried.status).toBe("passed");
    expect(retried.steps).toHaveLength(1);

    const r2 = new Runner(new FakeDriver(LOGIN), safeJev("e3", 0.5), { config: FAST });
    await r2.start(flow(`  - expect: "x"\n  - see: "y"`));
    const failed = await r2.resume("fail");
    expect(failed.status).toBe("failed");
    expect(failed.resumable).toBe(false);
  });

  it("fails when Jev says no element matches and nothing can scroll", async () => {
    const jev = new FakeJev((q) => (q === "pick" ? pick("none", 0.9) : yes(0.01)));
    const r = await new Runner(new FakeDriver(LOGIN), jev, { config: FAST }).start(flow(`  - tap: "checkout button"`));
    expect(r.status).toBe("failed");
    expect(r.steps[0]!.detail).toContain("no element matches");
  });

  it("handles system permission dialogs per flow policy", async () => {
    const dialog = screen(
      [
        { text: "Allow Shop to take pictures?", b: [100, 900, 980, 1000] },
        { text: "While using the app", clickable: true, id: "allow_fg", b: [100, 1100, 980, 1200] },
        { text: "Don't allow", clickable: true, id: "deny", b: [100, 1300, 980, 1400] },
      ],
      "com.google.android.permissioncontroller",
    );
    const mk = () => {
      const d = new FakeDriver(LOGIN);
      d.onTap = (_x, y, dev) => {
        dev.current = y === 900 ? dialog : LOGIN;
      };
      return d;
    };
    const base = { ...FAST, riskGuard: false, checkErrorsEveryStep: false };

    const allowDev = mk();
    const ok = await new Runner(allowDev, undefined, { config: base }).start(flow(`  - tap: { id: btn_login }`, "permissions: allow\n"));
    expect(ok.status).toBe("passed");
    expect(allowDev.taps.at(-1)).toEqual([540, 1150]);

    const stopped = await new Runner(mk(), undefined, { config: base }).start(flow(`  - tap: { id: btn_login }`));
    expect(stopped.status).toBe("blocked");
    expect(stopped.steps[0]!.detail).toContain("permission dialog");
  });
});

describe("Runner: flow control and offline use", () => {
  const offline = { ...FAST, riskGuard: false, checkErrorsEveryStep: false };

  it("optional steps don't stop the flow; if_visible picks a branch", async () => {
    const dev = new FakeDriver(LOGIN);
    const r = await new Runner(dev, undefined, { config: offline }).start(
      flow(
        `  - see: "Promo banner"\n    optional: true\n  - if_visible: "Forgot password?"\n    then: [ { tap: { text: "Forgot password?" } } ]\n    else: [ back ]\n  - if_visible: "Nope"\n    then: [ back ]`,
      ),
    );
    expect(r.status).toBe("passed");
    expect(r.steps.map((s) => `${s.status}${s.optional ? "*" : ""}`)).toEqual(["failed*", "passed", "passed", "passed"]);
    expect(dev.taps).toEqual([[540, 1040]]);
    expect(dev.keys).toEqual([]);
  });

  it("detects crashes deterministically: on a failing step, and at the end of the run", async () => {
    const dev = new FakeDriver(LOGIN);
    dev.crashes = ["FATAL EXCEPTION: main\nProcess: com.example.shop"];
    // a step that fails gets the crash as its reason
    const r = await new Runner(dev, undefined, { config: offline }).start(flow(`  - see: "Home"`));
    expect(r.status).toBe("failed");
    expect(r.steps[0]!.detail).toMatch(/^crash/);
    // a run whose steps all passed is still failed by a crash found at the end
    const r2 = await new Runner(new FakeDriver(LOGIN), undefined, { config: offline }).start(flow(`  - tap: { id: btn_login }`));
    expect(r2.status).toBe("passed");
    const crashing = new FakeDriver(LOGIN);
    crashing.crashes = dev.crashes;
    const r3 = await new Runner(crashing, undefined, { config: offline }).start(flow(`  - tap: { id: btn_login }`));
    expect(r3.status).toBe("failed");
    expect(r3.crashes[0]).toMatch(/FATAL/);
  });

  it("works fully offline with exact selectors", async () => {
    const r = await new Runner(loginDevice(), undefined, { config: offline }).start(
      flow(`  - tap: { id: btn_login }\n  - see: "Hello, Test User"\n  - not_see: "Welcome back"`),
    );
    expect(r.status).toBe("passed");
  });

  it("refuses Unicode on drivers that can't type it", async () => {
    const dev = new FakeDriver(LOGIN);
    dev.unicodeInput = false;
    const r = await new Runner(dev, undefined, { config: offline }).start(flow(`  - type: { into: Email, text: "şifre" }`));
    expect(r.status).toBe("failed");
    expect(r.steps[0]!.detail).toContain("non-ASCII");
  });

  it("captures a screenshot on the stopping step and in trace mode", async () => {
    const r = await new Runner(new FakeDriver(LOGIN), undefined, { config: offline }).start(flow(`  - see: "nope"`));
    expect(r.steps[0]!.shot).toBeDefined();
    const t = await new Runner(new FakeDriver(LOGIN), undefined, { config: { ...offline, trace: true } }).start(flow(`  - see: "Welcome"`));
    expect(t.steps[0]!.shot).toBeDefined();
  });
});
