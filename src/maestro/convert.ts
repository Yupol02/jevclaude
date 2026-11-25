import YAML from "yaml";
import type { Flow, Step, Target } from "../engine/flow.js";

/**
 * Convert between Maestro flows (https://docs.maestro.dev) and jevclaude flows.
 * Only a common subset is supported; everything else is reported in `warnings`.
 */
export interface Converted<T> {
  value: T;
  warnings: string[];
}

type MaestroTarget = string | { id?: string; text?: string; [k: string]: unknown };
type MaestroCmd = string | Record<string, unknown>;

const DIR: Record<string, "up" | "down" | "left" | "right"> = { UP: "up", DOWN: "down", LEFT: "left", RIGHT: "right" };

function toTarget(t: MaestroTarget): Target {
  if (typeof t === "string") return { text: t };
  const sel: { id?: string; text?: string } = {};
  if (typeof t.id === "string") sel.id = t.id;
  if (typeof t.text === "string") sel.text = t.text;
  return sel.id || sel.text ? sel : String(t.text ?? t.id ?? "");
}

export function importMaestro(source: string): Converted<Flow> {
  const docs = YAML.parseAllDocuments(source).map((d) => d.toJS() as unknown);
  const header = (docs.length > 1 ? docs[0] : {}) as { appId?: string; name?: string; tags?: string[] };
  const commands = (docs.length > 1 ? docs[1] : docs[0]) as MaestroCmd[];
  if (!Array.isArray(commands)) throw new Error("Maestro flow has no command list");
  const warnings: string[] = [];
  const steps: Step[] = [];

  commands.forEach((cmd, i) => {
    const [name, arg] = typeof cmd === "string" ? [cmd, undefined] : (Object.entries(cmd)[0] ?? ["", undefined]);
    const where = `command ${i + 1} (${name})`;
    switch (name) {
      case "launchApp": {
        const a = arg as { appId?: string; clearState?: boolean } | string | undefined;
        if (a && typeof a === "object" && a.clearState) warnings.push(`${where}: clearState is not supported; the app is launched as-is`);
        const id = typeof a === "string" ? a : a?.appId;
        steps.push(id && id !== header.appId ? { launch: id } : "launch");
        break;
      }
      case "stopApp":
      case "killApp":
        steps.push("stop");
        break;
      case "tapOn":
        steps.push({ tap: toTarget(arg as MaestroTarget) });
        break;
      case "inputText": {
        const text = String(arg);
        const prev = steps.at(-1);
        // Maestro types into the focused field; jevclaude names the field, so merge with the preceding tap.
        if (prev && typeof prev === "object" && "tap" in prev) {
          steps[steps.length - 1] = { type: { into: prev.tap, text } };
        } else {
          steps.push({ type: { into: "the focused input field", text } });
        }
        break;
      }
      case "assertVisible":
      case "extendedWaitUntil": {
        const a = (name === "extendedWaitUntil" ? (arg as { visible?: MaestroTarget; timeout?: number }).visible : arg) as MaestroTarget;
        const timeout = name === "extendedWaitUntil" ? (arg as { timeout?: number }).timeout : undefined;
        const text = typeof a === "string" ? a : (a?.text as string | undefined);
        if (!text) {
          warnings.push(`${where}: only text assertions are supported`);
          break;
        }
        steps.push(timeout ? { wait_for: text, timeout } : { see: text });
        break;
      }
      case "assertNotVisible": {
        const text = typeof arg === "string" ? arg : ((arg as { text?: string })?.text ?? "");
        if (text) steps.push({ not_see: text });
        else warnings.push(`${where}: only text assertions are supported`);
        break;
      }
      case "assertWithAI":
      case "assertNoDefectsWithAI": {
        const assertion =
          name === "assertNoDefectsWithAI"
            ? "The screen has no visual or functional defects"
            : String((arg as { assertion?: string })?.assertion ?? arg);
        steps.push({ expect: assertion });
        break;
      }
      case "scroll":
        steps.push({ swipe: "up" });
        break;
      case "scrollUntilVisible": {
        const el = (arg as { element?: MaestroTarget })?.element;
        const text = typeof el === "string" ? el : (el?.text as string | undefined);
        if (text) steps.push({ wait_for: text }, { tap: { text } });
        else warnings.push(`${where}: needs element.text`);
        if (text) warnings.push(`${where}: converted to wait_for + tap (jevclaude scrolls automatically when tapping)`);
        break;
      }
      case "swipe": {
        const d = DIR[String((arg as { direction?: string })?.direction ?? "").toUpperCase()];
        if (d) steps.push({ swipe: d });
        else warnings.push(`${where}: only direction swipes are supported`);
        break;
      }
      case "back":
        steps.push("back");
        break;
      case "hideKeyboard":
        steps.push("hide_keyboard");
        break;
      case "pressKey":
        steps.push({ key: String(arg).toLowerCase() });
        break;
      case "runFlow":
        steps.push({ run: typeof arg === "string" ? arg : String((arg as { file?: string }).file) });
        break;
      case "waitForAnimationToEnd":
        steps.push({ wait: 500 });
        break;
      case "openLink":
        steps.push({ open: typeof arg === "string" ? arg : String((arg as { link?: string }).link) });
        break;
      case "takeScreenshot":
        warnings.push(`${where}: ignored (use --trace for per-step screenshots)`);
        break;
      default:
        warnings.push(`${where}: not supported, skipped`);
    }
  });

  if (!header.appId) warnings.push("no appId in the Maestro header; set `app:` by hand");
  const flow: Flow = {
    ...(header.name ? { name: header.name } : {}),
    app: header.appId ?? "CHANGE_ME",
    ...(header.tags ? { tags: header.tags } : {}),
    steps,
  };
  return { value: flow, warnings };
}

