import type { RunResult } from "../engine/runner.js";

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalMs: number;
  models: string[];
}

/** USD per 1M Jev input tokens (output is free). Used only for the cost estimate in reports. */
export const JEV_INPUT_USD_PER_MTOK = 0.042;

const ICON: Record<string, string> = { passed: "✓", failed: "✗", uncertain: "?", blocked: "⛔", skipped: "·" };

export interface ReportExtras {
  runId?: string;
  dir?: string;
  html?: string;
  screenshot?: string;
  video?: string;
}

/** Short text report meant to be read by Claude: only what it needs to decide the next move. */
export function formatReport(r: RunResult, usage?: Usage, extras: ReportExtras = {}): string {
  const lines: string[] = [];
  lines.push(`${r.status.toUpperCase()} — ${r.flow} on ${r.device} (${(r.totalMs / 1000).toFixed(1)}s)`);
  for (const s of r.steps) {
    const meta = [
      s.decidedBy !== "none" && s.status !== "skipped" ? s.decidedBy : "",
      s.healed ? "healed" : "",
      s.element ? `el=${JSON.stringify(s.element)}` : "",
      s.probability !== undefined ? `p=${s.probability.toFixed(2)}` : "",
      s.confidence !== undefined ? `conf=${s.confidence.toFixed(2)}` : "",
      s.scrolls ? `scrolled ${s.scrolls}×` : "",
      s.optional ? "optional" : "",
    ].filter(Boolean);
    lines.push(
      `${ICON[s.status]} ${s.index + 1}. ${s.step}${meta.length ? ` [${meta.join(" ")}]` : ""}${s.detail ? ` — ${s.detail}` : ""}`,
    );
  }
  if (r.crashes.length) lines.push("", "Crashes:", ...r.crashes.slice(0, 3).map((c) => c.slice(0, 600)));
  if (r.failureScreen) lines.push("", "Screen at stop:", r.failureScreen);
  if (usage) {
    const cost = (usage.inputTokens / 1e6) * JEV_INPUT_USD_PER_MTOK;
    lines.push(
      "",
      `Jev: ${usage.calls} calls, ${usage.inputTokens} input tokens (~$${cost.toFixed(5)}), ${(usage.totalMs / 1000).toFixed(1)}s${usage.models.length ? `, ${usage.models.join("/")}` : ""}`,
    );
  }
  const cacheHits = r.steps.filter((s) => s.decidedBy === "cache").length;
  if (cacheHits) lines.push(`Replay cache: ${cacheHits} step(s) resolved without a model call`);
  if (extras.screenshot) lines.push(`Screenshot: ${extras.screenshot}`);
  if (extras.video) lines.push(`Video: ${extras.video}`);
  if (extras.html) lines.push(`HTML report: ${extras.html}`);
  if (r.resumable && extras.runId) {
    lines.push("", `Run ${extras.runId} is paused at step ${r.steps.findLast((s) => s.status !== "skipped")!.index + 1}.`);
    if (r.status === "uncertain") {
      lines.push("Next: Jev was not sure. Judge the screen above, then call resume_flow with pass, retry or fail.");
    } else if (r.status === "blocked") {
      lines.push(
        "Next: a step was blocked (risky action or permission dialog). Ask the user before allowing it; resume_flow pass only with their OK.",
      );
    } else {
      lines.push("Next: diagnose the failure. After fixing the app call resume_flow retry, or resume_flow fail to end the run.");
    }
  }
  return lines.join("\n");
}
