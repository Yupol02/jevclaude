import { type JevClient, JevError, type JevRequest, type JevResponse, postJson } from "./client.js";

/** TypeSafe direct API: POST {base}/v1/systemone, `Authorization: Bearer <TYPESAFE_API_KEY>`. */
export class TypeSafeJevClient implements JevClient {
  readonly name = "typesafe";
  constructor(
    private readonly apiKey: string,
    private readonly model = "jev-1.14.0",
    private readonly baseUrl = "https://api.typesafe.ai",
  ) {}

  async ask(req: JevRequest): Promise<JevResponse> {
    const body = { model: this.model, state: req.state, questions: req.questions };
    const res = await postJson(`${this.baseUrl.replace(/\/$/, "")}/v1/systemone`, { Authorization: `Bearer ${this.apiKey}` }, body);
    return assertResponse(res);
  }
}

/**
 * Cloudflare Workers AI: POST /client/v4/accounts/{id}/ai/run with `{ model: "typesafe/jev", input }`.
 * Cloudflare picks the Jev version; the answering model id comes back in `model`.
 */
export class CloudflareJevClient implements JevClient {
  readonly name = "cloudflare";
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
    private readonly model = "typesafe/jev",
  ) {}

  async ask(req: JevRequest): Promise<JevResponse> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run`;
    const res = await postJson(url, { Authorization: `Bearer ${this.apiToken}` }, { model: this.model, input: req });
    // The REST API may wrap the model output in Cloudflare's `{ success, result }` envelope.
    const unwrapped = isObject(res) && "result" in res && isObject(res.result) && "answers" in res.result ? res.result : res;
    return assertResponse(unwrapped);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertResponse(v: unknown): JevResponse {
  if (!isObject(v) || !isObject(v.answers)) {
    throw new JevError(`Unexpected Jev response: ${JSON.stringify(v).slice(0, 300)}`);
  }
  return {
    model: typeof v.model === "string" ? v.model : "unknown",
    answers: v.answers as JevResponse["answers"],
    usage: isObject(v.usage) ? (v.usage as JevResponse["usage"]) : { input_tokens: 0, output_tokens: 0 },
  };
}

/** Build a client from env vars. JEV_PROVIDER=typesafe|cloudflare (auto-detected if unset). */
export function jevFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: { provider?: string; model?: string } = {}): JevClient {
  const provider =
    env.JEV_PROVIDER ?? overrides.provider ?? (env.TYPESAFE_API_KEY ? "typesafe" : env.CLOUDFLARE_API_TOKEN ? "cloudflare" : undefined);
  if (provider === "typesafe") {
    if (!env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set");
    return new TypeSafeJevClient(env.TYPESAFE_API_KEY, env.JEV_MODEL ?? overrides.model ?? "jev-1.14.0", env.TYPESAFE_BASE_URL);
  }
  if (provider === "cloudflare") {
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set");
    }
    return new CloudflareJevClient(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
  }
  throw new Error("No Jev provider configured. Set TYPESAFE_API_KEY, or CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (see .env.example).");
}
