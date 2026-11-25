import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { loadConfig, runnerConfigFrom } from "../config.js";
import { type ConnectOptions, connectDriver } from "../driver/select.js";
import { SelectorCache } from "../engine/cache.js";
import { Runner, type RunnerConfig, type RunResult } from "../engine/runner.js";
import { UsageMeter } from "../jev/client.js";
import { toHtml } from "../report/html.js";
import { JEV_INPUT_USD_PER_MTOK, type Usage } from "../report/text.js";
import { tryJev } from "../session.js";
import { type Plan, parsePlan } from "./parse.js";

/** Read a plan file: Markdown / text as UTF-8, PDF through its text layer. */
export async function readPlanText(path: string): Promise<string> {
  if (extname(path).toLowerCase() === ".pdf") {
    // PDF.js (inside unpdf) uses the global Iterator helpers, which Node has only from 22 on.
    if (typeof (globalThis as { Iterator?: unknown }).Iterator === "undefined") {
      throw new Error(
        `reading PDF plans needs Node 22 or newer (this is Node ${process.versions.node}); save the plan as .md or .txt, or upgrade Node`,
      );
    }
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    const joined = pages.join("\n");
    if (!joined.trim()) throw new Error(`${path}: the PDF has no text layer (scanned?). Export the plan as .md or .txt instead.`);
    return joined;
  }
  return readFile(path, "utf8");
}

export interface PlanRunOptions extends ConnectOptions {
  /** Run only the tests whose titles contain one of these strings (case-insensitive). */
  only?: string[];
  config?: Partial<RunnerConfig>;
  reportsDir?: string;
  cache?: "on" | "off" | "update";
}

export interface PlanRunResult {
  plan: Plan;
  results: RunResult[];
  usage?: Usage;
  text: string;
  dir: string;
}

const ICON: Record<string, string> = { passed: "✓", failed: "✗", uncertain: "?", blocked: "⛔" };

export async function runPlanFile(path: string, opts: PlanRunOptions = {}): Promise<PlanRunResult> {
  const plan = parsePlan(await readPlanText(path));
  return runPlan(plan, basename(path), opts);
}

