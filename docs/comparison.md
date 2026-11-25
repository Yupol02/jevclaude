# How JevClaude compares

This is an honest map, written in November 2026 from the projects' own docs. Corrections are welcome by PR.

| | JevClaude | [Maestro](https://github.com/mobile-dev-inc/maestro) | [Arbigent](https://github.com/takahirom/arbigent) | [Midscene.js](https://github.com/web-infra-dev/midscene) | [mobile-mcp](https://github.com/mobile-next/mobile-mcp) | [Firebase App Testing Agent](https://firebase.google.com/docs/app-distribution/android/app-testing-agent) |
|---|---|---|---|---|---|---|
| Flows | YAML | YAML | YAML scenarios | YAML / JS | none (agent drives) | YAML goals |
| What the model sees | accessibility tree (text) | screenshot (AI commands) | tree + annotated screenshot | screenshots | tree, screenshot fallback | accessibility tree |
| Per-step decision | exact → cache → **cheap Jev call** → Claude | deterministic; AI only in `*WithAI` | LLM per step | VLM per step | the calling agent | Gemini |
| Re-run without a model | replay cache, self-healing | yes (plain Maestro) | `replayWithFallback` | cache | no | cached actions |
| AI assertions fail the test | **yes**, with an "uncertain" band sent to Claude | `assertWithAI` is optional by default | yes | yes | n/a | final-screen assertion |
| Risk guard for destructive actions | **yes** | no | no | no | no | no |
| Pause and let the coding agent decide | **`resume_flow`** | no | no | no | n/a | no |
| Runs fully local / own key | yes | Maestro AI goes through Maestro Cloud | yes | yes | yes | cloud only |
| iOS | simulator | yes | yes (via Maestro) | yes | yes | no |
| Maturity | **new** | very mature, ~16k★ | ~0.7k★ | ~16k★ | ~11k★ | preview |

## Where JevClaude overlaps

- "Claude writes YAML and a runner executes it" is also what Maestro's MCP server offers.
- Replay-with-AI-fallback caching is now common (Arbigent, Firebase, Midscene, GPT Driver, Drizz).

JevClaude doesn't claim either as new, and it ships `import-maestro` / `export-maestro` so you can keep both.

## Where it is different

1. **A tiered decision layer.** Cheap typed questions (choice, yes/no) at about 200 ms and about $0.04 per million tokens decide most steps. Claude is involved only below a confidence threshold, and then by resuming the same run.
2. **A risk guard.** Purchases, deletions, messages and account changes are blocked until a person allows them.
3. **Strict, calibrated assertions.** `expect:` uses probability thresholds, so it can't quietly pass the way an optional AI check can.

## Where it is weaker

- It is younger and less battle-tested than Maestro or Appium.
- It is text-only: canvas, game or Flutter-without-semantics screens need screenshots and Claude.
- iOS support covers simulators only.
