import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { DEFAULT_CONFIG, type RunnerConfig } from "./engine/runner.js";

export const CONFIG_FILE = "jevclaude.config.yaml";

const prob = z.number().min(0).max(1);

export const ConfigSchema = z
  .object({
    jev: z
      .object({
        provider: z.enum(["typesafe", "cloudflare"]).optional(),
        model: z.string().optional(),
      })
      .strict()
      .optional(),
    android: z
      .object({ backend: z.enum(["auto", "uia2", "adb"]).optional() })
      .strict()
      .optional(),
    ios: z.object({ wda_url: z.string().url().optional() }).strict().optional(),
    runner: z
      .object({
        pass: prob.optional(),
        fail: prob.optional(),
        error_fail: prob.optional(),
        min_pick_confidence: prob.optional(),
        risk_block: prob.optional(),
        risk_guard: z.boolean().optional(),
        check_errors_every_step: z.boolean().optional(),
        error_check: z.enum(["auto", "always"]).optional(),
        settle_ms: z.number().int().min(0).optional(),
        fast_settle_ms: z.number().int().min(0).optional(),
        assert_timeout_ms: z.number().int().min(0).optional(),
        wait_for_timeout_ms: z.number().int().min(0).optional(),
        max_scrolls: z.number().int().min(0).max(30).optional(),
      })
      .strict()
      .optional(),
    cache: z.enum(["on", "off", "update"]).optional(),
    reports_dir: z.string().optional(),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path = CONFIG_FILE): Config {
  if (!existsSync(path)) return {};
  const result = ConfigSchema.safeParse(YAML.parse(readFileSync(path, "utf8")) ?? {});
  if (!result.success) {
    throw new Error(`Invalid ${path}:\n${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return result.data;
}

export function runnerConfigFrom(cfg: Config): Partial<RunnerConfig> {
  const r = cfg.runner ?? {};
  const out: Partial<RunnerConfig> = {};
  if (r.pass !== undefined) out.pass = r.pass;
  if (r.fail !== undefined) out.fail = r.fail;
  if (r.error_fail !== undefined) out.errorFail = r.error_fail;
  if (r.min_pick_confidence !== undefined) out.minPickConfidence = r.min_pick_confidence;
  if (r.risk_block !== undefined) out.riskBlock = r.risk_block;
  if (r.risk_guard !== undefined) out.riskGuard = r.risk_guard;
  if (r.check_errors_every_step !== undefined) out.checkErrorsEveryStep = r.check_errors_every_step;
  if (r.settle_ms !== undefined) out.settleMs = r.settle_ms;
  if (r.fast_settle_ms !== undefined) out.fastSettleMs = r.fast_settle_ms;
  if (r.error_check !== undefined) out.errorCheck = r.error_check;
  if (r.assert_timeout_ms !== undefined) out.assertTimeoutMs = r.assert_timeout_ms;
  if (r.wait_for_timeout_ms !== undefined) out.waitForTimeoutMs = r.wait_for_timeout_ms;
  if (r.max_scrolls !== undefined) out.maxScrolls = r.max_scrolls;
  return out;
}

export const DEFAULT_CONFIG_YAML = `# jevclaude configuration — every key is optional.
jev:
  provider: typesafe        # or cloudflare (keys come from .env)
  model: jev-1.14.0         # pin the version you tuned thresholds on
android:
  backend: auto             # auto | uia2 (fast, Unicode typing) | adb
runner:
  pass: ${DEFAULT_CONFIG.pass}                # Jev yes-probability needed to pass
  fail: ${DEFAULT_CONFIG.fail}                # at or below ⇒ failed; between ⇒ uncertain (Claude decides)
  risk_block: ${DEFAULT_CONFIG.riskBlock}           # block tap/type at or above this risk
  max_scrolls: ${DEFAULT_CONFIG.maxScrolls}            # swipes while searching for a target
  error_check: auto         # auto: ask Jev about errors only when an error hint is on screen · always: every action
cache: on                   # on | off | update — replay cache in .jevclaude/cache
reports_dir: reports
`;
