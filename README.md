# JevClaude

[![npm](https://img.shields.io/npm/v/jevclaude?color=cb3837&logo=npm)](https://www.npmjs.com/package/jevclaude)
[![CI](https://github.com/Yupol02/jevclaude/actions/workflows/ci.yml/badge.svg)](https://github.com/Yupol02/jevclaude/actions/workflows/ci.yml)
[![e2e on emulator](https://github.com/Yupol02/jevclaude/actions/workflows/e2e-android.yml/badge.svg)](https://github.com/Yupol02/jevclaude/actions/workflows/e2e-android.yml)
[![provenance](https://img.shields.io/badge/npm-provenance-2ea44f?logo=sigstore)](https://www.npmjs.com/package/jevclaude#provenance)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/node/v/jevclaude)

**Mobile app testing for Claude Code that doesn't burn your tokens.** Android is verified on a real phone; iOS (simulator) is implemented but still experimental.

Claude decides **what** to test and writes it down as a short plan file (`CihazdaTestEdilecek.md`, `.txt` or `.pdf`) in plain Turkish or English. JevClaude runs the whole plan on the phone in one call and sends back only the results. Steps and device states (is the flashlight on, did a call start, is an alarm set) are read by rules, without a model. [TypeSafe Jev](https://docs.typesafe.ai), a small structured-decision model, makes the remaining fuzzy calls in about 200 ms each:
- which element to tap
- whether the step passed
- whether an error is showing
- whether the action is risky

A replay cache makes re-runs model-free. Claude only hears back when something fails or Jev isn't sure, and it can then decide and **resume the run where it stopped**.

![JevClaude running a 10-step flow on the stock Samsung Calculator: 10/10 passed, 3 Jev calls](docs/demo.gif)


```
Claude Code ──(MCP: run_plan · run_flow / resume_flow)──▶ Runner ──▶ Driver
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

**Measured, same phone, same task** (details in [Benchmark](#benchmark)):

| Task | JevClaude (median) | Plain Claude Code (median) | Per run |
|---|---|---|---|
| Samsung Calculator: 12 × 7, check the preview, clear (3 runs each, all passed) | **4.9 s · ≈ $0.00013** | 52.6 s · ≈ $0.19 | ~11× faster, ~1,400× cheaper |
| Real Compose app: create an event (3 runs each, 2/3 passed each; older JevClaude, slow backend) | 47 s · ≈ $0.0008 | 90 s · ≈ $0.28 | ~1.9× faster, ~350× cheaper |
| Second real app: read-only tour of 4 tabs with a Turkish search (JevClaude 3/3, plain Claude 2/3) | **13.0 s · ≈ $0.00024** | 98.2 s · ≈ $0.36 | ~7.5× faster, ~1,500× cheaper |

All per run, once the flow is written. The samples are small; read the caveats before quoting them.

## Quick start

Prerequisites: Node 20 or newer.
- Android: `adb` and a phone with USB debugging, or an emulator.
- iOS: macOS with Xcode and a booted simulator.

```bash
npm install && npm run build
node dist/cli.js init            # Claude Code skill, .mcp.json, jevclaude.config.yaml, .env
# add TYPESAFE_API_KEY (or CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN) to .env
node dist/cli.js setup android   # optional: UiAutomator2 server → ~0.2 s screen reads + Unicode typing
node dist/cli.js setup ios       # boots a simulator if needed, installs WebDriverAgent
node dist/cli.js doctor          # checks tools, devices, servers and the Jev key
node dist/cli.js run examples/flows/settings-smoke.yaml --html report.html
```

### Use it in your project

1. In your app's repository:
   ```bash
   npx jevclaude init
   ```
   This installs the Claude Code skill (`.claude/skills/device-test/SKILL.md`), registers the MCP server in `.mcp.json`, and creates `jevclaude.config.yaml` and `.env`. It doesn't touch the phone or add example tests.
2. Put `TYPESAFE_API_KEY` and any test-account values (`TEST_EMAIL`, …) in `.env`. Keep it out of git.
3. Connect a phone with USB debugging and run:
   ```bash
   npx jevclaude setup android && npx jevclaude doctor
   ```
4. Open Claude Code in the project and ask, for example: *"cihazda test et: asistana 'feneri aç' yazınca fener açılıyor mu?"*. Claude reads your code for the exact texts, writes `CihazdaTestEdilecek.md`, runs it with `run_plan`, and reports the results. It doesn't drive the phone itself.
5. Keep plans you want to re-run (on every PR or release) in the repo, along with `.jevclaude/cache/`, so re-runs need no model calls for element picks. [examples/ci/github-actions-android.yml](examples/ci/github-actions-android.yml) runs tests in CI.

This repository runs that setup on itself: [e2e-android.yml](.github/workflows/e2e-android.yml) boots an API 34 emulator on GitHub Actions, installs the UiAutomator2 server and runs [ci-emulator-settings.yaml](examples/flows/ci-emulator-settings.yaml). That flow uses exact selectors and two scrolls, needs no Jev key, and passes in about 22 s.

### Use from Claude Code

`init` registers the server in `.mcp.json`. To add it by hand instead:

```bash
claude mcp add jevclaude -- npx -y jevclaude mcp
```

MCP tools:

| Tool | What it does |
|---|---|
| `run_plan` | runs a plan file (`.md`, `.txt`, `.pdf`); one line per passing test, details for the rest |
| `list_devices` | Android devices and booted iOS simulators |
| `snapshot` | the current screen as compact text (cheaper than a screenshot) |
| `run_flow` | runs a YAML flow; returns a short report and, if it stopped, a `run_id` |
| `resume_flow` | `pass` / `retry` / `fail` for the stopped step, then continues without relaunching |

## Test plans

A plan is a list of tests, each a `##` heading with numbered steps. Claude writes it; you can read and edit it too.

```markdown
uygulama: com.example.assistant

## Fener komutu
1. Uygulamayı aç
2. "Yaz ya da konuş" alanına "feneri aç" yaz ve gönder
3. Kontrol: fener açık
4. Kontrol: asistan feneri açtığını söylüyor

## Annemi ara
izin: arama
1. Uygulamayı aç
2. "Yaz ya da konuş" alanına "annemi ara" yaz ve gönder
3. Kontrol: arama başladı
```

```bash
npx jevclaude plan CihazdaTestEdilecek.md --check   # how each line is read, no device needed
npx jevclaude plan CihazdaTestEdilecek.md           # run it (MCP: run_plan)
```

| Line | Becomes |
|---|---|
| `Uygulamayı aç` / `Open the app` | restart the app (each test starts clean) |
| `"Ayarlar"a dokun` / `Tap "Settings"` | tap: exact text first, then cache, then Jev |
| `"Mesaj" alanına "merhaba" yaz ve gönder` / `Type "hi" into "Message" and send` | type (Unicode), optionally press Enter |
| `Geri dön` · `Klavyeyi kapat` · `Aşağı kaydır` · `2 saniye bekle` · `"Tamam" görünene kadar bekle` · `Varsa "Daha sonra"ya dokun` · `Aramayı kapat` | the matching action |
| `Kontrol: fener açık` · `arama başladı` · `alarm 07:00` · `müzik çalıyor` · `Wi-Fi kapalı` · `Bluetooth açık` · `bildirim "…"` | **device state**, read from the phone (`dumpsys` / `settings`), no model |
| `Kontrol: "Kaydedildi" görünüyor` · `Kontrol: "Hata" görünmüyor` | exact screen text, no model |
| `Kontrol: <any other sentence>` | Jev judges the screen (`expect`) |

A line that matches no rule is an error with its line number, so a plan is never half-guessed. All tests run even if one fails.

Checked on a Galaxy S22 Ultra with a real assistant app (not public), on 2026-11-25:
- **"Turn the flashlight on, then off" by typed command:** passed in 16 s with 2 Jev calls (≈ $0.00006). The flashlight was read from the phone both times.
- **"Call a contact":** passed in 18.6 s (≈ $0.00009).
  - The app first asks "arayayım mı?" and switches to voice input, so the plan stops the voice input, waits for the text field and types "evet".
  - The call was confirmed from the phone's call state and ended right away.
  - Getting there took four runs, and each failure showed something real: the app's confirmation question, typing before the text field was back, a USB drop, and an end-call key ignored while dialing. The last one is now retried until the phone reports no call.

**Phone calls are blocked by default.** If an action starts a call in a test without `izin: arama`, the call is ended at once and the step is reported as BLOCKED. With `izin: arama`, the call is ended right after `Kontrol: arama başladı` confirms it. A call still going when a test ends is always ended, but a call that was already going before the test is never touched. `izin: izinler` lets a test grant system permission dialogs.

## YAML flows

Plans compile to YAML flows. You can also write flows directly when you need control the plan format doesn't offer (sub-flows, `if_visible` with `else`, timeouts):


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
jevclaude plan CihazdaTestEdilecek.md                       # run a test plan (.md / .txt / .pdf)
jevclaude plan CihazdaTestEdilecek.md --only "Fener"        # only tests whose title contains "Fener"
jevclaude plan CihazdaTestEdilecek.md --check               # show how the plan is read; no device
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

## Web pages (Chrome)

When Chrome is in front, every screen read also reads the visible tab through Chrome DevTools:
- **Connection:** `adb forward` to Chrome's `chrome_devtools_remote` socket. The tab is picked by the address bar.
- **Reading:** a small in-page script lists visible text, links, buttons and inputs. Elements covered by an overlay are skipped.
- **Mapping:** page elements are mapped to screen pixels and merged into the tree as `Web.a "largest city"`, `Web.input "Search Wikipedia" id=web:searchInput`, …

So `see:`, `wait_for:`, `tap:`, `type:`, `expect:` and Jev's element picks work on page content. Web inputs are typed with DevTools `Input.insertText` and submitted with a DevTools Enter, so Unicode works on any backend.

```yaml
app: com.android.chrome
steps:
  - open: "https://en.wikipedia.org/wiki/Istanbul"   # new tab
  - wait_for: "Istanbul (disambiguation)"
  - tap: { text: "largest city" }                    # scrolls the page if needed
  - tap: { id: "web:searchIcon" }
  - type: { into: "the Wikipedia search input", text: "İstanbul Boğazı", submit: true }
  - expect: "Wikipedia shows an article about the Bosphorus"
```

Full example: [examples/flows/chrome-web.yaml](examples/flows/chrome-web.yaml).

**Results.** It passed 6/6 times on the UiAutomator2 backend at 10.5–12.4 s, and once on the adb backend at 36 s.

**Safety.** Before tapping a web element, the runner checks that the point isn't on the browser's own UI (address bar, menu). If it is, it refuses to tap and stops as `uncertain`. This rule was added after an early build mis-mapped a tap onto Chrome's menu. `JEVCLAUDE_WEB=off` turns web reading off.

## Decisions and thresholds

| Question | How | Rule (configurable in `jevclaude.config.yaml`) |
|---|---|---|
| Which element is "the login button"? | exact match → cache → Jev `choice` over on-screen elements | confidence below 0.6 → `uncertain`; `none` → scroll, then `failed` |
| Does the screen match `expect:`? | Jev `noul` | p ≥ 0.75 passed · p ≤ 0.15 failed · otherwise `uncertain` → Claude. Across two phones, correct screens scored 0.77–0.99 and wrong ones 0.01–0.19. At 0.80, correct Settings-search and Play Store screens on the S23 FE (0.77–0.79) were sent to Claude |
| Is an error or crash visible after an action? | crash logs on failure and at the end; Jev `noul` only when error-like text or a dialog is on screen (`error_check: auto`) | crash or p ≥ 0.85 (`error_fail`) → `failed` |
| Is this tap or type risky (money, install/uninstall, deletion, messaging, account/security)? | Jev `noul`, asked together with the pick and cached once it's known to be safe | p ≥ 0.5 → `blocked` until the user allows it. Play Store "Install" scored 0.81–0.87; back / scroll / screenshots 0.03 |
| Permission dialog? | package / alert detection, button by regex, then Jev | per-flow `permissions:` policy |
| Still loading? | progress-indicator detection | wait up to 15 s |

Screen text is untrusted. It is wrapped in `<<<SCREEN … SCREEN>>>` and every question tells Jev to treat it as data, so text inside the app under test can't steer decisions. Before it leaves the machine, e-mail addresses, phone numbers and card/IBAN-like numbers are masked (`<email>`, `<phone>`, …).

## Status and limits

- **What's verified:**
  - 142 unit tests, all run on recorded Android (uiautomator and UiAutomator2) and iOS (WebDriverAgent) screens.
  - The live Jev API is checked with `npm run jev:smoke`.
  - **Android, real device:** Samsung Galaxy S22 Ultra, Android 16, Turkish UI. Verified there:
    - both backends, the replay cache and `run_flow` → `resume_flow` over MCP
    - a production Jetpack Compose app, including Unicode typing into Compose fields and date/time fields that have no accessibility label
    - stock apps: Calculator, Clock, Settings and Play Store, all passing 3/3 at 4.6–7.7 s per run
    - negative controls: wrong expectations fail at p = 0.01
    - the risk guard on a real Play Store page: "Install" is blocked, harmless actions are allowed (asked without tapping)
    - results are below
  - **A second phone:** Samsung Galaxy S23 FE, Android 16, Turkish UI. The same stock flows plus [chrome-web.yaml](examples/flows/chrome-web.yaml) pass there; see [Second phone](#second-phone-and-maestro-galaxy-s23-fe).
  - **An emulator in CI:** every push to `main` that touches `src/` runs [a Settings flow](examples/flows/ci-emulator-settings.yaml) on an API 34 emulator, without a Jev key.
- **What's not verified yet:**
  - **Test plans through Claude Code itself.** Plans ran on a real phone through the CLI, but the shipped skill + `run_plan` loop (Claude writes the plan and calls the tool) hasn't been tried end to end yet.
  - **Some device checks on real hardware:** media and notification checks are covered by unit tests on assumed `dumpsys` formats only. The flashlight was checked on a Galaxy S22 only. Pressing end-call again while a call is still dialing is new and untested on a phone.
  - **Device checks on iOS:** not supported.
  - iOS on a live simulator.
  - Permission dialogs on a device (covered by unit tests only).
  - See the [e2e checklist](CONTRIBUTING.md#end-to-end-checklist).
- **Jev's weak spots:** counting, arithmetic and multi-hop reasoning. Check numbers with `see:`.
- **Literal reading:** Jev takes wording literally. "Results are shown *under* the search field" correctly scored 0.19 on a phone whose search bar sits *below* the results. Describe what must be true, not where it is.
- **Text-only:** canvas, games and Flutter apps without semantics produce empty trees. Those need Claude with screenshots.
- **Web pages in Chrome are read through Chrome DevTools** (see [Web pages](#web-pages-chrome)), because Chrome's accessibility tree exposes page content only some of the time. WebViews inside other apps aren't covered yet: they need `WebView.setWebContentsDebuggingEnabled(true)` and a per-app socket.
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

### Second phone and Maestro (Galaxy S23 FE)

The flows were written on the S22 Ultra and run unchanged on a Galaxy S23 FE (Android 16, Turkish UI) on 2026-11-25. The first runs there found five bugs, all fixed in the next release (see the [changelog](CHANGELOG.md)). Results with the fixes:

| Flow | Runs passed | Time per run |
|---|---|---|
| [samsung-calculator](examples/flows/samsung-calculator.yaml) | 5/5 | 6.7–7.8 s |
| [samsung-stopwatch](examples/flows/samsung-stopwatch.yaml) | 1/1 | 6.3 s |
| [settings-search-unicode](examples/flows/settings-search-unicode.yaml) | 1/1 | 7.0 s |
| [settings-smoke](examples/flows/settings-smoke.yaml) | 3/3 | 8.2–8.7 s |
| [playstore-search](examples/flows/playstore-search.yaml) | 1/1 | 6.4 s |
| [chrome-web](examples/flows/chrome-web.yaml) | 5/6 | 11.0–16.1 s |

The one Chrome failure: the search icon was tapped, but the search box never opened. It happened while several identical test tabs were open; with those closed, the next 3 runs passed. The cause isn't confirmed.

Chrome auto-translated Wikipedia into Turkish on this phone, so the flow names things by role ("the link about the largest cities") instead of by English text. Web links also carry their target path (`link to /wiki/List_of_largest_cities…`), which survives translation.

**Maestro 2.12.1, same phone, same Calculator steps** (`tapOn` by resource id, `assertVisible: "84"`. Neither needed Claude; JevClaude made one Jev call per run):

| | Runs passed | Flow time | Wall time incl. startup |
|---|---|---|---|
| Maestro | 4/5 (run 1 failed its first tap) | 26.2–26.5 s | 60–63 s |
| JevClaude | 5/5 | 6.7–7.8 s | 8.6–10.2 s |

Maestro waits for animations to finish after every command, and its wall time includes starting its driver on each run. JevClaude's startup took about 2 s per run, and after each step it re-reads the screen only until two reads agree.

### 0.3.0 final check (stock apps, same phone, stable cable)

Each flow was run 3 times; run 1 had a cold cache for new flows. All 15 runs passed.

| Flow | Time per run | Jev calls | Notes |
|---|---|---|---|
| [samsung-calculator](examples/flows/samsung-calculator.yaml) | 4.6–5.4 s | 3–6 | |
| [samsung-stopwatch](examples/flows/samsung-stopwatch.yaml) | 5.0–6.3 s | 0–5 | includes a 1.5 s `wait` |
| [settings-search-unicode](examples/flows/settings-search-unicode.yaml) | 4.7–7.7 s | 1–3 | types `parlaklık` |
| [settings-smoke](examples/flows/settings-smoke.yaml) | 5.8–6.3 s | 3–6 | 3 scrolls |
| [playstore-search](examples/flows/playstore-search.yaml) | 5.1–5.4 s | 1 | `expect` scored 0.82–0.84: `uncertain` at the old 0.85 threshold, passed at 0.80 |

Negative controls: "the result preview shows 85" on a screen showing 84, and "a WhatsApp chat is open" in Settings, both failed at p = 0.01. One earlier Play Store run stopped with "error visible": the store really showed "Bir sorun oluştu / Sunucu hatası" (a server error), and the next runs passed.

### Stock app: JevClaude vs plain Claude Code (0.2.5)

Task: in Samsung Calculator, enter 12 × 7 with the on-screen keys, check that the live preview shows 84 *without* pressing "=" (so nothing goes into the calculator history), then clear. Plain Claude Code (`claude -p`, adb only, screenshots allowed) got the same instructions. Each method ran 3 times on 2026-11-25 on a Galaxy S22 Ultra.

| | JevClaude ([samsung-calculator.yaml](examples/flows/samsung-calculator.yaml); run 1 cold cache) | Plain Claude Code |
|---|---|---|
| Passed | 3/3 | 3/3 (by its own report; each said it never pressed "=") |
| Run times | 5.5 · 4.9 · 4.9 s | 53.6 · 52.6 · 39.2 s |
| **Median** | **4.9 s** | **52.6 s** |
| Tokens per run | 3.2–9.4 k (Jev) | 0.48–0.78 M (Claude, mostly cache reads) |
| **Median cost** | **≈ $0.00013** | **≈ $0.19** |
| Model | jev-1.14.0, 3–6 calls | claude-sonnet-5-5, 15–18 turns |

Plain Claude read the screen with `uiautomator dump` (~2.3 s per read) and spent a model turn on every step. JevClaude replays a cached flow: three of its ten steps are exact ids, and only the risk check and the one `expect:` reach Jev.

### Real app: JevClaude vs plain Claude Code

On 2026-11-25 the same task was run 3 times with each method on a Galaxy S22 Ultra (Android 16). The task is "add a new event": title, date picker (30 Nov 2026), content, time picker (18:00), then *create*, then check it is listed. The app is a real Jetpack Compose app that isn't public, so its screens aren't shown here.

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

### Second real app: read-only tour (Galaxy S23 FE)

On 2026-11-25 each method ran the same task 3 times on a Galaxy S23 FE (Android 16, Turkish UI), with the UiAutomator2 backend and the current code. The app is a real assistant-style Jetpack Compose app that isn't public, so its name and screens aren't shown here. The task changes nothing:
1. Open the app and check the chat home screen.
2. Check the sections of the "today" tab.
3. Check the routine templates.
4. In settings, search for `kişilik` (Turkish ş and ı), and check that only the matching setting is listed.
5. Open that setting, check its three options, and go back.

After every run, a separate read-only check confirmed that the app's settings, routines and "messages sent to the cloud" counter were unchanged.

| | JevClaude (run 1 cold cache, runs 2–3 warm) | Plain Claude Code (`claude -p`, adb + screenshots) |
|---|---|---|
| Passed | **3/3** | 2/3 (by its own report) |
| Run times (wall) | 12.2 · 13.0 · 14.6 s | 101.0 · 98.2 · 90.4 s |
| **Median time** | **13.0 s** | **98.2 s** |
| Tokens per run | 4.8–6.9 k (Jev) | 1.1–1.6 M (Claude, mostly cache reads) |
| **Median cost** | **≈ $0.00024** | **≈ $0.36** (range $0.31–0.37) |
| Model | jev-1.14.0, 6–8 calls | claude-sonnet-5-5, 36–43 turns |

What this does and doesn't show:
- **Plain Claude's failure was typing.** `adb input text` can't type ş or ı. In run 1 it typed `kisilik`, the app's search found nothing, and it gave up on that step. In runs 2–3 it typed the word key by key on the on-screen keyboard. JevClaude types Unicode through UiAutomator2.
- **The flow was tuned once.** It passed on its first try, and one `expect:` was then reworded because the news section was still loading (p = 0.76). Writing the flow isn't counted in the table.
- **One check is borderline.** The "today" screen check scored exactly 0.75, the pass threshold, in two of the three runs.
- **The sample is small:** one app, one task, 3 runs each.

### Stock apps (Samsung, Turkish UI)

Each flow was run 3 times on the same phone with the UiAutomator2 backend. Run 1 has a cold cache; runs 2–3 are warm. None of them leaves data behind: the calculator never presses "=", so nothing goes into its history, and the stopwatch is reset and the app returned to its Alarm tab.

| Flow | Passed | Time | Jev calls | Tokens | Cost / run |
|---|---|---|---|---|---|
| [samsung-calculator.yaml](examples/flows/samsung-calculator.yaml): 12 × 7, check the preview shows 84 | 3/3 | 13.7–14.9 s | 10–13 | 10–16 k | ≈ $0.0004–0.0007 |
| [samsung-stopwatch.yaml](examples/flows/samsung-stopwatch.yaml): start, stop, reset, back to Alarm | 3/3 | 13.9–15.5 s | 6–11 | 4.5–10 k | ≈ $0.0002–0.0004 |
| [settings-search-unicode.yaml](examples/flows/settings-search-unicode.yaml): search Settings for `parlaklık` | 3/3 | 14.7–15.9 s | 6–8 | 4.6–6.7 k | ≈ $0.0002–0.0003 |

#### Speed work: about 2× faster per run

Profiling the calculator run (13.9 s) showed that most of the time went to waiting and checking, not to deciding:

| Where the time went (before) | | Change |
|---|---|---|
| UiAutomator2 waited for the UI to go idle before every read | 283 ms/read | `waitForIdleTimeout: 0`; the runner checks stability itself (two identical reads, digits ignored) |
| Fixed settle sleep after every action | 350 ms | 100 ms on fast drivers (`fast_settle_ms`) |
| "Is an error visible?" Jev call after every action | ~240 ms each | `error_check: auto` asks only when error-like text (error, failed, hata, tekrar dene, …) or a dialog is on screen; `always` keeps the old behaviour |
| Keyboard probe (`dumpsys input_method`) before taps in the lower half | ~250 ms each | only after a text field was tapped or typed into |
| `logcat` crash check after every step | ~90 ms each | on a failing step and once at the end |
| Taps and swipes through `adb shell input` | ~120 ms per tap | through the UiAutomator2 server (`gestures/click`, W3C actions): ~65 ms; adb as fallback |
| A confirmation read after every action | ~125 ms | skipped when the first read shows the same structure as before the action (only digits changed, e.g. a calculator key). If the next target is then missing, the screen is re-read once before Jev or scrolling is involved |

Results with a warm cache, 3 runs each, same phone:

| Flow | Before | Round 1 | Round 2 (taps via server, quick settle) | Jev calls before → after |
|---|---|---|---|---|
| samsung-calculator | 13.7–14.9 s | 5.7–7.4 s | **5.1–5.9 s** | 10 → 3 |
| samsung-stopwatch (includes a 1.5 s `wait`) | 13.9–15.5 s | 6.2–6.5 s | **5.7–6.2 s** | 6 → 0 |
| settings-search-unicode | 14.7–15.9 s | 6.6–7.7 s | **6.4–7.0 s** | 6 → 1 |
| settings-smoke (3 scrolls) | 13.7 s | — | **6.5–7.3 s** | 6 → 3 |

**Round 2 reliability.** Round 2 counted 18 passes in 21 runs. The other 3 runs, plus one 19.5 s outlier, coincided with USB reconnects: adb's `transport_id` went from 9 to 29 during the session. A reconnect kills the UiAutomator2 server. The driver now retries the start once, then falls back to `uiautomator dump`, but the dump can't type Unicode, so those runs stop with a clear error. With a stable cable, 6 back-to-back calculator runs all passed in 5.5–5.7 s.

Two notes on this run:
- **Step time is now mostly the device.** About 0.5 s per step goes to the screen read (~125 ms), the tap (~65 ms) and the app's own reaction. Jev is involved only on cache misses, risk checks and `expect:`.
- **A dead UiAutomator2 server slowed every read.** One stopwatch run right after a USB reconnect took 92 s, because the server had died and each read timed out before falling back. The driver now restarts the server once, or switches to `uiautomator dump` for the rest of the run. Killing the server mid-run on purpose now costs about 1 s; the run still passed in 5.8 s.
- **The real-app comparison above predates these changes.** It was also measured on the slow adb backend, so it hasn't been re-run with them.

These pass rates came after fixes. The first attempts surfaced two JevClaude bugs and two badly written flow steps:
- **Bug: selected tabs.** A tab that is already selected isn't marked clickable, so "the Stopwatch tab" found nothing. Fixed: selected elements are now tap candidates.
- **Bug: running timers.** A running timer changes the screen on every read, so the runner waited for its settle cap after every action, up to 26 s for one step. Fixed: settling ignores digits; the worst step is now about 3 s.
- **Flow wording: two claims in one `expect`.** "shows 12×7 and 84" scored 0.70–0.76 because the app writes "12 Çarpı 7". One claim ("the preview shows 84") passes.
- **Flow wording: number comparisons.** "stopped and shows a time greater than zero" scored 0.73–0.83 on a correct screen. Even "The stopwatch is paused" scored only 0.80–0.83. `see: "Sürdür"`, the Resume button that only exists while paused, is exact. When a state has a visible label, check the label.

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
