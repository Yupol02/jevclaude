/**
 * Live check of the Jev connection without a phone: asks the real API about a recorded screen.
 *   npx tsx bench/jev-smoke.ts
 */
import { readFileSync } from "node:fs";
import { labelOf } from "../src/core/uitree.js";
import { parseAndroidXml } from "../src/driver/android/xml.js";
import { UsageMeter } from "../src/jev/client.js";
import { jevFromEnv } from "../src/jev/providers.js";
import { afterActionRequest, beforeActionRequest, candidatesFor } from "../src/jev/questions.js";
import { loadDotEnv } from "../src/session.js";

loadDotEnv();
const snap = parseAndroidXml(readFileSync("test/fixtures/login.xml", "utf8"));
const meter = new UsageMeter();
const jev = meter.wrap(jevFromEnv());

const label = (key: string) => candidatesFor(snap, "tap").find((e) => `e${e.index}` === key);

const cases: Array<[string, () => Promise<string>]> = [
  [
    "pick 'the button that signs me in' (want: Log in) + risk (want: low)",
    async () => {
      const r = await jev.ask(
        beforeActionRequest(snap, "the button that signs me in", "tap", {
          askPick: true,
          askRisk: true,
          actionText: "tap the button that signs me in",
        }).request,
      );
      const p = r.answers.pick!;
      const k = r.answers.risk!;
      return `pick=${p.type === "choice" ? `${JSON.stringify(labelOf(label(p.choice)!))} conf=${p.confidence.toFixed(2)}` : "?"} risk=${k.type === "noul" ? k.noul.toFixed(2) : "?"}`;
    },
  ],
  [
    "risk of 'tap Delete account' (want: high)",
    async () => {
      const r = await jev.ask(
        beforeActionRequest(snap, "Delete account", "tap", { askPick: false, askRisk: true, actionText: "tap Delete account" }).request,
      );
      const k = r.answers.risk!;
      return `risk=${k.type === "noul" ? k.noul.toFixed(2) : "?"}`;
    },
  ],
  [
    "expect 'login screen with email and password' (want: high) / error (want: low)",
    async () => {
      const r = await jev.ask(
        afterActionRequest(snap, { expectation: "A login screen with email and password fields", checkErrors: true }),
      );
      const e = r.answers.expect!;
      const x = r.answers.error!;
      return `expect=${e.type === "noul" ? e.noul.toFixed(2) : "?"} error=${x.type === "noul" ? x.noul.toFixed(2) : "?"}`;
    },
  ],
  [
    "expect 'home screen, user signed in' (want: low)",
    async () => {
      const r = await jev.ask(
        afterActionRequest(snap, { expectation: "Home screen is shown and the user is signed in", checkErrors: false }),
      );
      const e = r.answers.expect!;
      return `expect=${e.type === "noul" ? e.noul.toFixed(2) : "?"}`;
    },
  ],
];

for (const [name, fn] of cases) {
  const t0 = performance.now();
  try {
    const out = await fn();
    console.log(`${name}\n  → ${out}  (${Math.round(performance.now() - t0)} ms)`);
  } catch (e) {
    console.log(`${name}\n  → ERROR ${(e as Error).message}`);
  }
}
console.log("usage:", JSON.stringify(meter.toJSON()));
