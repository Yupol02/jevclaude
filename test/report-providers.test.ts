import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "../src/engine/runner.js";
import { CloudflareJevClient, jevFromEnv, TypeSafeJevClient } from "../src/jev/providers.js";
import { toHtml } from "../src/report/html.js";
import { toJUnit } from "../src/report/junit.js";
import { formatReport } from "../src/report/text.js";

const run: RunResult = {
  flow: "login <happy>",
  app: "com.example.shop",
  device: "android/uia2 R58",
  status: "uncertain",
  resumable: true,
  crashes: [],
  totalMs: 4200,
  failureScreen: '[0] TextView "Welcome back"',
  steps: [
    { index: 0, step: "launch", status: "passed", decidedBy: "deterministic", ms: 900 },
    { index: 1, step: "tap Log in", status: "passed", decidedBy: "cache", element: "Log in", ms: 300 },
    {
      index: 2,
      step: 'expect "home"',
      status: "uncertain",
      decidedBy: "jev",
      probability: 0.5,
      detail: "p=0.50",
      ms: 250,
      shot: Buffer.from("x"),
    },
    { index: 3, step: 'see "Hello"', status: "skipped", decidedBy: "none", ms: 0 },
  ],
};
const usage = { calls: 3, inputTokens: 2400, outputTokens: 10, totalMs: 700, models: ["jev-1.14.0"] };

describe("reports", () => {
  it("text report tells Claude how to continue a paused run", () => {
    const t = formatReport(run, usage, { runId: "abc123" });
    expect(t).toMatch(/^UNCERTAIN — login <happy> on android\/uia2 R58/);
    expect(t).toContain('? 3. expect "home" [jev p=0.50] — p=0.50');
    expect(t).toContain("Replay cache: 1 step(s)");
    expect(t).toContain("Run abc123 is paused at step 3");
    expect(t).toContain("resume_flow");
    expect(t).toMatch(/~\$0\.0001/);
  });

  it("JUnit marks uncertain as error and skipped as skipped, escaping XML", () => {
    const x = toJUnit([run]);
    expect(x).toContain('<testsuite name="login &lt;happy&gt;" tests="4" failures="0" errors="1" skipped="1"');
    expect(x).toContain('type="uncertain"');
    expect(x).toContain("<skipped/>");
  });

  it("HTML report is self-contained and escapes content", () => {
    const h = toHtml([{ result: run, usage }]);
    expect(h).toContain("login &lt;happy&gt;");
    expect(h).toContain("data:image/png;base64,");
    expect(h).toContain("prefers-color-scheme:dark");
    expect(h).not.toMatch(/<script|https?:\/\/(?!www\.w3)/);
  });
});

describe("Jev providers", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const answer = { model: "jev-1.14.0", answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 1 } };

  it("TypeSafe: POST /v1/systemone with bearer auth and pinned model", async () => {
    const fetchMock = vi.fn(async () => ok(answer));
    vi.stubGlobal("fetch", fetchMock);
    const res = await new TypeSafeJevClient("k", "jev-1.14.0").ask({ state: "s", questions: { q: { type: "noul", instructions: "?" } } });
    expect(res.answers.q).toEqual({ type: "noul", noul: 0.9 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(String(init.body)).model).toBe("jev-1.14.0");
  });

  it("Cloudflare: model in body, unwraps the result envelope", async () => {
    const fetchMock = vi.fn(async () => ok({ success: true, result: answer }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await new CloudflareJevClient("acc", "tok").ask({ state: "s", questions: {} });
    expect(res.model).toBe("jev-1.14.0");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/run");
    expect(JSON.parse(String(init.body)).model).toBe("typesafe/jev");
  });

  it("retries 429 with Retry-After, then gives up on 4xx", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : ok(answer))),
    );
    await new TypeSafeJevClient("k").ask({ state: "s", questions: {} });
    expect(n).toBe(2);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad key", { status: 401 })),
    );
    await expect(new TypeSafeJevClient("k").ask({ state: "s", questions: {} })).rejects.toThrow(/401/);
  });

  it("picks the provider from env and config", () => {
    expect(jevFromEnv({ TYPESAFE_API_KEY: "k" }).name).toBe("typesafe");
    expect(jevFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" }).name).toBe("cloudflare");
    expect(() => jevFromEnv({})).toThrow(/No Jev provider/);
  });
});
