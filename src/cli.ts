#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { listDevices } from "./driver/select.js";
import type { Platform } from "./driver/types.js";
import { type Flow, loadFlowFile, parseFlow } from "./engine/flow.js";
import type { RunResult } from "./engine/runner.js";
import { exportMaestro, importMaestro } from "./maestro/convert.js";
import type { Usage } from "./report/text.js";
import { loadDotEnv, runFlow, snapshotText, writeCombinedHtml, writeJUnit } from "./session.js";
import { doctor, init, setupAndroid, setupIos } from "./setup.js";

const VERSION = "0.2.5";

const HELP = `jevclaude ${VERSION} — mobile app testing: Claude plans, Jev decides, the device runner executes.

Usage:
  jevclaude run <flow.yaml|dir>... [options]   Run flows (directories: every *.yaml inside)
  jevclaude snapshot [--platform P] [--device ID]   Print the current screen as compact text
  jevclaude devices                            List Android devices and booted iOS simulators
  jevclaude doctor                             Check tools, devices, device servers and the Jev key
  jevclaude init                               Create jevclaude.config.yaml, flows/ and .env
  jevclaude setup android|ios [--device ID]    Install UiAutomator2 server / WebDriverAgent
  jevclaude import-maestro <in.yaml> [-o out]  Convert a Maestro flow to a jevclaude flow
  jevclaude export-maestro <in.yaml> [-o out]  Convert a jevclaude flow to Maestro YAML
  jevclaude mcp                                Start the MCP server (stdio) for Claude Code

Run options:
  --platform android|ios   --device ID     --devices ID1,ID2 (same flows on each, in parallel)
  --tag NAME               only flows tagged NAME
  --trace                  screenshot after every step     --record   record a video
  --junit FILE             JUnit XML for CI                --html FILE  combined HTML report
  --no-cache               ignore the replay cache         --update-cache  re-resolve and overwrite it
  --no-risk-guard          don't ask Jev about risky taps  --no-error-check  skip per-step error checks
  --backend auto|uia2|adb  Android screen backend

Env: TYPESAFE_API_KEY, or CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (see .env.example)`;

function collectFlowFiles(paths: string[]): string[] {
  return paths.flatMap((p) =>
    statSync(p).isDirectory()
      ? readdirSync(p)
          .filter((f) => /\.ya?ml$/.test(f))
          .sort()
          .map((f) => join(p, f))
      : [p],
  );
}

