# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
