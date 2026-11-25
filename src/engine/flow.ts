import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { type DeviceCheck, DeviceCheckSchema, describeCheck } from "../device/state.js";

const Selector = z
  .object({ id: z.string().optional(), text: z.string().optional(), desc: z.string().optional() })
  .strict()
  .refine((s) => s.id || s.text || s.desc, "selector needs id, text or desc");

/** A target is either natural language ("the login button") or an exact selector. */
const Target = z.union([z.string().min(1), Selector]);
export type Target = z.infer<typeof Target>;

/** Modifiers any assertion/action step may carry. */
const common = {
  optional: z.boolean().optional().describe("a failure here is reported but doesn't stop the flow"),
  timeout: z.number().int().min(0).max(120_000).optional().describe("ms to keep retrying this step"),
};

export type Step =
  | "launch"
  | "back"
  | "stop"
  | "hide_keyboard"
  | { launch: string }
  | { open: string }
  | { tap: Target; scroll?: boolean; optional?: boolean; timeout?: number }
  | { type: { into: Target; text: string; submit?: boolean }; scroll?: boolean; optional?: boolean; timeout?: number }
  | { swipe: "up" | "down" | "left" | "right" }
  | { key: string }
  | { wait: number }
  | { wait_for: string; optional?: boolean; timeout?: number }
  | { see: string; optional?: boolean; timeout?: number }
  | { not_see: string; optional?: boolean; timeout?: number }
  | { expect: string; optional?: boolean; timeout?: number }
  | { device: DeviceCheck; optional?: boolean; timeout?: number }
  | { allow_risky: true }
  | { run: string }
  | { if_visible: string; then: Step[]; else?: Step[] };

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([
    z.enum(["launch", "back", "stop", "hide_keyboard"]),
    z.object({ launch: z.string().min(1) }).strict(),
    /** Open a URL or deep link in the flow's app (a new tab in browsers). */
    z.object({ open: z.string().min(1) }).strict(),
    z.object({ tap: Target, scroll: z.boolean().optional(), ...common }).strict(),
    z
      .object({
        type: z.object({ into: Target, text: z.string(), submit: z.boolean().optional() }).strict(),
        scroll: z.boolean().optional(),
        ...common,
      })
      .strict(),
    z.object({ swipe: z.enum(["up", "down", "left", "right"]) }).strict(),
    z.object({ key: z.string().min(1) }).strict(),
    z.object({ wait: z.number().int().min(0).max(60_000) }).strict(),
    /** Deterministic: wait until some element's text/description contains this string. */
    z.object({ wait_for: z.string().min(1), ...common }).strict(),
    z.object({ see: z.string().min(1), ...common }).strict(),
    z.object({ not_see: z.string().min(1), ...common }).strict(),
    /** Fuzzy: Jev judges whether the screen matches this natural-language expectation. */
    z.object({ expect: z.string().min(1), ...common }).strict(),
    /** Deterministic: a device state (flashlight, phone call, alarm, media, Wi-Fi, …) read from the device. */
    z.object({ device: DeviceCheckSchema, ...common }).strict(),
    /** Allow the next tap/type even if Jev flags it as risky (the user must opt in explicitly). */
    z.object({ allow_risky: z.literal(true) }).strict(),
    /** Inline another flow file's steps (path relative to this flow). */
    z.object({ run: z.string().min(1) }).strict(),
    z.object({ if_visible: z.string().min(1), then: z.array(StepSchema), else: z.array(StepSchema).optional() }).strict(),
  ]),
);

