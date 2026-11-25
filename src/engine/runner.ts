import {
  center,
  describeSnapshot,
  exactLabelMatch,
  findBySelector,
  isLoading,
  labelOf,
  screenContains,
  type UiElement,
  type UiSnapshot,
  uniqueSelector,
} from "../core/uitree.js";
import { type Driver, sleep } from "../driver/types.js";
import type { JevAnswer, JevClient } from "../jev/client.js";
import {
  afterActionRequest,
  beforeActionRequest,
  candidatesFor,
  NONE_OPTION,
  optionKey,
  permissionButtonQuestion,
} from "../jev/questions.js";
import { SelectorCache } from "./cache.js";
import { describeStep, describeTarget, type Flow, interpolate, type Step, type Target } from "./flow.js";

export interface RunnerConfig {
  /** noul ≥ pass ⇒ passed */
  pass: number;
  /** noul ≤ fail ⇒ failed; anything between is "uncertain" and goes back to Claude. */
  fail: number;
  /** Minimum choice confidence to act on Jev's element pick. */
  minPickConfidence: number;
  /** Risk probability at or above which a tap/type is blocked. */
  riskBlock: number;
  /** Ask Jev about risk before every tap/type. */
  riskGuard: boolean;
  /** Ask Jev whether an error is visible after every action. */
  checkErrorsEveryStep: boolean;
  /** Wait after an action before reading the screen. */
  settleMs: number;
  /** Upper bound for waiting until the screen stops changing. */
  settleMaxMs: number;
  /** How long to wait while a progress indicator is visible. */
  loadingTimeoutMs: number;
  /** Default retry window for see / expect / not_see. */
  assertTimeoutMs: number;
  /** Default window for wait_for. */
  waitForTimeoutMs: number;
  /** Max swipes while searching for a tap/type target. */
  maxScrolls: number;
  /** Screenshot after every step (for HTML reports). */
  trace: boolean;
}

export const DEFAULT_CONFIG: RunnerConfig = {
  pass: 0.85,
  fail: 0.15,
  minPickConfidence: 0.6,
  riskBlock: 0.5,
  riskGuard: true,
  checkErrorsEveryStep: true,
  settleMs: 350,
  settleMaxMs: 4_000,
  loadingTimeoutMs: 15_000,
  assertTimeoutMs: 6_000,
  waitForTimeoutMs: 10_000,
  maxScrolls: 5,
  trace: false,
};

export type StepStatus = "passed" | "failed" | "uncertain" | "blocked" | "skipped";
export type DecidedBy = "deterministic" | "cache" | "jev" | "claude" | "none";

export interface StepResult {
  index: number;
  step: string;
  status: StepStatus;
  /** Which layer made the decision. */
  decidedBy: DecidedBy;
  detail?: string;
  /** Element acted on, as a short label. */
  element?: string;
  probability?: number;
  confidence?: number;
  /** A cached selector no longer matched and Jev re-resolved the target. */
  healed?: boolean;
  /** Optional step that failed without stopping the flow. */
  optional?: boolean;
  scrolls?: number;
  ms: number;
  /** Screenshot after the step (trace mode / failure). Not serialised into report.json. */
  shot?: Buffer;
}

export type RunStatus = "passed" | "failed" | "uncertain" | "blocked" | "running";

export interface RunResult {
  flow: string;
  app: string;
  device: string;
  status: RunStatus;
  steps: StepResult[];
  /** The run stopped on a step Claude can decide with resume (pass / fail / retry). */
  resumable: boolean;
  /** Compact screen at the point of failure (only on non-passed runs). */
  failureScreen?: string;
  crashes: string[];
  totalMs: number;
}

class Outcome {
  constructor(
    readonly status: StepStatus,
    readonly decidedBy: DecidedBy,
    readonly detail?: string,
    readonly extra: Partial<StepResult> = {},
  ) {}
}

export interface RunnerOptions {
  config?: Partial<RunnerConfig>;
  log?: (msg: string) => void;
  env?: Record<string, string | undefined>;
  cache?: SelectorCache;
}

