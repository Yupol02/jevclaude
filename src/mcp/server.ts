import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listDevices } from "../driver/select.js";
import { parseFlow } from "../engine/flow.js";
import { loadDotEnv, RunSession, snapshotText } from "../session.js";

const FLOW_FORMAT = `Flow format (YAML):
app: com.example.app          # Android package or iOS bundle id
platform: android             # optional: android | ios (needed only if both kinds of device are connected)
name: login happy path        # optional
fresh_start: true             # optional: stop the app before running
permissions: stop             # optional: allow | deny | stop when a system permission dialog appears
env: { USER_NAME: "Test" }    # optional: values for \${VAR} (environment wins)
steps:
  - launch
  - open: "https://example.com/page"   # URL or deep link (a new tab in Chrome)
  - tap: "Log in button"      # natural language → replay cache, else Jev picks; scrolls to find it
  - tap: { id: btn_login }    # exact selector (id / text / desc) → no model call
  - type: { into: "email field", text: "\${TEST_EMAIL}", submit: false }   # Unicode OK on uia2/iOS
  - swipe: up | down | left | right
  - back | hide_keyboard | stop
  - key: enter                # enter, back, home, tab, delete, search
  - wait: 1000
  - wait_for: "Welcome"       # deterministic, waits up to 10 s
  - see: "Welcome"            # deterministic: text present
  - not_see: "Error"
  - expect: "Home screen with the user's name at the top"   # Jev judges the screen
  - if_visible: "Rate this app"
    then: [ { tap: { text: "Not now" } } ]
  - run: flows/login.yaml     # inline another flow's steps
  - allow_risky: true         # ONLY after the user approved the next risky tap/type
Chrome pages are read through Chrome DevTools: page content appears as Web.<tag> elements (ids prefixed web:), so see/tap/type/expect work on web pages.
Per-step modifiers: optional: true (failure doesn't stop the flow), timeout: <ms>.
Prefer exact selectors and see:/wait_for: when you know the text — they cost nothing.
Jev is weak at counting/arithmetic: check numbers with see: instead of expect:.`;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ ...text(`error: ${(e as Error).message}`), isError: true });

/** Paused runs, so Claude can decide an uncertain/blocked step and continue without relaunching. */
const sessions = new Map<string, { session: RunSession; touched: number }>();
const SESSION_TTL_MS = 30 * 60_000;

function gc() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.touched > SESSION_TTL_MS) {
      sessions.delete(id);
      void s.session.close();
    }
  }
}

export async function startMcpServer(): Promise<void> {
  loadDotEnv();
  const server = new McpServer({ name: "jevclaude", version: "0.4.1" });

  server.registerTool("list_devices", { description: "List Android devices (adb) and booted iOS simulators." }, async () => {
    try {
      const list = await listDevices();
      return text(list.length ? list.map((d) => `${d.platform} ${d.id} ${d.label}`).join("\n") : "no devices");
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool(
    "snapshot",
    {
      description:
        "Return the current screen as a compact, indexed list of UI elements (text, ids, flags). Much cheaper than a screenshot. Use it to learn a screen before writing a flow.",
      inputSchema: {
        platform: z.enum(["android", "ios"]).optional(),
        device: z.string().optional().describe("adb serial or simulator UDID; omit when one device is available"),
      },
    },
    async ({ platform, device }) => {
      try {
        return text(await snapshotText({ platform, device }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "run_flow",
    {
      description: `Run a whole test flow on the device in one call. A local runner executes every step; exact selectors and the replay cache need no model; TypeSafe Jev makes the remaining per-step decisions (which element, did it pass, is an error shown, is the action risky). You get a short report back. If it stops on a failed/uncertain/blocked step, the run stays paused: decide and call resume_flow.\n\n${FLOW_FORMAT}`,
      inputSchema: {
        flow: z.string().optional().describe("Flow as YAML text"),
        flow_file: z.string().optional().describe("Path to a flow YAML file (alternative to `flow`)"),
        device: z.string().optional(),
        trace: z.boolean().optional().describe("screenshot every step for the HTML report"),
      },
    },
    async ({ flow, flow_file, device, trace }) => {
      try {
        gc();
        const source = flow ?? (flow_file ? await readFile(flow_file, "utf8") : undefined);
        if (!source) return fail(new Error("pass `flow` (YAML) or `flow_file`"));
        const baseDir = flow_file ? dirname(resolve(flow_file)) : process.cwd();
        const parsed = parseFlow(source, baseDir, flow_file ? resolve(flow_file) : undefined);
        const session = await RunSession.create(parsed, { device, resumeHint: true, config: trace ? { trace: true } : {} });
        const result = await session.start();
        const report = await session.report();
        if (result.resumable) sessions.set(session.id, { session, touched: Date.now() });
        else await session.close();
        return text(report);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "resume_flow",
    {
      description:
        "Continue a paused run from run_flow. decision: 'pass' = accept the stopped step (you judged it OK from the report) and go on; 'retry' = run that step again (e.g. after you fixed the app or the screen changed); 'fail' = end the run as failed. For a step blocked as risky, use 'pass' only if the user explicitly approved that action.",
      inputSchema: {
        run_id: z.string(),
        decision: z.enum(["pass", "retry", "fail"]),
      },
    },
    async ({ run_id, decision }) => {
      try {
        const entry = sessions.get(run_id);
        if (!entry) return fail(new Error(`no paused run ${run_id} (finished, expired after 30 min, or the server restarted)`));
        entry.touched = Date.now();
        const result = await entry.session.resume(decision);
        const report = await entry.session.report();
        if (!result.resumable) {
          sessions.delete(run_id);
          await entry.session.close();
        }
        return text(report);
      } catch (e) {
        return fail(e);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
