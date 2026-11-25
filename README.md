# JevClaude

[![npm](https://img.shields.io/npm/v/jevclaude?color=cb3837&logo=npm)](https://www.npmjs.com/package/jevclaude)
[![CI](https://github.com/Yupol02/jevclaude/actions/workflows/ci.yml/badge.svg)](https://github.com/Yupol02/jevclaude/actions/workflows/ci.yml)
[![provenance](https://img.shields.io/badge/npm-provenance-2ea44f?logo=sigstore)](https://www.npmjs.com/package/jevclaude#provenance)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/node/v/jevclaude)

**Mobile app testing for Claude Code that doesn't burn your tokens.** Android is verified on a real phone; iOS (simulator) is implemented but still experimental.

Claude writes a test flow once. A local runner drives the device. [TypeSafe Jev](https://docs.typesafe.ai), a small structured-decision model, makes the per-step calls in about 200 ms each:
- which element to tap
- whether the step passed
- whether an error is showing
- whether the action is risky

A replay cache makes re-runs model-free. Claude only hears back when something fails or Jev isn't sure, and it can then decide and **resume the run where it stopped**.


```
Claude Code ──(MCP: run_flow / resume_flow)──▶ Runner ──▶ Driver
     ▲                                           │          ├─ Android: adb + UiAutomator2 server
     │ short report, only on stop                │          └─ iOS: WebDriverAgent + simctl
     │                                           ├─ 1. deterministic: exact id/text, logcat/crash reports, text checks, spinners
     │                                           ├─ 2. replay cache: last run's selector (self-heals if it's gone)
     └───────────────────────────────────────────├─ 3. Jev: choice(element) · yes/no(passed? error? risky? permission button?)
                                                 └─ 4. below threshold → paused "uncertain" → Claude decides
```

[Türkçe README](README.tr.md) · [Architecture](docs/architecture.md) · [Flow reference](docs/flow-reference.md) · [How it compares](docs/comparison.md)

## Why

When Claude Code tests an app by driving the device itself, every step is a full LLM turn: screenshot, read, think, act. That's slow and expensive. Most of those decisions are small and typed:
- "Which of these 30 elements is the login button?"
- "Does this screen show the cart: yes or no?"

| | Plain Claude Code + adb | JevClaude |
|---|---|---|
| What the model sees | screenshots | compact accessibility tree (`[3] Button "Log in" id=btn_login {clickable}`) |
| Per-step decision | Claude turn | exact match → cache → one Jev call (choice and risk asked together) |
| Re-running a passing flow | the same cost again | replay cache, zero model calls for element picks |
| Risky actions (buy, delete, send) | whatever the model decides | blocked by default; the user must approve |
| AI assertions | — | `expect:` **fails the test** below threshold; the uncertain zone goes back to Claude |

Jev input costs about $0.042 per million tokens, and output is free.

**Measured on a real app** (details in [Benchmark](#benchmark)): creating an event in a real Android app took a median of **47 s and ≈ $0.0008 per run** with JevClaude, against **90 s and ≈ $0.28** when plain Claude Code drove the same phone. That is about 1.9× faster and about 350× cheaper per run, once the flow is written. Both methods passed 2 of 3 runs. The sample is small; read the caveats before quoting it.

## Quick start

Prerequisites: Node 20 or newer.
- Android: `adb` and a phone with USB debugging, or an emulator.
- iOS: macOS with Xcode and a booted simulator.

```bash
npm install && npm run build
node dist/cli.js init            # jevclaude.config.yaml, flows/smoke.yaml, .env
# add TYPESAFE_API_KEY (or CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN) to .env
node dist/cli.js setup android   # optional: UiAutomator2 server → ~0.2 s screen reads + Unicode typing
node dist/cli.js setup ios       # boots a simulator if needed, installs WebDriverAgent
node dist/cli.js doctor          # checks tools, devices, servers and the Jev key
node dist/cli.js run examples/flows/settings-smoke.yaml --html report.html
```

### Use it in your project

1. In your app's repository, create the starter files:
   ```bash
   npx jevclaude init     # jevclaude.config.yaml, flows/smoke.yaml, .env
   ```
2. Put `TYPESAFE_API_KEY` and any test-account values (`TEST_EMAIL`, …) in `.env`. `init` creates it; keep it out of git.
3. Connect a phone with USB debugging and run:
   ```bash
   npx jevclaude setup android && npx jevclaude doctor
   ```
4. Connect Claude Code to it (next section). Ask Claude to test a feature; it writes the flow into `flows/` and runs it.
5. Commit `flows/` and `.jevclaude/cache/`, so CI re-runs need no model calls for element picks. Run them on every PR with [examples/ci/github-actions-android.yml](examples/ci/github-actions-android.yml).

### Use from Claude Code

```bash
claude mcp add jevclaude -- npx -y jevclaude mcp
```

Then ask: *"test the login flow on my phone"*. The bundled skill (`.claude/skills/test-feature`) tells Claude to write one flow, call `run_flow` once, and read only the report.

MCP tools:

| Tool | What it does |
|---|---|
| `list_devices` | Android devices and booted iOS simulators |
| `snapshot` | the current screen as compact text (cheaper than a screenshot) |
| `run_flow` | runs a YAML flow; returns a short report and, if it stopped, a `run_id` |
| `resume_flow` | `pass` / `retry` / `fail` for the stopped step, then continues without relaunching |

## Flow example

```yaml
name: login happy path
app: com.example.shop          # Android package or iOS bundle id
fresh_start: true
permissions: allow             # system permission dialogs: allow | deny | stop (default)
steps:
  - launch
  - if_visible: "What's new"
    then: [ { tap: { text: "Close" } } ]
  - tap: "Log in button on the welcome screen"            # cache → Jev; scrolls to find it
  - type: { into: "email field", text: "${TEST_EMAIL}" }  # ${VAR} from env/.env
  - type: { into: { id: password }, text: "${TEST_PASSWORD}", submit: true }
  - wait_for: "Home"                                      # deterministic, up to 10 s
  - expect: "The user is signed in and sees their name"   # Jev judges the screen
  - see: "Siparişlerim"                                   # Unicode is fine
    optional: true
```

The full syntax is in [docs/flow-reference.md](docs/flow-reference.md). Maestro users can convert flows with `jevclaude import-maestro` and `export-maestro`.

## CLI

```bash
jevclaude run flows/ --junit junit.xml --html report.html   # every *.yaml in flows/
jevclaude run flows/ --devices R58M123,emulator-5554        # same flows on several devices, in parallel
jevclaude run login.yaml --trace --record                   # screenshot every step + video
jevclaude run login.yaml --update-cache                     # re-resolve targets and refresh the cache
jevclaude snapshot --platform ios                           # what Jev would see
jevclaude import-maestro login.maestro.yaml -o flows/login.yaml
```

Reports are written to `reports/<time>-<flow>/`:
- `report.json`
- `report.html`: self-contained, with step timeline, Jev probabilities and screenshots
- `step-NN.png`
- `run.mp4`, when `--record` is set

Exit codes: 0 if everything passed, 1 otherwise.

## Decisions and thresholds

| Question | How | Rule (configurable in `jevclaude.config.yaml`) |
|---|---|---|
| Which element is "the login button"? | exact match → cache → Jev `choice` over on-screen elements | confidence below 0.6 → `uncertain`; `none` → scroll, then `failed` |
| Does the screen match `expect:`? | Jev `noul` | p ≥ 0.85 passed · p ≤ 0.15 failed · otherwise `uncertain` → Claude |
| Is an error or crash visible after an action? | logcat / crash reports, then Jev `noul` | crash or p ≥ 0.85 → `failed` |
| Is this tap or type risky? | Jev `noul`, asked together with the pick and cached once it's known to be safe | p ≥ 0.5 → `blocked` until the user allows it |
| Permission dialog? | package / alert detection, button by regex, then Jev | per-flow `permissions:` policy |
| Still loading? | progress-indicator detection | wait up to 15 s |

Screen text is untrusted. It is wrapped in `<<<SCREEN … SCREEN>>>` and every question tells Jev to treat it as data, so text inside the app under test can't steer decisions.

## Status and limits

- **What's verified:**
  - 53 unit tests, 89% line coverage, all run on recorded Android (uiautomator and UiAutomator2) and iOS (WebDriverAgent) screens.
  - The live Jev API is checked with `npm run jev:smoke`.
  - **Android, real device:** Samsung Galaxy S22 Ultra, Android 16, Turkish UI. Verified there:
    - both backends, the replay cache and `run_flow` → `resume_flow` over MCP
    - a production Jetpack Compose app, including Unicode typing into Compose fields and date/time fields that have no accessibility label
    - results are below
- **What's not verified yet:**
  - iOS on a live simulator.
  - The risk guard and permission dialogs on a device (they are covered by unit tests only).
  - See the [e2e checklist](CONTRIBUTING.md#end-to-end-checklist).
- **Jev's weak spots:** counting, arithmetic and multi-hop reasoning. Check numbers with `see:`.
- **Literal reading:** Jev takes wording literally. "Results are shown *under* the search field" correctly scored 0.19 on a phone whose search bar sits *below* the results. Describe what must be true, not where it is.
- **Text-only:** canvas, games and Flutter apps without semantics produce empty trees. Those need Claude with screenshots.
- **Unlabeled controls:** a tap target with no label gets the text it touches as a `near="…"` hint (e.g. a date field's "Date is required" message). It works, but adding a `contentDescription` / `semantics` label to the app is more reliable, and better for accessibility.
- **Don't record the screen in parallel:** a `screencap` loop running next to a test slowed the phone enough to break UiAutomator2 calls. Use `--trace` (one screenshot per step) or `--record`.
- **Android typing:** the adb-only backend types ASCII only. `setup android` enables Unicode.
- **iOS:** simulator only for now. Real devices need WebDriverAgent signing.

## Benchmark

`npm run bench -- --runs 3 --baseline` runs each scenario in `bench/scenarios.json` four ways:
- JevClaude, cold cache
- JevClaude, warm cache
- plain `claude -p` driving `adb`
- optionally Maestro

It prints pass rate, median time, tokens and cost.

### Real app: JevClaude vs plain Claude Code

On 2026-11-25 the same task was run 3 times with each method on a Galaxy S22 Ultra (Android 16). The task is "add a new event": title, date picker (30 Nov 2026), content, time picker (18:00), then *create*, then check it is listed. The app is the author's own Jetpack Compose app, version 1.8.

Every claimed pass was checked independently by reading the event list afterwards. The checker found the title, date and time, with exactly one copy.

| | JevClaude (adb backend, J1 cold cache, J2–J3 warm) | Plain Claude Code (`claude -p`, adb + screenshots) |
|---|---|---|
| Run times | 47.4 · 48.1 · 45.5 s | 159.5 · 78.5 · 89.6 s |
| **Median time** | **47.4 s** | **89.6 s** |
| Passed on its own | 2/3: J2 stopped as `uncertain` (p = 0.84) on a correctly filled form | 2/3: C1 failed, and the phone also dropped off USB during it |
| False passes | 0 | 0 |
| Tokens per run | 16–21 k (Jev) | 0.63–1.74 M (Claude, mostly cache reads) |
| **Median cost** | **≈ $0.0008** | **≈ $0.28** (range $0.25–0.43) |
| Model | jev-1.14.0, 18–24 calls | claude-sonnet-5-5, 23–49 turns |

What this does and doesn't show:
- **It's per run, after the flow exists.** Writing and debugging this flow took several iterations, which this table doesn't count. Plain Claude needed no flow. JevClaude pays off when the same test runs again: every PR, every release.
- **The sample is small.** One app, one task, 3 runs each.
- **JevClaude ran on the slow backend** (~2.3 s per screen read). The UiAutomator2 backend couldn't type into Compose fields until 0.2.3. With it, a 19-step version of the same form, filled but not saved, now takes 26–33 s. The create flow hasn't been re-measured on it.
- **Plain Claude made a mistake.** In C1 it opened a different event by accident; it only looked and went back. It also had taps land under the on-screen keyboard. 0.2.3 hides the keyboard before such taps.

### Measured so far: Android Settings

These are single runs on a Samsung Galaxy S22 Ultra (Android 16, Turkish UI) on 2026-11-25, with Jev `jev-1.14.0` through the TypeSafe API. The flows are [settings-smoke.yaml](examples/flows/settings-smoke.yaml) (5 steps; the target is found after 3 scrolls) and [settings-search-unicode.yaml](examples/flows/settings-search-unicode.yaml) (7 steps).

| What | Result |
|---|---|
| Screen read, `uiautomator dump` (adb backend) | 2.28–2.34 s (5 reads) |
| Screen read, UiAutomator2 backend | 0.12–0.21 s (5 reads; the first read right after a scroll can take up to 2.2 s while the UI settles) |
| settings-smoke, adb backend, no cache | passed · 22.9 s · 9 Jev calls · 9,574 tokens · ≈ $0.0004 |
| settings-smoke, UiAutomator2, cold cache | passed · 15.2 s · 9 Jev calls · 9,580 tokens |
| settings-smoke, UiAutomator2, warm cache | passed · 13.7 s · 6 Jev calls · 5,461 tokens |
| settings-search-unicode (types `parlaklık`) | passed · 11.0–11.7 s · 6 Jev calls · ≈ 4,680 tokens |

| fill-event-form, real Compose app, UiAutomator2 (19 steps, not saved) | passed · 26.0–33.2 s · 18–21 Jev calls · ≈ 16–19 k tokens |

## Development

```bash
npm test             # vitest
npm run coverage     # thresholds: 80% lines/functions/statements, 70% branches
npm run lint         # biome
npm run jev:smoke    # live Jev check against a recorded screen (needs a key)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT. Device servers are installed at runtime from their upstream releases:
- [appium-uiautomator2-server](https://github.com/appium/appium-uiautomator2-server) (Apache-2.0)
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) (BSD-3-Clause)