function fromTarget(t: Target): MaestroTarget {
  if (typeof t === "string") return t;
  return t.id && !t.text ? { id: t.id } : t.text && !t.id ? t.text : { ...(t.id ? { id: t.id } : {}), ...(t.text ? { text: t.text } : {}) };
}

export function exportMaestro(flow: Flow): Converted<string> {
  const warnings: string[] = [];
  const out: MaestroCmd[] = [];
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      if (s === "launch") out.push("launchApp");
      else if (s === "back") out.push("back");
      else if (s === "stop") out.push("stopApp");
      else if (s === "hide_keyboard") out.push("hideKeyboard");
      else if ("launch" in s) out.push({ launchApp: { appId: s.launch } });
      else if ("open" in s) out.push({ openLink: s.open });
      else if ("tap" in s) {
        if (typeof s.tap === "string")
          warnings.push(`tap "${s.tap}": natural-language target exported as text; Maestro will match it literally`);
        out.push({ tapOn: fromTarget(s.tap) });
      } else if ("type" in s) {
        out.push({ tapOn: fromTarget(s.type.into) }, { inputText: s.type.text });
        if (s.type.submit) out.push({ pressKey: "Enter" });
      } else if ("swipe" in s) out.push({ swipe: { direction: s.swipe.toUpperCase() } });
      else if ("key" in s) out.push({ pressKey: s.key[0]!.toUpperCase() + s.key.slice(1) });
      else if ("wait" in s) out.push("waitForAnimationToEnd");
      else if ("wait_for" in s) out.push({ extendedWaitUntil: { visible: s.wait_for, timeout: s.timeout ?? 10_000 } });
      else if ("see" in s) out.push({ assertVisible: s.see });
      else if ("not_see" in s) out.push({ assertNotVisible: s.not_see });
      else if ("expect" in s) {
        out.push({ assertWithAI: { assertion: s.expect } });
        warnings.push(`expect "${s.expect}": Maestro's assertWithAI is optional by default and runs through Maestro Cloud`);
      } else if ("run" in s) out.push({ runFlow: s.run });
      else if ("if_visible" in s) {
        warnings.push(`if_visible "${s.if_visible}": exported as runFlow-less inline steps of the 'then' branch only`);
        walk(s.then);
      } else if ("allow_risky" in s) warnings.push("allow_risky has no Maestro equivalent (Maestro has no risk guard)");
    }
  };
  walk(flow.steps);
  const header = YAML.stringify({ appId: flow.app, ...(flow.name ? { name: flow.name } : {}), ...(flow.tags ? { tags: flow.tags } : {}) });
  return { value: `${header}---\n${YAML.stringify(out)}`, warnings };
}