export class Runner {
  readonly config: RunnerConfig;
  private readonly log: (m: string) => void;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly cache?: SelectorCache;

  private flow?: Flow;
  private env: Record<string, string | undefined> = {};
  private queue: Step[] = [];
  private results: StepResult[] = [];
  private allowRiskyNext = false;
  private last?: UiSnapshot;
  /** `last` reflects the current screen (no action since it was taken). */
  private fresh = false;
  private t0 = 0;

  constructor(
    private readonly driver: Driver,
    private readonly jev: JevClient | undefined,
    opts: RunnerOptions = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.log = opts.log ?? (() => {});
    this.baseEnv = opts.env ?? process.env;
    this.cache = opts.cache;
  }

  /** Read the screen (reusing the last read if nothing happened since). */
  async snapshot(force = false): Promise<UiSnapshot> {
    if (!force && this.fresh && this.last) return this.last;
    this.last = await this.driver.snapshot();
    this.fresh = true;
    return this.last;
  }

  private invalidate() {
    this.fresh = false;
  }

  /** Start a flow and run until it ends or stops on a step that needs a decision. */
  async start(flow: Flow): Promise<RunResult> {
    this.flow = flow;
    this.env = { ...flow.env, ...this.baseEnv };
    this.queue = [...flow.steps];
    this.results = [];
    this.t0 = performance.now();
    await this.driver.markLogs();
    if (flow.fresh_start) await this.driver.stop(flow.app);
    return this.loop();
  }

  /**
   * Continue a stopped run. `pass`: accept the stopped step and go on; `retry`: run it again
   * (e.g. after fixing the app); `fail`: finish the run as failed.
   */
  async resume(decision: "pass" | "fail" | "retry"): Promise<RunResult> {
    if (!this.flow) throw new Error("nothing to resume");
    const lastResult = this.results.at(-1);
    if (decision === "fail") {
      this.queue = [];
      return this.finish();
    }
    if (decision === "pass") {
      if (lastResult) {
        lastResult.status = "passed";
        lastResult.decidedBy = "claude";
        lastResult.detail = `${lastResult.detail ? `${lastResult.detail}; ` : ""}accepted by Claude`;
      }
      this.queue.shift();
    } else if (lastResult) {
      this.results.pop();
    }
    this.invalidate();
    return this.loop();
  }

  private async loop(): Promise<RunResult> {
    while (this.queue.length > 0) {
      const step = this.queue[0]!;
      const result = await this.exec(step);
      this.results.push(result);
      this.log(`${result.status.padEnd(9)} ${result.step}${result.detail ? ` — ${result.detail}` : ""}`);
      if (result.status === "passed" || result.optional) {
        this.queue.shift();
        if (typeof step === "object" && "if_visible" in step && result.status === "passed") {
          const branch = result.detail === "visible" ? step.then : (step.else ?? []);
          this.queue.unshift(...branch);
        }
        continue;
      }
      // Stop here; the step stays at the head of the queue so resume() can pass/retry it.
      return this.finish();
    }
    return this.finish();
  }

  private async finish(): Promise<RunResult> {
    const flow = this.flow!;
    const crashes = await this.driver.crashLogs(flow.app).catch(() => []);
    const stopped = this.queue.length > 0 ? this.results.at(-1) : undefined;
    let status: RunStatus = stopped ? (stopped.status as RunStatus) : "passed";
    if (!stopped && this.results.some((r) => r.status !== "passed" && !r.optional)) status = "failed";
    if (crashes.length && status === "passed") status = "failed";

    const remaining = stopped ? this.queue.slice(1) : [];
    const skipped: StepResult[] = remaining.map((s, i) => ({
      index: this.results.length + i,
      step: describeStep(s),
      status: "skipped",
      decidedBy: "none",
      ms: 0,
    }));

    let failureScreen: string | undefined;
    if (status !== "passed") {
      const snap = this.last ?? (await this.snapshot(true).catch(() => undefined));
      failureScreen = snap ? describeSnapshot(snap, 80) : undefined;
    }
    this.cache?.save();
    return {
      flow: flow.name ?? flow.app,
      app: flow.app,
      device: this.driver.name,
      status,
      steps: [...this.results, ...skipped],
      resumable: Boolean(stopped),
      failureScreen,
      crashes,
      totalMs: Math.round(performance.now() - this.t0),
    };
  }

