import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config, loadConfig, runnerConfigFrom } from "./config.js";
import { describeSnapshot } from "./core/uitree.js";
import { type ConnectOptions, connectDriver } from "./driver/select.js";
import type { Driver } from "./driver/types.js";
import { SelectorCache } from "./engine/cache.js";
import type { Flow } from "./engine/flow.js";
import { Runner, type RunnerConfig, type RunResult } from "./engine/runner.js";
import { type JevClient, UsageMeter } from "./jev/client.js";
import { jevFromEnv } from "./jev/providers.js";
import { toHtml } from "./report/html.js";
import { toJUnit } from "./report/junit.js";
import { formatReport, type Usage } from "./report/text.js";

/** Load ./.env once (Node ≥ 20.12 has a built-in loader); existing env vars win. */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    /* ignore malformed .env; explicit env vars still work */
  }
}

export function tryJev(cfg: Config, log: (m: string) => void): JevClient | undefined {
  try {
    return jevFromEnv(process.env, cfg.jev ?? {});
  } catch (e) {
    log(`Jev not configured: ${(e as Error).message}`);
    return undefined;
  }
}

export async function snapshotText(opts: ConnectOptions = {}): Promise<string> {
  const cfg = loadConfig();
  const driver = await connectDriver({ androidBackend: cfg.android?.backend, wdaUrl: cfg.ios?.wda_url, ...opts });
  try {
    const t0 = performance.now();
    const snap = await driver.snapshot();
    const ms = Math.round(performance.now() - t0);
    return `${driver.name} · ${snap.packages.join(", ") || "?"} · ${snap.screen.width}x${snap.screen.height} · ${snap.elements.length} elements · read in ${ms} ms\n${describeSnapshot(snap)}`;
  } finally {
    await driver.close?.();
  }
}

export interface RunOptions extends ConnectOptions {
  config?: Partial<RunnerConfig>;
  reportsDir?: string;
  cache?: "on" | "off" | "update";
  record?: boolean;
  /** Write the HTML report (default true). */
  html?: boolean;
  /** Include the resume_flow hint (only meaningful for MCP sessions). */
  resumeHint?: boolean;
}

/** A started run that may be paused on a step and resumed later (MCP resume_flow). */
export class RunSession {
  readonly id = Math.random().toString(36).slice(2, 10);
  result?: RunResult;
  dir?: string;
  private recording = false;

  private constructor(
    readonly flow: Flow,
    readonly driver: Driver,
    readonly runner: Runner,
    readonly opts: RunOptions,
    readonly hasJev: boolean,
    readonly meter: UsageMeter,
  ) {}

  static async create(flow: Flow, opts: RunOptions = {}): Promise<RunSession> {
    const log = opts.log ?? (() => {});
    const cfg = loadConfig();
    const driver = await connectDriver({
      platform: flow.platform,
      androidBackend: cfg.android?.backend,
      wdaUrl: cfg.ios?.wda_url,
      ...opts,
    });
    const rawJev = tryJev(cfg, log);
    const config: Partial<RunnerConfig> = { ...runnerConfigFrom(cfg), ...opts.config };
    if (!rawJev && config.riskGuard !== false) {
      log("Risk guard and Jev checks are off because no Jev provider is configured.");
      config.riskGuard = false;
    }
    const cacheMode = opts.cache ?? cfg.cache ?? "on";
    const cache = SelectorCache.forApp(flow.app, ".jevclaude", cacheMode);
    const meter = new UsageMeter();
    const runner = new Runner(driver, rawJev ? meter.wrap(rawJev) : undefined, { config, log, cache });
    return new RunSession(flow, driver, runner, { ...opts, reportsDir: opts.reportsDir ?? cfg.reports_dir }, Boolean(rawJev), meter);
  }

  get usage(): Usage | undefined {
    return this.hasJev ? this.meter.toJSON() : undefined;
  }

  async start(): Promise<RunResult> {
    if (this.opts.record && this.driver.startRecording) {
      await this.driver.startRecording();
      this.recording = true;
    }
    this.result = await this.runner.start(this.flow);
    return this.result;
  }

  async resume(decision: "pass" | "fail" | "retry"): Promise<RunResult> {
    this.result = await this.runner.resume(decision);
    return this.result;
  }

  /** Write report.json, screenshots, HTML and video; return the text report for Claude/CLI. */
  async report(): Promise<string> {
    const r = this.result!;
    const base = this.opts.reportsDir ?? "reports";
    this.dir ??= join(base, `${new Date().toISOString().replace(/[:.]/g, "-")}-${r.flow.replace(/[^\w.-]+/g, "_")}`);
    await mkdir(this.dir, { recursive: true });

    let video: string | undefined;
    if (this.recording && !r.resumable && this.driver.stopRecording) {
      video = await this.driver.stopRecording(join(this.dir, "run.mp4")).catch(() => undefined);
      this.recording = false;
    }
    const stopped = r.steps.findLast((s) => s.shot && s.status !== "passed");
    let screenshot: string | undefined;
    for (const s of r.steps) {
      if (!s.shot) continue;
      const file = join(this.dir, `step-${String(s.index + 1).padStart(2, "0")}.png`);
      await writeFile(file, s.shot);
      if (s === stopped) screenshot = file;
    }
    const json = JSON.stringify({ ...r, jev: this.usage, steps: r.steps.map(({ shot, ...rest }) => rest) }, null, 2);
    await writeFile(join(this.dir, "report.json"), json);
    let html: string | undefined;
    if (this.opts.html !== false) {
      html = join(this.dir, "report.html");
      await writeFile(html, toHtml([{ result: r, usage: this.usage }], `jevclaude · ${r.flow}`));
    }
    return formatReport(r, this.usage, { ...(this.opts.resumeHint ? { runId: this.id } : {}), dir: this.dir, html, screenshot, video });
  }

  async close() {
    await this.driver.close?.();
  }
}

/** Run a flow to completion (no pause/resume), write artifacts, and return the text report. */
export async function runFlow(flow: Flow, opts: RunOptions = {}) {
  const session = await RunSession.create(flow, opts);
  try {
    const result = await session.start();
    const text = await session.report();
    return { result, usage: session.usage, text, dir: session.dir! };
  } finally {
    await session.close();
  }
}

export async function writeJUnit(path: string, results: RunResult[]) {
  await writeFile(path, toJUnit(results));
}

export async function writeCombinedHtml(path: string, runs: Array<{ result: RunResult; usage?: Usage }>) {
  await writeFile(path, toHtml(runs, "jevclaude test run"));
}
