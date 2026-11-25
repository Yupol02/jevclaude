import type { RunResult } from "../engine/runner.js";

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** JUnit XML: one testsuite per flow, one testcase per step. */
export function toJUnit(runs: RunResult[]): string {
  const suites = runs.map((r) => {
    const failures = r.steps.filter((s) => (s.status === "failed" || s.status === "blocked") && !s.optional).length;
    const errors = r.steps.filter((s) => s.status === "uncertain").length;
    const skipped = r.steps.filter((s) => s.status === "skipped").length;
    const cases = r.steps.map((s) => {
      const name = `${String(s.index + 1).padStart(2, "0")} ${s.step}`;
      const open = `    <testcase classname="${esc(r.flow)}" name="${esc(name)}" time="${(s.ms / 1000).toFixed(3)}"`;
      const detail = esc(s.detail ?? s.status);
      if (s.status === "skipped") return `${open}><skipped/></testcase>`;
      if (s.status === "uncertain") return `${open}><error message="${detail}" type="uncertain"/></testcase>`;
      if ((s.status === "failed" || s.status === "blocked") && !s.optional) {
        return `${open}><failure message="${detail}" type="${s.status}"/></testcase>`;
      }
      return `${open}/>`;
    });
    const sysout = r.crashes.length ? `\n    <system-out>${esc(r.crashes.join("\n\n"))}</system-out>` : "";
    return `  <testsuite name="${esc(r.flow)}" tests="${r.steps.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${(r.totalMs / 1000).toFixed(3)}">\n${cases.join("\n")}${sysout}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join("\n")}\n</testsuites>\n`;
}