async function cmdRun(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      platform: { type: "string" },
      device: { type: "string" },
      devices: { type: "string" },
      tag: { type: "string" },
      trace: { type: "boolean" },
      record: { type: "boolean" },
      junit: { type: "string" },
      html: { type: "string" },
      "no-cache": { type: "boolean" },
      "update-cache": { type: "boolean" },
      "no-risk-guard": { type: "boolean" },
      "no-error-check": { type: "boolean" },
      backend: { type: "string" },
    },
  });
  if (positionals.length === 0) throw new Error("run needs at least one flow file or directory");
  let flows = collectFlowFiles(positionals).map((f) => ({ file: f, flow: loadFlowFile(f) }));
  if (values.tag) flows = flows.filter(({ flow }) => flow.tags?.includes(values.tag!));
  if (flows.length === 0) throw new Error("no flows matched");

  const devices = values.devices ? values.devices.split(",").map((d) => d.trim()) : [values.device];
  const common = {
    platform: values.platform as Platform | undefined,
    androidBackend: values.backend as "auto" | "uia2" | "adb" | undefined,
    cache: values["no-cache"] ? ("off" as const) : values["update-cache"] ? ("update" as const) : undefined,
    record: values.record,
    config: {
      ...(values.trace ? { trace: true } : {}),
      ...(values["no-risk-guard"] ? { riskGuard: false } : {}),
      ...(values["no-error-check"] ? { checkErrorsEveryStep: false } : {}),
    },
  };

  const runs: Array<{ result: RunResult; usage?: Usage }> = [];
  // Flows run one after another per device; devices run in parallel.
  await Promise.all(
    devices.map(async (device) => {
      const tag = devices.length > 1 ? `[${device}] ` : "";
      for (const { file, flow } of flows) {
        console.error(`\n${tag}▶ ${flow.name ?? file}`);
        try {
          const out = await runFlow(flow, { ...common, device, log: (m) => console.error(`  ${tag}${m}`) });
          console.log(`\n${out.text}`);
          runs.push({ result: out.result, usage: out.usage });
        } catch (e) {
          console.error(`${tag}error in ${file}: ${(e as Error).message}`);
          runs.push({
            result: {
              flow: flow.name ?? file,
              app: flow.app,
              device: device ?? "?",
              status: "failed",
              steps: [{ index: 0, step: "setup", status: "failed", decidedBy: "none", detail: (e as Error).message, ms: 0 }],
              resumable: false,
              crashes: [],
              totalMs: 0,
            },
          });
        }
      }
    }),
  );
  if (values.html) {
    await writeCombinedHtml(values.html, runs);
    console.error(`HTML: ${values.html}`);
  }
  if (values.junit) {
    await writeJUnit(
      values.junit,
      runs.map((r) => r.result),
    );
    console.error(`JUnit: ${values.junit}`);
  }
  const passed = runs.filter((r) => r.result.status === "passed").length;
  console.error(`\n${passed}/${runs.length} flow run(s) passed`);
  return passed === runs.length ? 0 : 1;
}

function convertCmd(argv: string[], dir: "import" | "export"): number {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { o: { type: "string", short: "o" } } });
  const input = positionals[0];
  if (!input) throw new Error(`${dir}-maestro needs an input file`);
  const src = readFileSync(input, "utf8");
  let out: string;
  let warnings: string[];
  if (dir === "import") {
    const r = importMaestro(src);
    parseFlow(r.value); // validate
    out = YAML.stringify(r.value);
    warnings = r.warnings;
  } else {
    const r = exportMaestro(parseFlow(src) as Flow);
    out = r.value;
    warnings = r.warnings;
  }
  for (const w of warnings) console.error(`warning: ${w}`);
  if (values.o) {
    writeFileSync(values.o, out);
    console.error(`wrote ${values.o}`);
  } else {
    process.stdout.write(out);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  loadDotEnv();
  const [cmd, ...args] = argv;
  const log = (m: string) => console.error(m);
  switch (cmd) {
    case "run":
      return cmdRun(args);
    case "devices": {
      const list = await listDevices();
      console.log(list.length ? list.map((d) => `${d.platform}\t${d.id}\t${d.label}`).join("\n") : "no devices");
      return 0;
    }
    case "snapshot": {
      const { values } = parseArgs({ args, options: { platform: { type: "string" }, device: { type: "string" } } });
      console.log(await snapshotText({ platform: values.platform as Platform | undefined, device: values.device }));
      return 0;
    }
    case "doctor": {
      const { ok, lines } = await doctor();
      console.log(lines.join("\n"));
      return ok ? 0 : 1;
    }
    case "init":
      await init(log);
      return 0;
    case "setup": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { device: { type: "string" } } });
      if (positionals[0] === "android") await setupAndroid(values.device, log);
      else if (positionals[0] === "ios") await setupIos(values.device, log);
      else throw new Error("usage: jevclaude setup android|ios");
      return 0;
    }
    case "import-maestro":
      return convertCmd(args, "import");
    case "export-maestro":
      return convertCmd(args, "export");
    case "mcp": {
      const { startMcpServer } = await import("./mcp/server.js");
      await startMcpServer();
      return -1; // keep running
    }
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    default:
      console.log(HELP);
      return cmd && cmd !== "help" && cmd !== "--help" ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: Error) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  },
);