export const FlowSchema = z
  .object({
    name: z.string().optional(),
    app: z.string().min(1).describe("Android package or iOS bundle id"),
    platform: z.enum(["android", "ios"]).optional(),
    /** Force-stop the app before the first step. */
    fresh_start: z.boolean().optional(),
    /** What to do when a system permission dialog appears. */
    permissions: z.enum(["allow", "deny", "stop"]).optional(),
    /**
     * Phone calls. `block`: if an action starts a call, it is ended at once and the step is blocked.
     * `allow`: calls may start; one is ended right after a `device: { call: active }` check passes.
     * Either way, a call still running at the end of the flow is ended. Unset: calls aren't watched.
     */
    calls: z.enum(["allow", "block"]).optional(),
    /** Flow-level variables for ${VAR}; environment variables override them. */
    env: z.record(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict();
export type Flow = z.infer<typeof FlowSchema>;

/** Replace ${VAR} with environment / flow values so credentials stay out of flow files. */
export function interpolate(text: string, env: Record<string, string | undefined> = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`Flow references \${${name}} but it is not set (env or flow \`env:\`)`);
    return v;
  });
}

function validate(data: unknown): Flow {
  const result = FlowSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid flow:\n${issues}`);
  }
  return result.data;
}

/** Sub-flow files may omit `app`; they only need `steps` (or be a bare list of steps). */
function loadSubSteps(path: string, stack: string[]): Step[] {
  if (stack.includes(path)) throw new Error(`run: cycle detected (${[...stack, path].join(" → ")})`);
  if (!existsSync(path)) throw new Error(`run: file not found: ${path}`);
  const data = YAML.parse(readFileSync(path, "utf8")) as unknown;
  const steps = Array.isArray(data) ? data : (data as { steps?: unknown })?.steps;
  const parsed = z.array(StepSchema).safeParse(steps);
  if (!parsed.success) throw new Error(`run: ${path} has no valid steps: ${parsed.error.issues[0]?.message}`);
  return inlineRuns(parsed.data, dirname(path), [...stack, path]);
}

function inlineRuns(steps: Step[], baseDir: string, stack: string[]): Step[] {
  return steps.flatMap((s): Step[] => {
    if (typeof s === "object" && "run" in s) return loadSubSteps(resolve(baseDir, s.run), stack);
    if (typeof s === "object" && "if_visible" in s) {
      return [{ ...s, then: inlineRuns(s.then, baseDir, stack), ...(s.else ? { else: inlineRuns(s.else, baseDir, stack) } : {}) }];
    }
    return [s];
  });
}

/** Parse a flow from YAML text (or an object). `run:` paths resolve against `baseDir`. */
export function parseFlow(source: string | unknown, baseDir = process.cwd(), origin?: string): Flow {
  const data = typeof source === "string" ? YAML.parse(source) : source;
  const flow = validate(data);
  return { ...flow, steps: inlineRuns(flow.steps, baseDir, origin ? [origin] : []) };
}

export function loadFlowFile(path: string): Flow {
  const abs = resolve(path);
  return parseFlow(readFileSync(abs, "utf8"), dirname(abs), abs);
}

export function describeTarget(t: Target): string {
  if (typeof t === "string") return t;
  return Object.entries(t)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
}

export function describeStep(step: Step): string {
  if (typeof step === "string") return step.replace("_", " ");
  const opt = "optional" in step && step.optional ? " (optional)" : "";
  if ("launch" in step) return `launch ${step.launch}`;
  if ("open" in step) return `open ${step.open}`;
  if ("tap" in step) return `tap ${describeTarget(step.tap)}${opt}`;
  if ("type" in step) return `type into ${describeTarget(step.type.into)}${step.type.submit ? " + submit" : ""}${opt}`;
  if ("swipe" in step) return `swipe ${step.swipe}`;
  if ("key" in step) return `key ${step.key}`;
  if ("wait" in step) return `wait ${step.wait}ms`;
  if ("wait_for" in step) return `wait for "${step.wait_for}"${opt}`;
  if ("see" in step) return `see "${step.see}"${opt}`;
  if ("not_see" in step) return `not see "${step.not_see}"${opt}`;
  if ("expect" in step) return `expect "${step.expect}"${opt}`;
  if ("device" in step) return `device ${describeCheck(step.device)}${opt}`;
  if ("run" in step) return `run ${step.run}`;
  if ("if_visible" in step) return `if visible "${step.if_visible}"`;
  return "allow risky";
}
