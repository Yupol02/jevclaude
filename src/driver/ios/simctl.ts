import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

export async function simctl(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await exec("xcrun", ["simctl", ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function listSimulators(): Promise<SimDevice[]> {
  const out = JSON.parse(await simctl(["list", "devices", "available", "-j"])) as {
    devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
  };
  return Object.entries(out.devices).flatMap(([runtime, ds]) =>
    ds.map((d) => ({ ...d, runtime: runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "") })),
  );
}

export async function bootedSimulators(): Promise<SimDevice[]> {
  return (await listSimulators().catch(() => [])).filter((d) => d.state === "Booted");
}

export function startVideo(udid: string, path: string): ChildProcess {
  return spawn("xcrun", ["simctl", "io", udid, "recordVideo", "--force", path], { stdio: "ignore" });
}

/** Crash reports (.ips) for `app` written after `since` (simulator crashes land in the host's DiagnosticReports). */
export async function crashReportsSince(app: string, since: number): Promise<string[]> {
  const dir = join(homedir(), "Library/Logs/DiagnosticReports");
  const names = await readdir(dir).catch(() => [] as string[]);
  const short = app.split(".").pop()!.toLowerCase();
  const hits: string[] = [];
  for (const n of names) {
    if (!n.endsWith(".ips") || !n.toLowerCase().includes(short)) continue;
    const s = await stat(join(dir, n)).catch(() => undefined);
    if (s && s.mtimeMs >= since) hits.push(`crash report: ${join(dir, n)}`);
  }
  return hits;
}
