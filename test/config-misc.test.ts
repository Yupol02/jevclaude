import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { ConfigSchema, DEFAULT_CONFIG_YAML, loadConfig, runnerConfigFrom } from "../src/config.js";
import { SelectorCache } from "../src/engine/cache.js";
import { parseFlow } from "../src/engine/flow.js";
import { Runner } from "../src/engine/runner.js";
import { UsageMeter } from "../src/jev/client.js";
import { exportMaestro, importMaestro } from "../src/maestro/convert.js";
import { FAST, FakeDriver, FakeJev, fixture, pick, safeJev, yes } from "./helpers.js";

describe("config", () => {
  it("the generated default config is valid and maps onto runner settings", () => {
    const cfg = ConfigSchema.parse(YAML.parse(DEFAULT_CONFIG_YAML));
    expect(runnerConfigFrom(cfg)).toMatchObject({ pass: 0.85, fail: 0.15, riskBlock: 0.5, maxScrolls: 5 });
    expect(cfg.android?.backend).toBe("auto");
  });

  it("maps every runner key and rejects typos with the file name", () => {
    const dir = mkdtempSync(join(tmpdir(), "jc-cfg-"));
    const file = join(dir, "c.yaml");
    writeFileSync(
      file,
      "runner:\n  min_pick_confidence: 0.7\n  risk_guard: false\n  check_errors_every_step: false\n  settle_ms: 10\n  assert_timeout_ms: 20\n  wait_for_timeout_ms: 30\n",
    );
    expect(runnerConfigFrom(loadConfig(file))).toEqual({
      minPickConfidence: 0.7,
      riskGuard: false,
      checkErrorsEveryStep: false,
      settleMs: 10,
      assertTimeoutMs: 20,
      waitForTimeoutMs: 30,
    });
    writeFileSync(file, "runer: {}\n");
    expect(() => loadConfig(file)).toThrow(/Invalid .*c\.yaml/);
    expect(loadConfig(join(dir, "missing.yaml"))).toEqual({});
  });
});

describe("cache modes and usage meter", () => {
  it("off never writes; update ignores lookups but overwrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "jc-cache-"));
    const off = new SelectorCache(join(dir, "off.json"), "off");
    off.set("k", { selector: { id: "a" }, label: "A", fingerprint: "f" });
    expect(off.get("k")).toBeUndefined();

    const on = new SelectorCache(join(dir, "c.json"));
    on.set("k", { selector: { id: "a" }, label: "A", fingerprint: "f" });
    on.hit("k");
    on.save();
    const upd = new SelectorCache(join(dir, "c.json"), "update");
    expect(upd.get("k")).toBeUndefined();
    const reread = new SelectorCache(join(dir, "c.json"));
    expect(reread.get("k")?.hits).toBe(1);
    reread.delete("k");
    expect(reread.get("k")).toBeUndefined();
    expect(SelectorCache.forApp("com.x/y").file).toMatch(/com\.x_y\.json$/);
  });

  it("meters calls, tokens and models", async () => {
    const meter = new UsageMeter();
    const jev = meter.wrap(safeJev());
    await jev.ask({ state: "s", questions: { error: { type: "noul", instructions: "?" } } });
    expect(meter.toJSON()).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 1, models: ["jev-test"] });
  });
});

describe("runner extras", () => {
  const LOGIN = fixture("login.xml");
  const flow = (steps: string) => parseFlow(`app: com.example.shop\nsteps:\n${steps}`);

  it("reports low-confidence picks as uncertain with the top options", async () => {
    const jev = new FakeJev((q) => (q === "pick" ? pick("e3", 0.4) : yes(0.01)));
    const r = await new Runner(new FakeDriver(LOGIN), jev, { config: FAST }).start(flow(`  - tap: "sign in"`));
    expect(r.status).toBe("uncertain");
    expect(r.steps[0]!.detail).toMatch(/top options: "Log in" 0\.40/);
  });

  it("fails a step when Jev sees an error after an action", async () => {
    const jev = new FakeJev((q) => (q === "error" ? yes(0.97) : yes(0.01)));
    const r = await new Runner(new FakeDriver(LOGIN), jev, { config: FAST }).start(flow(`  - back`));
    expect(r.status).toBe("failed");
    expect(r.steps[0]!.detail).toMatch(/error visible/);
  });

  it("runs keys, swipes, waits, stop and launch", async () => {
    const dev = new FakeDriver(LOGIN);
    const r = await new Runner(dev, undefined, { config: { ...FAST, riskGuard: false, checkErrorsEveryStep: false } }).start(
      flow(`  - launch\n  - key: enter\n  - swipe: left\n  - wait: 1\n  - hide_keyboard\n  - stop\n  - launch: com.other`),
    );
    expect(r.status).toBe("passed");
    expect(dev.launched).toEqual(["com.example.shop", "com.other"]);
    expect(dev.keys).toEqual(["enter", "hide_keyboard"]);
    expect(dev.swipes).toBe(1);
  });

  it("needs Jev for natural-language targets", async () => {
    const r = await new Runner(new FakeDriver(LOGIN), undefined, { config: { ...FAST, riskGuard: false } }).start(
      flow(`  - tap: "the sign in button"`),
    );
    expect(r.status).toBe("failed");
    expect(r.steps[0]!.detail).toMatch(/needs Jev/);
  });
});

describe("Maestro conversion edge cases", () => {
  it("covers the remaining commands", () => {
    const { value, warnings } = importMaestro(`appId: a
---
- launchApp: other.app
- stopApp
- inputText: "x"
- assertNotVisible: "Err"
- assertNotVisible: { id: "x" }
- assertNoDefectsWithAI
- extendedWaitUntil: { visible: "Done", timeout: 5000 }
- assertVisible: { id: "only-id" }
- scroll
- scrollUntilVisible: { element: { text: "Footer" } }
- swipe: { start: "10%,10%", end: "20%,20%" }
- back
- hideKeyboard
- pressKey: Enter
- runFlow: sub.yaml
- waitForAnimationToEnd
- takeScreenshot: shot
`);
    expect(value.steps).toEqual([
      { launch: "other.app" },
      "stop",
      { type: { into: "the focused input field", text: "x" } },
      { not_see: "Err" },
      { expect: "The screen has no visual or functional defects" },
      { wait_for: "Done", timeout: 5000 },
      { swipe: "up" },
      { wait_for: "Footer" },
      { tap: { text: "Footer" } },
      "back",
      "hide_keyboard",
      { key: "enter" },
      { run: "sub.yaml" },
      { wait: 500 },
    ]);
    expect(warnings.length).toBeGreaterThanOrEqual(4);

    const out = exportMaestro(
      parseFlow(
        'app: a\nsteps:\n  - stop\n  - hide_keyboard\n  - launch: b\n  - tap: "natural"\n  - type: { into: { id: e }, text: t, submit: true }\n  - key: enter\n  - wait: 1\n  - wait_for: X\n  - not_see: Y\n  - allow_risky: true\n  - if_visible: Z\n    then: [ back ]\n',
      ),
    );
    expect(out.value).toContain("stopApp");
    expect(out.value).toContain("extendedWaitUntil");
    expect(out.warnings.join("\n")).toMatch(/risk guard/);
  });
});
