/**
 * Types for TypeSafe Jev's structured-evaluation API.
 * Wire format per https://docs.typesafe.ai/api/system-one.md and the Cloudflare Workers AI schema.
 */
export type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue };

export type JevQuestion =
  | { type: "noul"; instructions: JSONValue; criteria?: { true?: JSONValue; false?: JSONValue } | null }
  | { type: "choice"; instructions: JSONValue; criteria: Record<string, JSONValue> }
  | { type: "score"; instructions: JSONValue; criteria: JSONValue[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: "score";
      score: number;
      legend: Record<string, JSONValue>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface JevRequest {
  state: string | JSONValue[] | { [k: string]: JSONValue };
  questions: Record<string, JevQuestion>;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface JevClient {
  readonly name: string;
  ask(req: JevRequest): Promise<JevResponse>;
}

export const MAX_CHOICE_OPTIONS = 255;
export const MAX_SCORE_LEVELS = 10;

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

/** Accumulates usage across calls so reports and benchmarks can show real token spend. */
export class UsageMeter {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  ms = 0;
  models = new Set<string>();

  wrap(inner: JevClient): JevClient {
    return {
      name: inner.name,
      ask: async (req) => {
        const t0 = performance.now();
        const res = await inner.ask(req);
        this.ms += performance.now() - t0;
        this.calls += 1;
        this.inputTokens += res.usage?.input_tokens ?? 0;
        this.outputTokens += res.usage?.output_tokens ?? 0;
        if (res.model) this.models.add(res.model);
        return res;
      },
    };
  }

  toJSON() {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalMs: Math.round(this.ms),
      models: [...this.models],
    };
  }
}

/** POST JSON with timeout and retry on 429/5xx (honours Retry-After). */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  { timeoutMs = 30_000, retries = 2 }: { timeoutMs?: number; retries?: number } = {},
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new JevError(`Jev request failed (${res.status}): ${text.slice(0, 500)}`, res.status, text);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 10_000)));
  }
}
