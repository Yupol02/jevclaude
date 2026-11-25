# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.5.0] — 2026-11-25

Not yet verified: the skill + `run_plan` loop driven by Claude Code itself, media and notification checks on a real phone, and the end-call retry on a phone (see the README's status section).

### Added
- **Test plans:** Claude Code writes `CihazdaTestEdilecek.md` (or `.txt` / `.pdf`) in plain Turkish or English, and JevClaude runs it in one call (`run_plan` over MCP, `jevclaude plan` on the CLI).
  - Each `## Title` is a test, and its numbered lines become steps by rules, without a model call.
  - A line that matches no rule is reported with its line number.
  - All tests run even if one fails. Passing tests take one line in the report; failing ones come with the step, the reason, the screen and a screenshot.
  - `--check` shows how the plan will be read without touching a device.
- **Device-state checks (`device:` step, `Kontrol: fener açık` in plans).** Android reads them from the phone: flashlight, phone call, next alarm, media playback, Wi-Fi, Bluetooth, airplane mode, posted notifications and the foreground app. Facts the screen doesn't show reliably can now be checked without a model.
- **Phone-call guard (`calls: block | allow`).**
  - Plans block calls unless a test says `izin: arama`.
  - A blocked call is ended at once and the step is reported as blocked.
  - An allowed call is ended right after the check confirms it.
  - A call still going when a test ends is ended, but a call that was already going before the test is never touched.
  - The end-call key is pressed again until the phone reports no call: a Galaxy S22 ignored it while the call was still dialing.
  - Call checks wait 20 s, because an assistant may ask and dial first.
  - Ending a call is noted in the report.
- **The Claude Code skill ships with the package.** `jevclaude init` installs it as `.claude/skills/device-test/SKILL.md` and registers the MCP server in `.mcp.json`.

### Changed
- **`jevclaude init` no longer creates `flows/smoke.yaml`** and never touches a device. The repository's own `test-feature` skill is replaced by the shipped `device-test` skill.

## [0.4.1] — 2026-11-25

### Added
- **The repository runs JevClaude on itself in CI:** `.github/workflows/e2e-android.yml` boots an API 34 emulator on GitHub Actions and runs `examples/flows/ci-emulator-settings.yaml` without a Jev key. It passes in about 22 s.

- **Web links show where they go** (`link to /wiki/List_of_largest_cities…`, path only: query strings and fragments are dropped). Chrome's auto-translate renames link text; the target stays the same.

### Changed
- **`expect:` passes at p ≥ 0.75 (was 0.80).** On a second phone (Galaxy S23 FE), correct Settings-search and Play Store screens scored 0.77–0.83 and were sent to Claude at 0.80. Wrong screens stayed at 0.01–0.19 on both phones.
- **Exact selectors (`{ id: … }`, `{ text: … }`) never fall back to Jev.** On a translated page, Jev picked a "similar" link and the flow tapped the wrong one. They are searched and scrolled to deterministically, then fail plainly.
- **The screen fingerprint ignores field contents and numbers,** so the replay cache keeps working when a counter, tab count or formula changes. On the S23 FE, a flow that needs 3 Jev calls had been making 6.

### Fixed
- **Exact text selectors match title + summary list rows.** A clickable row lifts its children's texts into one string ("Network & internet · Mobile, Wi-Fi, hotspot"), so `{ text: "Network & internet" }` never matched it. Found by the emulator run.
- **Taps avoid nested controls.** A tap aimed at a container's centre hit Chrome's voice-search mic inside the search box; the tap point now moves sideways to a spot no inner clickable covers.
- **After a launch or URL open, the screen must hold still for 0.7 s.** Samsung Calculator's keypad slides in, pauses ~300 ms, then moves again, so two identical reads weren't enough and the first key tap hit "%". Element positions now count towards "settled", not only text. Launches are about 0.7 s slower.
- **After scrolling to find a target, the runner waits for the list to stop** before tapping. A fling still coasting made a Settings tap land on the row above "About phone".
- **`open:` wakes the phone and checks that it is unlocked,** like `launch` does, instead of opening the URL behind the lock screen.
- **UiAutomator2 port forwards are removed at the end of a run.** Each run left an `adb forward` behind; about 60 had piled up on the test phone.

## [0.4.0] — 2026-11-25

### Added
- **Web pages in Chrome through Chrome DevTools.** Chrome's accessibility tree exposes page content only some of the time; it showed an empty "Web View" for a Wikipedia article. When Chrome is in front, the driver:
  - reads the visible tab over `adb forward` to `chrome_devtools_remote`
  - merges visible text, links, buttons and inputs into the tree as `Web.*` elements, mapped to screen pixels and skipping elements under overlays
  - types into web inputs and presses Enter through DevTools, so Unicode works on any backend

  On a Galaxy S22 Ultra, [chrome-web.yaml](examples/flows/chrome-web.yaml) (read, tap a link below the fold, Unicode search, close the tab) passed 6/6 times at 10.5–12.4 s, and once on the adb backend.
- **`open:` step** opens a URL or deep link in the flow's app: an Android VIEW intent, or WebDriverAgent `/url` on iOS. Maestro's `openLink` converts to it.

### Changed
- **A cached selector is used directly only on the screen where it was learned** (same fingerprint). On another screen, Jev confirms it first. Chrome's tab list had made the cache type into "search your tabs" instead of the address bar.
- **Targets are searched upwards after downwards,** e.g. for a toolbar that hides on scroll.

### Fixed
- **Web elements map onto the right pixels.** The page is anchored at the bottom of its container and never placed under a visible toolbar; an early build tapped Chrome's menu instead of a page link. As a last check, the runner refuses to tap a web element whose point lands on native browser UI.
- WebView nodes are kept in the Android tree even when unlabeled.

## [0.3.0] — 2026-11-25

The final round of hardening, checked on Calculator, Clock, Settings and Play Store (15/15 runs passed, 4.6–7.7 s each) plus two negative controls.

### Changed
- **`expect:` passes at p ≥ 0.80 (was 0.85).** On the phone, correct screens scored 0.70–0.98 (mostly ≥ 0.80) and wrong ones 0.01–0.19. At 0.85, correct screens kept landing at 0.82–0.84 and were sent to Claude.
- **The error check has its own threshold,** `error_fail: 0.85`, so it doesn't get more sensitive along with `pass`.
- **Installing, updating or uninstalling an app counts as risky.** A real Play Store "Install" button went from p = 0.08–0.12 (allowed) to 0.81–0.87 (blocked); back, scroll and screenshot taps stayed at 0.03.

### Added
- **Personal-data masking in what is sent to Jev:** e-mail addresses, phone numbers and card/IBAN-like numbers. A Play Store screen had put the signed-in account's e-mail into the Jev state.
- **A clear message when a web view's content isn't exposed** to UiAutomator: Chrome showed only an empty "Web View" for a Wikipedia article. This is documented as a known limit.
- `examples/flows/playstore-search.yaml`.

### Fixed
- Numeric character references in the UI tree (e.g. `&#10;` inside a content description) are decoded.

## [0.2.5] — 2026-11-25 (tagged but not published to npm; included in 0.3.0)

### Changed
- **UiAutomator2 sessions set `ignoreUnimportantViews`.** On the four apps measured, reads were 15–60 ms faster with the same elements. `JEVCLAUDE_FULL_TREE=1` turns it off.
- **Launch prep runs in parallel:** clearing logs and force-stopping the app.
- **The release workflow falls back to an `NPM_TOKEN` secret** when no npm Trusted Publisher matches the repository (e.g. after the repository is recreated). Provenance is signed either way.

### Added
- **README: stock-app benchmark against plain Claude Code.** Samsung Calculator, 3 runs each, all passed: median 4.9 s and ≈ $0.00013 for JevClaude, against 52.6 s and ≈ $0.19 for `claude -p` with adb.

## [0.2.4] — 2026-11-25

Found by testing stock Samsung apps (Calculator, Clock, Settings); all three example flows now pass 3/3.

### Fixed
- **Selected tabs or items can be tapped by description.** They are often not marked clickable, so "the Stopwatch tab" found nothing when that tab was already selected.
- **Running timers, clocks and counters no longer stall the runner.** Settling compared full screen text, so a ticking number kept the screen "unstable" until the cap after every action. Settling now ignores digits (`settleHash`); the worst stopwatch step went from 26 s to about 3 s.

### Changed: speed, about 2× faster per run on stock apps
- UiAutomator2 sessions set `waitForIdleTimeout: 0`. The server no longer waits for animations before each read; the runner's stability check (two identical reads, digits ignored) does that job. Average read time went from 283 ms to 125 ms.
- Settle sleep on fast drivers is 100 ms (`fast_settle_ms`) instead of 350 ms.
- New `error_check: auto` (default) asks Jev whether an error is visible only when error-like text or a dialog is on screen. `always` restores the old per-action check.
- The keyboard probe only runs after a text field was used. Crash logs are read on a failing step and at the end, instead of after every step.
- If the UiAutomator2 server stops answering mid-run (e.g. after a USB reconnect), it is restarted once, or the run falls back to `uiautomator dump`. Before, every read waited for a timeout (one run took 92 s).
- **Taps and swipes go through the UiAutomator2 server** (`gestures/click`, W3C actions; ~65 ms vs ~120 ms for `adb shell input`), with adb as fallback.
- **The confirmation read is skipped** when the first read after an action shows the same structure as before (only digits changed). If the next step can't find its target on such an unconfirmed screen, the runner re-reads once before asking Jev or scrolling.
- **UiAutomator2 startup is retried once** after stopping a stale server (seen after USB reconnects).
- Results: calculator 13.7–14.9 s → 5.1–5.9 s; stopwatch 13.9–15.5 s → 5.7–6.2 s; Settings search 14.7–15.9 s → 6.4–7.0 s; Settings with 3 scrolls 13.7 s → 6.5–7.3 s.

### Added
- `examples/flows/samsung-calculator.yaml` and `examples/flows/samsung-stopwatch.yaml`; neither leaves data behind.

### Removed
- The demo GIF, which showed screens of a private app.

## [0.2.3] — 2026-11-25

Bugs and gaps found by testing a real Jetpack Compose app on a Galaxy S22 Ultra; JevClaude vs plain Claude Code numbers are in the README.

### Fixed
- **UiAutomator2 can type into Compose text fields.** These fields often report no focus, so "type into the focused element" failed with `no such element`. The runner now passes the tapped field to the driver, which sets its text by exact bounds, then falls back to the focused element, then to `adb input text` (ASCII only).
- **A UiAutomator2 server left running no longer breaks the adb backend.** The adb path stops it on connect, and retries a failed `uiautomator dump` once after stopping it.
- **`uiautomator dump` exit codes:** a non-zero exit is no longer treated as a failure when the dump was written. Seen on Samsung / Android 16.

### Added
- **Unlabeled tap targets** get a `near="…"` hint from the labelled element they touch, and Jev is told what it means. On the test app, "the date field" was picked at 0.87–1.00 confidence, and "the time field" went from 0.52 (paused) to 0.98.
- **Taps under the keyboard:** when the target sits in the lower half of the screen and the keyboard is up, the keyboard is hidden first and the element is re-located.
- **README:** demo GIF, a real-app benchmark against plain Claude Code, and a "Use it in your project" section.

## [0.2.2] — 2026-11-25

First real-device run (Samsung Galaxy S22 Ultra, Android 16): both example flows pass; measured numbers are in the README.

### Fixed
- `launch` is more reliable on Android: it starts the resolved launcher activity with `am start -W`, wakes the screen, reports a locked phone clearly, and waits up to 10 s (`launchTimeoutMs`) for the app to reach the foreground. Before, a slow cold start was reported as a failure.
- With a replay-cache entry, scrolling to find a target no longer asks Jev on every screen. Intermediate screens are searched deterministically, and Jev is asked only on the first screen and when the list ends. The risk question is asked only when an action is about to happen.
- The CLI no longer prints the MCP-only `resume_flow` hint.

### Added
- `examples/flows/settings-search-unicode.yaml`, a Unicode typing check on any Android phone.

## [0.2.1] — 2026-11-25

### Changed
- Releases publish through npm Trusted Publishing (OIDC); the `NPM_TOKEN` secret is no longer used.
- GitHub Actions updated to `actions/checkout@v7` and `actions/setup-node@v7`; CI also tests Node 24.

## [0.2.0] — 2026-11-25

### Added
- **iOS simulator support** through WebDriverAgent (`setup ios` installs a pinned prebuilt build) and `simctl`: video, screenshots, crash reports.
- **Android UiAutomator2 backend.** Screen reads take about 0.2 s and typing supports Unicode (Turkish included). Install it with `setup android`; the `uiautomator dump` fallback remains.
- **Replay cache** in `.jevclaude/cache/<app>.json`. Re-runs need no model calls for element picks; if a cached selector is gone, the target is re-resolved and the step is reported as `healed`.
- **Auto-scroll** to find tap and type targets. Progress indicators are detected and waited out.
- **Flow language v2:**
  - `wait_for`, `if_visible` / `then` / `else`, `run:` sub-flows, `stop`, `hide_keyboard`
  - per-step `optional` and `timeout`
  - flow-level `env`, `tags` and `platform`
- **Permission dialog policy** (`permissions: allow | deny | stop`).
- **Pause and resume.** `run_flow` keeps a stopped run alive and the new MCP tool `resume_flow` (`pass | retry | fail`) continues it without relaunching.
- **Reports:** self-contained HTML (timeline, Jev probabilities, screenshots), JUnit XML, `--trace` per-step screenshots, `--record` video.
- **CLI:**
  - `doctor`, `init`, `setup android|ios`, `import-maestro`, `export-maestro`
  - multi-file and directory runs, `--devices` for parallel devices, `--tag` filtering
- **`jevclaude.config.yaml`**, validated with zod.
- **Project tooling:** Biome lint and format, coverage thresholds, release workflow, issue and PR templates, docs.

### Changed
- The `Device` interface became `Driver`, and parsers are platform-specific.
- Fewer screen reads per step: snapshots are reused until an action happens.

## [0.1.0] — 2026-11-25

### Added
- Android runner over adb with TypeSafe Jev decisions (element pick, step passed, error visible, risk guard), MCP server, CLI, text reports.
