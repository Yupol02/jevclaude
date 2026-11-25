import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { interpolate, loadFlowFile, parseFlow } from "../src/engine/flow.js";
import { exportMaestro, importMaestro } from "../src/maestro/convert.js";

describe("flow schema", () => {
  it("rejects unknown steps with a readable error", () => {
    expect(() => parseFlow("app: x\nsteps:\n  - click: foo")).toThrow(/Invalid flow/);
  });

  it("accepts modifiers and nested branches", () => {
    const f = parseFlow(
      "app: x\npermissions: allow\nsteps:\n  - tap: Login\n    optional: true\n    timeout: 2000\n  - if_visible: Promo\n    then: [ back ]",
    );
    expect(f.steps[0]).toEqual({ tap: "Login", optional: true, timeout: 2000 });
    expect(f.permissions).toBe("allow");
  });

  it("inlines run: sub-flows relative to the file and catches cycles", () => {
    const dir = mkdtempSync(join(tmpdir(), "jc-flow-"));
    writeFileSync(join(dir, "login.yaml"), "steps:\n  - tap: { id: btn_login }\n");
    writeFileSync(join(dir, "main.yaml"), "app: x\nsteps:\n  - launch\n  - run: login.yaml\n  - see: Home\n");
    expect(loadFlowFile(join(dir, "main.yaml")).steps).toEqual(["launch", { tap: { id: "btn_login" } }, { see: "Home" }]);

    writeFileSync(join(dir, "a.yaml"), "app: x\nsteps:\n  - run: b.yaml\n");
    writeFileSync(join(dir, "b.yaml"), "- run: a.yaml\n");
    expect(() => loadFlowFile(join(dir, "a.yaml"))).toThrow(/cycle/);
  });

  it("interpolates env and flow variables, failing loudly on missing ones", () => {
    expect(interpolate("hi ${NAME}", { NAME: "Ayşe" })).toBe("hi Ayşe");
    expect(() => interpolate("${MISSING}", {})).toThrow(/MISSING/);
  });
});

describe("Maestro conversion", () => {
  const maestro = `appId: com.example.shop
name: login
---
- launchApp:
    clearState: true
- tapOn:
    id: "email"
- inputText: "qa@example.test"
- tapOn: "Log in"
- assertVisible: "Welcome"
- assertWithAI:
    assertion: "User is signed in"
- swipe:
    direction: UP
- openLink: "https://example.com"
`;

  it("imports the common subset and reports the rest", () => {
    const { value, warnings } = importMaestro(maestro);
    expect(value.app).toBe("com.example.shop");
    expect(value.steps).toEqual([
      "launch",
      { type: { into: { id: "email" }, text: "qa@example.test" } },
      { tap: { text: "Log in" } },
      { see: "Welcome" },
      { expect: "User is signed in" },
      { swipe: "up" },
    ]);
    expect(warnings.join("\n")).toMatch(/clearState/);
    expect(warnings.join("\n")).toMatch(/openLink/);
    expect(() => parseFlow(value)).not.toThrow();
  });

  it("round-trips back to Maestro YAML", () => {
    const { value } = importMaestro(maestro);
    const out = exportMaestro(value);
    expect(out.value).toContain("appId: com.example.shop");
    expect(out.value).toContain("assertWithAI");
    const again = importMaestro(out.value);
    expect(again.value.steps).toEqual(value.steps);
  });
});