  private async exec(step: Step): Promise<StepResult> {
    const s0 = performance.now();
    const label = describeStep(step);
    const optional = typeof step === "object" && "optional" in step && step.optional === true;
    let out: Outcome;
    try {
      out = await this.runStep(step);
    } catch (err) {
      out = new Outcome("failed", "none", `error: ${(err as Error).message}`);
    }
    const result: StepResult = {
      index: this.results.length,
      step: label,
      status: out.status,
      decidedBy: out.decidedBy,
      ...(out.detail ? { detail: out.detail } : {}),
      ...out.extra,
      ...(optional && out.status !== "passed" ? { optional: true } : {}),
      ms: Math.round(performance.now() - s0),
    };
    if (this.config.trace || (result.status !== "passed" && !optional)) {
      result.shot = await this.driver.screenshot().catch(() => undefined);
    }
    return result;
  }

  private async runStep(step: Step): Promise<Outcome> {
    const flow = this.flow!;
    if (step === "launch") return this.launch(flow.app);
    if (step === "stop") {
      await this.driver.stop(flow.app);
      this.invalidate();
      return new Outcome("passed", "deterministic");
    }
    if (step === "back") {
      await this.driver.back();
      return this.afterAction();
    }
    if (step === "hide_keyboard") {
      await this.driver.hideKeyboard();
      return this.afterAction();
    }
    if ("launch" in step) return this.launch(step.launch);
    if ("allow_risky" in step) {
      this.allowRiskyNext = true;
      return new Outcome("passed", "deterministic", "next tap/type may be risky");
    }
    if ("wait" in step) {
      await sleep(step.wait);
      this.invalidate();
      return new Outcome("passed", "deterministic");
    }
    if ("key" in step) {
      await this.driver.pressKey(step.key);
      return this.afterAction();
    }
    if ("swipe" in step) {
      await this.swipe(step.swipe);
      return this.afterAction();
    }
    if ("see" in step) return this.see(step.see, true, step.timeout ?? this.config.assertTimeoutMs);
    if ("wait_for" in step) return this.see(step.wait_for, true, step.timeout ?? this.config.waitForTimeoutMs);
    if ("not_see" in step) return this.see(step.not_see, false, step.timeout ?? this.config.assertTimeoutMs);
    if ("expect" in step) return this.expect(step.expect, step.timeout ?? this.config.assertTimeoutMs);
    if ("if_visible" in step) {
      const snap = await this.snapshot();
      const visible = screenContains(snap, interpolate(step.if_visible, this.env));
      return new Outcome("passed", "deterministic", visible ? "visible" : "not visible");
    }
    if ("tap" in step) return this.act("tap", step.tap, undefined, step.scroll);
    if ("type" in step) return this.act("type", step.type.into, step.type, step.scroll);
    if ("run" in step) return new Outcome("failed", "none", "run: steps must be inlined when the flow is loaded");
    return new Outcome("failed", "none", "unknown step");
  }

  private async swipe(dir: "up" | "down" | "left" | "right") {
    const snap = this.last ?? (await this.snapshot());
    const { width: w, height: h } = snap.screen.width ? snap.screen : { width: 1080, height: 2000 };
    const v = {
      up: [w / 2, h * 0.72, w / 2, h * 0.3],
      down: [w / 2, h * 0.3, w / 2, h * 0.72],
      left: [w * 0.85, h / 2, w * 0.15, h / 2],
      right: [w * 0.15, h / 2, w * 0.85, h / 2],
    }[dir] as [number, number, number, number];
    await this.driver.swipe(...v);
    this.invalidate();
  }

