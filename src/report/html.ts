import type { RunResult, StepResult } from "../engine/runner.js";
import { JEV_INPUT_USD_PER_MTOK, type Usage } from "./text.js";

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

const STATUS_LABEL: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  uncertain: "Uncertain",
  blocked: "Blocked",
  skipped: "Skipped",
  running: "Running",
};

function stepRow(s: StepResult): string {
  const badges = [
    s.status !== "skipped" && s.decidedBy !== "none" ? `<span class="badge layer-${s.decidedBy}">${s.decidedBy}</span>` : "",
    s.healed ? `<span class="badge healed">healed</span>` : "",
    s.optional ? `<span class="badge">optional</span>` : "",
  ].join("");
  const nums = [
    s.probability !== undefined ? `p ${s.probability.toFixed(2)}` : "",
    s.confidence !== undefined ? `conf ${s.confidence.toFixed(2)}` : "",
    s.scrolls ? `${s.scrolls} scroll${s.scrolls > 1 ? "s" : ""}` : "",
    s.status !== "skipped" ? `${(s.ms / 1000).toFixed(2)} s` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const shot = s.shot
    ? `<details class="shot"><summary>screenshot</summary><img loading="lazy" alt="Screen after step ${s.index + 1}" src="data:image/png;base64,${s.shot.toString("base64")}"></details>`
    : "";
  return `<li class="step ${s.status}">
  <span class="dot" aria-hidden="true"></span>
  <div class="body">
    <div class="line"><span class="num">${s.index + 1}</span><span class="name">${esc(s.step)}</span>${badges}<span class="sr">${STATUS_LABEL[s.status]}</span></div>
    ${s.element ? `<div class="meta">element: <code>${esc(s.element)}</code></div>` : ""}
    ${s.detail ? `<div class="detail">${esc(s.detail)}</div>` : ""}
    ${nums ? `<div class="meta">${nums}</div>` : ""}
    ${shot}
  </div>
</li>`;
}

/** Self-contained HTML report (screenshots inlined) for one or more runs. */
export function toHtml(runs: Array<{ result: RunResult; usage?: Usage }>, title = "jevclaude report"): string {
  const sections = runs.map(({ result: r, usage }) => {
    const counts = (st: string) => r.steps.filter((s) => s.status === st).length;
    const cache = r.steps.filter((s) => s.decidedBy === "cache").length;
    const cost = usage ? (usage.inputTokens / 1e6) * JEV_INPUT_USD_PER_MTOK : 0;
    const stats = [
      ["Status", `<span class="pill ${r.status}">${STATUS_LABEL[r.status]}</span>`],
      ["Duration", `${(r.totalMs / 1000).toFixed(1)} s`],
      [
        "Steps",
        `${counts("passed")} passed · ${counts("failed") + counts("blocked") + counts("uncertain")} stopped · ${counts("skipped")} skipped`,
      ],
      ["Jev", usage ? `${usage.calls} calls · ${usage.inputTokens.toLocaleString("en")} tokens · $${cost.toFixed(5)}` : "not used"],
      ["Replay cache", `${cache} step${cache === 1 ? "" : "s"} without a model call`],
      ["Device", esc(r.device)],
    ]
      .map(([k, v]) => `<div class="stat"><dt>${k}</dt><dd>${v}</dd></div>`)
      .join("");
    const extra = [
      r.crashes.length ? `<h3>Crashes</h3><pre>${esc(r.crashes.join("\n\n"))}</pre>` : "",
      r.failureScreen ? `<details><summary>Screen at stop (what Jev saw)</summary><pre>${esc(r.failureScreen)}</pre></details>` : "",
    ].join("");
    return `<section class="run">
  <h2>${esc(r.flow)} <small>${esc(r.app)}</small></h2>
  <dl class="stats">${stats}</dl>
  <ol class="steps">${r.steps.map(stepRow).join("\n")}</ol>
  ${extra}
</section>`;
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e4e3df;--pass:#1f8a4c;--fail:#c4372c;--warn:#b7791f;--block:#7c3aed;--skip:#9a9a94;--code:#f0efeb}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--text:#ecebe6;--muted:#a3a29b;--line:#33332f;--pass:#46c07a;--fail:#ef6a5e;--warn:#e0a84a;--block:#a78bfa;--skip:#76756f;--code:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 16px 64px}h1{font-size:22px;margin:0 0 4px}header p{color:var(--muted);margin:0 0 24px}
.run{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:24px}
h2{font-size:18px;margin:0 0 12px}h2 small{color:var(--muted);font-weight:400;font-size:13px;margin-left:6px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px 16px;margin:0 0 16px}.stat dt{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.stat dd{margin:0}
.pill{display:inline-block;padding:1px 10px;border-radius:999px;font-weight:600;font-size:13px;color:#fff}.pill.passed{background:var(--pass)}.pill.failed{background:var(--fail)}.pill.uncertain{background:var(--warn)}.pill.blocked{background:var(--block)}
.steps{list-style:none;margin:0;padding:0}.step{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.dot{flex:none;width:10px;height:10px;border-radius:50%;margin-top:7px;background:var(--skip)}.passed .dot{background:var(--pass)}.failed .dot{background:var(--fail)}.uncertain .dot{background:var(--warn)}.blocked .dot{background:var(--block)}
.skipped{color:var(--muted)}.body{min-width:0;flex:1}.line{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}.num{color:var(--muted);font-variant-numeric:tabular-nums;min-width:1.6em}.name{font-weight:500;overflow-wrap:anywhere}
.badge{font-size:11px;padding:0 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}.layer-jev{border-color:var(--warn);color:var(--warn)}.layer-cache{border-color:var(--pass);color:var(--pass)}.layer-claude{border-color:var(--block);color:var(--block)}.healed{border-color:var(--block);color:var(--block)}
.detail{color:var(--fail)}.passed .detail{color:var(--muted)}.meta{color:var(--muted);font-size:13px}code,pre{background:var(--code);border-radius:6px;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}code{padding:0 4px}pre{padding:12px;overflow:auto;white-space:pre-wrap}
.shot summary,details summary{cursor:pointer;color:var(--muted);font-size:13px}.shot img{display:block;max-width:min(320px,100%);margin-top:8px;border-radius:8px;border:1px solid var(--line)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
</style>
</head>
<body>
<main>
<header><h1>${esc(title)}</h1><p>Generated ${esc(new Date().toISOString().replace("T", " ").slice(0, 19))} UTC · decisions: deterministic → cache → Jev → Claude</p></header>
${sections.join("\n")}
</main>
</body>
</html>
`;
}
