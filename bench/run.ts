/**
 * Benchmark: the same scenario run (a) by jevclaude and (b) optionally by plain Claude Code driving adb.
 *
 *   npx tsx bench/run.ts [--runs 3] [--baseline]
 *
 * Writes bench/results/<timestamp>.json and prints a markdown table for the README.
 * Numbers are only what was measured on your device — never copy them without running.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { loadFlowFile } from "../src/engine/flow.js";
import { loadDotEnv, runFlow } from "../src/session.js";

const exec = promisify(execFile);

interface Scenario {
  name: string;
  flow: string;
  baselinePrompt: string;
}

interface Row {
  scenario: string;
  method: string;
  run: number;
  status: string;
  seconds: number;
  /** jevclaude: Jev input tokens. baseline: Claude input+output tokens (incl. cache). */
  tokens: number;
  costUsd?: number;
}

async function baseline(prompt: string): Promise<Omit<Row, "scenario" | "method" | "run">> {
  const t0 = performance.now();
  const { stdout } = await exec("claude", ["-p", prompt, "--output-format", "json", "--allowedTools", "Bash(adb:*)"], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
  const out = JSON.parse(stdout) as {
    result?: string;
    total_cost_usd?: number;
    usage?: Record<string, number>;
  };
  const u = out.usage ?? {};
  const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return {
    status: /PASSED/i.test(out.result ?? "") ? "passed" : "failed",
    seconds: (performance.now() - t0) / 1000,
    tokens,
    costUsd: out.total_cost_usd,
  };
}

async function main() {
  loadDotEnv();
  const args = process.argv.slice(2);
  const runs = Number(args[args.indexOf("--runs") + 1]) || 3;
  const withBaseline = args.includes("--baseline");
  const scenarios = JSON.parse(await readFile("bench/scenarios.json", "utf8")) as Scenario[];
  const rows: Row[] = [];

  for (const sc of scenarios) {
    for (let run = 1; run <= runs; run++) {
      const t0 = performance.now();
      const { result, usage } = await runFlow(loadFlowFile(sc.flow), {
        reportsDir: "bench/results/reports",
        cache: run === 1 ? "update" : "on",
      });
      rows.push({
        scenario: sc.name,
        method: run === 1 ? "jevclaude (cold cache)" : "jevclaude (warm cache)",
        run,
        status: result.status,
        seconds: (performance.now() - t0) / 1000,
        tokens: usage?.inputTokens ?? 0,
      });
      console.error(`jevclaude ${sc.name} #${run}: ${result.status}`);
      if (withBaseline) {
        rows.push({ scenario: sc.name, method: "claude-code+adb", run, ...(await baseline(sc.baselinePrompt)) });
        console.error(`baseline ${sc.name} #${run}: done`);
      }
    }
  }

  await mkdir("bench/results", { recursive: true });
  const file = `bench/results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(file, JSON.stringify(rows, null, 2));

  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(`${r.scenario}|${r.method}`, [...(groups.get(`${r.scenario}|${r.method}`) ?? []), r]);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  console.log("| scenario | method | pass rate | median time | median tokens | median cost |");
  console.log("|---|---|---|---|---|---|");
  for (const [key, rs] of groups) {
    const [scenario, method] = key.split("|");
    const pass = rs.filter((r) => r.status === "passed").length;
    const costs = rs.map((r) => r.costUsd).filter((c): c is number => c !== undefined);
    console.log(
      `| ${scenario} | ${method} | ${pass}/${rs.length} | ${median(rs.map((r) => r.seconds)).toFixed(1)}s | ${median(rs.map((r) => r.tokens))} | ${costs.length ? `$${median(costs).toFixed(4)}` : "—"} |`,
    );
  }
  console.error(`raw results: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