  private async launch(app: string): Promise<Outcome> {
    await this.driver.launch(app);
    this.invalidate();
    const settled = await this.settle(undefined);
    const fg = await this.driver.foregroundApp();
    if (fg && fg !== app && !settled.packages.includes(app)) {
      return new Outcome("failed", "deterministic", `${app} is not in the foreground (saw ${fg})`);
    }
    return this.afterAction(true);
  }

  private requireJev(): JevClient {
    if (!this.jev) throw new Error("this step needs Jev but no Jev provider is configured");
    return this.jev;
  }

  /**
   * Resolve a target: exact selector/label → replay cache → Jev choice, scrolling to find it
   * if needed. Risk is checked in the same Jev call when possible.
   */
  private async act(kind: "tap" | "type", target: Target, typing?: { text: string; submit?: boolean }, scroll = true): Promise<Outcome> {
    const targetText = describeTarget(target);
    const key = SelectorCache.key(kind, targetText);
    const cached = this.cache?.get(key);
    let healed = false;
    let scrolls = 0;

    for (;;) {
      const snap = await this.snapshot();
      let element: UiElement | undefined;
      let decidedBy: DecidedBy = "deterministic";
      let confidence: number | undefined;

      if (typeof target === "string") {
        element = exactLabelMatch(snap, target, kind);
      } else {
        const hits = findBySelector(snap, target);
        if (hits.length === 1) element = hits[0];
      }
      if (!element && cached) {
        const hits = findBySelector(snap, cached.selector);
        if (hits.length === 1) {
          element = hits[0];
          decidedBy = "cache";
          this.cache?.hit(key);
        } else {
          healed = true;
        }
      }

      const knownSafe = cached?.risk !== undefined && cached.risk < this.config.riskBlock && decidedBy === "cache";
      const askRisk = this.config.riskGuard && !this.allowRiskyNext && !knownSafe && Boolean(this.jev);
      // Exact selectors fall back to Jev only when it is configured; plain text targets always need it.
      const askPick = !element && (typeof target === "string" || (Boolean(this.jev) && Boolean(target.text || target.desc)));
      let risk: number | undefined = knownSafe ? cached?.risk : undefined;

      if (askPick || askRisk) {
        const plan = beforeActionRequest(snap, targetText, kind, {
          askPick,
          askRisk,
          actionText: `${kind} ${targetText}`,
        });
        const res = await this.requireJev().ask(plan.request);
        if (askRisk) risk = noul(res.answers.risk);
        if (askPick) {
          const ans = res.answers.pick;
          if (ans?.type !== "choice") throw new Error("Jev returned no element choice");
          if (ans.choice !== NONE_OPTION && ans.confidence >= this.config.minPickConfidence) {
            element = candidatesFor(snap, kind).find((el) => optionKey(el) === ans.choice);
            decidedBy = "jev";
            confidence = ans.confidence;
          } else if (ans.choice !== NONE_OPTION) {
            return new Outcome(
              "uncertain",
              "jev",
              `low confidence picking "${targetText}" — top options: ${topOptions(ans.probabilities, snap)}`,
              { confidence: ans.confidence },
            );
          }
        }
      }

      if (!element) {
        const canScroll = scroll && scrolls < this.config.maxScrolls && snap.elements.some((e) => e.scrollable);
        if (canScroll) {
          const before = snap.hash;
          await this.swipe("up");
          await sleep(this.config.settleMs);
          const after = await this.snapshot(true);
          scrolls += 1;
          if (after.hash !== before) continue;
        }
        return new Outcome("failed", askPick ? "jev" : "deterministic", `no element matches "${targetText}"`, {
          ...(scrolls ? { scrolls } : {}),
        });
      }

      if (risk !== undefined && risk >= this.config.riskBlock) {
        return new Outcome(
          "blocked",
          "jev",
          `"${kind} ${targetText}" looks risky (p=${risk.toFixed(2)}); ask the user, then add \`- allow_risky: true\` before it`,
          { probability: risk, element: labelOf(element) },
        );
      }
      this.allowRiskyNext = false;

      if (this.cache && decidedBy !== "cache") {
        const selector = typeof target === "object" ? target : uniqueSelector(snap, element);
        if (selector) {
          this.cache.set(key, {
            selector,
            label: labelOf(element),
            fingerprint: snap.fingerprint,
            ...(risk !== undefined ? { risk } : {}),
          });
        }
      }

      const { x, y } = center(element.bounds);
      await this.driver.tap(x, y);
      this.invalidate();
      if (kind === "type" && typing) {
        const text = interpolate(typing.text, this.env);
        if (!this.driver.unicodeInput && /[^\x20-\x7e]/.test(text)) {
          return new Outcome(
            "failed",
            "none",
            `this driver can't type non-ASCII text (${this.driver.name}); run \`jevclaude setup android\``,
          );
        }
        await sleep(200);
        await this.driver.typeText(text);
        if (typing.submit) await this.driver.pressKey("enter");
      }
      const after = await this.afterAction();
      return new Outcome(after.status, after.status === "passed" ? decidedBy : after.decidedBy, after.detail, {
        element: labelOf(element),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(healed && decidedBy === "jev" ? { healed: true } : {}),
        ...(scrolls ? { scrolls } : {}),
        ...after.extra,
      });
    }
  }