/** Run every test of a plan on one device connection. A failing test doesn't stop the others. */
export async function runPlan(plan: Plan, label: string, opts: PlanRunOptions = {}): Promise<PlanRunResult> {
  const log = opts.log ?? (() => {});
  const cfg = loadConfig();
  const only = opts.only?.map((o) => o.toLocaleLowerCase());
  const tests = only ? plan.tests.filter((t) => only.some((o) => t.title.toLocaleLowerCase().includes(o))) : plan.tests;
  if (tests.length === 0) throw new Error(`no test title matches ${JSON.stringify(opts.only)}`);

  const driver = await connectDriver({
    platform: plan.platform,
    device: plan.device,
    androidBackend: cfg.android?.backend,
    wdaUrl: cfg.ios?.wda_url,
    ...opts,
  });
  const rawJev = tryJev(cfg, log);
  const meter = new UsageMeter();
  const jev = rawJev ? meter.wrap(rawJev) : undefined;
  const config: Partial<RunnerConfig> = { ...runnerConfigFrom(cfg), ...opts.config };
  if (!rawJev) config.riskGuard = false;
  const cache = SelectorCache.forApp(plan.app, ".jevclaude", opts.cache ?? cfg.cache ?? "on");

  const t0 = performance.now();
  const results: RunResult[] = [];
  const dir = join(
    opts.reportsDir ?? cfg.reports_dir ?? "reports",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-plan-${label.replace(/[^\w.-]+/g, "_")}`,
  );
  await mkdir(dir, { recursive: true });
  const shots = new Map<RunResult, string>();
  try {
    for (const [i, test] of tests.entries()) {
      log(`▶ ${test.title}`);
      const runner = new Runner(driver, jev, { config, log: (m) => log(`  ${m}`), cache });
      let r: RunResult;
      try {
        r = await runner.start(test.flow);
      } catch (e) {
        r = {
          flow: test.title,
          app: plan.app,
          device: driver.name,
          status: "failed",
          steps: [{ index: 0, step: "setup", status: "failed", decidedBy: "none", detail: (e as Error).message, ms: 0 }],
          resumable: false,
          crashes: [],
          totalMs: 0,
        };
      }
      results.push(r);
      const stop = r.steps.findLast((s) => s.shot && s.status !== "passed");
      for (const s of r.steps) {
        if (!s.shot) continue;
        const file = join(dir, `test-${String(i + 1).padStart(2, "0")}-step-${String(s.index + 1).padStart(2, "0")}.png`);
        await writeFile(file, s.shot);
        if (s === stop) shots.set(r, file);
      }
    }
  } finally {
    await driver.close?.();
  }

  const usage = rawJev ? meter.toJSON() : undefined;
  const html = join(dir, "report.html");
  await writeFile(
    html,
    toHtml(
      results.map((result) => ({ result })),
      `jevclaude · ${label}`,
    ),
  );
  await writeFile(
    join(dir, "report.json"),
    JSON.stringify(
      { plan: label, app: plan.app, jev: usage, tests: results.map((r) => ({ ...r, steps: r.steps.map(({ shot, ...rest }) => rest) })) },
      null,
      2,
    ),
  );
  const text = formatPlanReport(label, plan, results, usage, (performance.now() - t0) / 1000, { html, shots });
  return { plan, results, usage, text, dir };
}

/** Short report for Claude: one line per passing test, details only for the others. */
export function formatPlanReport(
  label: string,
  plan: Plan,
  results: RunResult[],
  usage: Usage | undefined,
  seconds: number,
  extras: { html?: string; shots?: Map<RunResult, string> } = {},
): string {
  const passed = results.filter((r) => r.status === "passed").length;
  const lines = [
    `${passed}/${results.length} tests passed — ${label} · ${plan.app} · ${results[0]?.device ?? "?"} · ${seconds.toFixed(1)}s`,
  ];
  for (const r of results) {
    lines.push(`${ICON[r.status] ?? "?"} ${r.flow} (${(r.totalMs / 1000).toFixed(1)}s)`);
    for (const n of r.notes ?? []) lines.push(`    note: ${n}`);
    if (r.status === "passed") continue;
    const stop = r.steps.findLast((s) => s.status !== "passed" && s.status !== "skipped" && !s.optional);
    if (stop) {
      const meta = [s(stop.probability, "p"), stop.element ? `el=${JSON.stringify(stop.element)}` : ""].filter(Boolean).join(" ");
      lines.push(
        `    step ${stop.index + 1}: ${stop.step} → ${stop.status.toUpperCase()}${meta ? ` [${meta}]` : ""}${stop.detail ? ` — ${stop.detail}` : ""}`,
      );
    }
    if (r.crashes.length) lines.push(`    crash: ${r.crashes[0]!.split("\n").slice(0, 3).join(" | ").slice(0, 400)}`);
    if (r.failureScreen)
      lines.push(
        "    screen:",
        ...r.failureScreen
          .split("\n")
          .slice(0, 40)
          .map((l) => `      ${l}`),
      );
    const shot = extras.shots?.get(r);
    if (shot) lines.push(`    screenshot: ${shot}`);
  }
  if (usage) {
    const cost = (usage.inputTokens / 1e6) * JEV_INPUT_USD_PER_MTOK;
    lines.push(`Jev: ${usage.calls} calls, ${usage.inputTokens} input tokens (~$${cost.toFixed(5)})`);
  }
  if (extras.html) lines.push(`HTML report: ${extras.html}`);
  if (passed < results.length) {
    lines.push(
      "Next: UNCERTAIN → judge the screen yourself. FAILED → fix the app or the plan line. BLOCKED → ask the user (risky action, permission dialog or an unapproved call). Re-run only those tests with `only`.",
    );
  }
  return lines.join("\n");
}

const s = (v: number | undefined, k: string) => (v === undefined ? "" : `${k}=${v.toFixed(2)}`);