  /**
   * Wait for the screen to settle after an action. Fast drivers double-check stability; slow
   * ones (uiautomator dump) re-read only while the screen hasn't changed yet or is loading.
   */
  private async settle(prevHash: string | undefined): Promise<UiSnapshot> {
    await sleep(this.config.settleMs);
    const deadline = performance.now() + this.config.settleMaxMs;
    const loadingDeadline = performance.now() + this.config.loadingTimeoutMs;
    let snap = await this.snapshot(true);
    let rereads = 0;
    for (;;) {
      if (isLoading(snap) && performance.now() < loadingDeadline) {
        await sleep(300);
        snap = await this.snapshot(true);
        continue;
      }
      if (performance.now() > deadline) return snap;
      if (this.driver.fastSnapshot) {
        // Cheap reads: require two identical reads in a row.
        await sleep(150);
        const next = await this.snapshot(true);
        if (next.hash === snap.hash) return next;
        snap = next;
        continue;
      }
      // Slow reads: only re-read (a couple of times) while the screen hasn't changed yet.
      if (snap.hash !== prevHash || rereads >= 2) return snap;
      await sleep(400);
      snap = await this.snapshot(true);
      rereads += 1;
    }
  }

  /** After any action: settle, handle permission dialogs, check crashes and (optionally) visible errors. */
  private async afterAction(skipSettle = false): Promise<Outcome> {
    const prev = this.last?.hash;
    let snap = skipSettle && this.fresh && this.last ? this.last : await this.settle(prev);

    const dialog = await this.handlePermissionDialog(snap);
    if (dialog) {
      if (dialog.status !== "passed") return dialog;
      snap = await this.settle(snap.hash);
    }

    const crashes = await this.driver.crashLogs(this.flow!.app).catch(() => []);
    if (crashes.length) return new Outcome("failed", "deterministic", `crash: ${crashes[0]!.split("\n")[0]}`);
    if (!this.config.checkErrorsEveryStep || !this.jev) return new Outcome("passed", "deterministic");
    const res = await this.jev.ask(afterActionRequest(snap, { checkErrors: true }));
    const p = noul(res.answers.error);
    if (p >= this.config.pass) return new Outcome("failed", "jev", `error visible on screen (p=${p.toFixed(2)})`, { probability: p });
    return new Outcome("passed", "jev", undefined, { probability: 1 - p });
  }

  /** Detect a system permission dialog and apply the flow's policy. Returns undefined when none is shown. */
  private async handlePermissionDialog(snap: UiSnapshot): Promise<Outcome | undefined> {
    const android = snap.packages.some((p) => /permissioncontroller/.test(p));
    const ios =
      snap.elements.some((e) => e.cls === "Alert") && snap.elements.some((e) => e.clickable && PERMISSION_ALLOW.test(e.text || e.desc));
    if (!android && !ios) return undefined;
    const policy = this.flow!.permissions ?? "stop";
    if (policy === "stop") {
      return new Outcome(
        "blocked",
        "deterministic",
        "a system permission dialog is showing; set `permissions: allow` or `deny` in the flow",
      );
    }
    const re = policy === "allow" ? PERMISSION_ALLOW : PERMISSION_DENY;
    let button = snap.elements.find((e) => e.clickable && re.test(e.text || e.desc || e.childText));
    let decidedBy: DecidedBy = "deterministic";
    if (!button && this.jev) {
      const res = await this.jev.ask(permissionButtonQuestion(snap, policy));
      const ans = res.answers.button;
      if (ans?.type === "choice" && ans.choice !== NONE_OPTION && ans.confidence >= this.config.minPickConfidence) {
        button = snap.elements.find((e) => optionKey(e) === ans.choice);
        decidedBy = "jev";
      }
    }
    if (!button) return new Outcome("uncertain", decidedBy, `permission dialog: could not find the "${policy}" button`);
    const { x, y } = center(button.bounds);
    await this.driver.tap(x, y);
    this.invalidate();
    this.log(`permission dialog → ${policy} (${labelOf(button)})`);
    return new Outcome("passed", decidedBy);
  }

  /** Deterministic text presence check, re-polled until the timeout. */
  private async see(text: string, shouldSee: boolean, timeoutMs: number): Promise<Outcome> {
    const needle = interpolate(text, this.env);
    const deadline = performance.now() + timeoutMs;
    for (let first = true; ; first = false) {
      const snap = await this.snapshot(!first);
      if (screenContains(snap, needle) === shouldSee) return new Outcome("passed", "deterministic");
      if (performance.now() > deadline) {
        return new Outcome("failed", "deterministic", shouldSee ? `"${text}" not on screen` : `"${text}" is still on screen`);
      }
      await sleep(this.driver.fastSnapshot ? 250 : 500);
    }
  }

  /** Fuzzy expectation judged by Jev; re-asked only when the screen changes, until the timeout. */
  private async expect(expectation: string, timeoutMs: number): Promise<Outcome> {
    const jev = this.requireJev();
    const deadline = performance.now() + timeoutMs;
    let lastHash = "";
    let last: Outcome | undefined;
    for (let first = true; ; first = false) {
      const snap = await this.snapshot(!first);
      if (snap.hash !== lastHash) {
        lastHash = snap.hash;
        const res = await jev.ask(afterActionRequest(snap, { expectation: interpolate(expectation, this.env), checkErrors: true }));
        const p = noul(res.answers.expect);
        const err = noul(res.answers.error);
        if (p >= this.config.pass) return new Outcome("passed", "jev", undefined, { probability: p });
        const detail = `p=${p.toFixed(2)}${err >= this.config.pass ? `, error visible (p=${err.toFixed(2)})` : ""}`;
        last = new Outcome(p <= this.config.fail ? "failed" : "uncertain", "jev", detail, { probability: p });
      }
      if (performance.now() > deadline) return last!;
      await sleep(this.driver.fastSnapshot ? 400 : 700);
    }
  }
}

const PERMISSION_ALLOW =
  /^(allow|while using|only this time|allow (once|while using)|ok|izin ver|uygulamayı kullanırken|yalnızca bu sefer|sadece bu kez|tamam)/i;
const PERMISSION_DENY = /^(deny|don.?t allow|do not allow|reddet|izin verme|izin vermeyin)/i;

function noul(a: JevAnswer | undefined): number {
  if (a?.type !== "noul") throw new Error("Jev returned no yes/no answer");
  return a.noul;
}

function topOptions(probs: Record<string, number>, snap: UiSnapshot): string {
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, p]) => {
      const el = snap.elements.find((e) => optionKey(e) === k);
      return `${el ? JSON.stringify(labelOf(el)) : k} ${p.toFixed(2)}`;
    })
    .join(", ");
}
