# Architecture

```
src/
  core/uitree.ts       platform-neutral UiElement / UiSnapshot, compact description, selectors, hash + fingerprint
  core/xmlwalk.ts      order-preserving XML → tree (tags may be class names)
  driver/types.ts      Driver interface (snapshot, tap, swipe, typeText, keys, launch/stop, crash logs, screenshot, recording)
  driver/android/      adb wrapper, UiAutomator2 server client, uiautomator/UIA2 XML parser, AndroidDriver
  driver/ios/          WebDriverAgent client, simctl helpers, WDA XML parser, IosDriver
  driver/select.ts     device discovery and choice (adb devices + booted simulators)
  jev/                 Jev API clients (TypeSafe, Cloudflare), usage meter, question templates
  engine/flow.ts       flow schema (zod), sub-flow inlining, ${VAR} interpolation
  engine/cache.ts      replay cache (.jevclaude/cache/<app>.json)
  engine/runner.ts     the step loop: resolution layers, settle/wait, guards, pause/resume
  report/              text (for Claude), HTML, JUnit
  maestro/convert.ts   Maestro ⇄ jevclaude
  session.ts           wires config + driver + Jev + cache + reports for one run
  mcp/server.ts        MCP tools: list_devices, snapshot, run_flow, resume_flow
  cli.ts, setup.ts     CLI, setup android/ios, doctor, init
```

## One step, end to end

1. **Read the screen.** The driver returns XML; a parser turns it into `UiElement`s.
   - Only meaningful nodes are kept: actionable, labelled, or progress indicators.
   - Text inside clickable containers is lifted onto the container, so a card reads as one element.
   - The snapshot is reused until an action invalidates it.
2. **Resolve the target** (tap/type). The layers are tried in order and stop at the first hit:
   1. exact selector or label (free)
   2. replay cache (free; re-resolved if the selector is gone, and the result is marked `healed`)
   3. one Jev request asking `pick` (choice over up to 254 elements plus `none`) and `risk` (noul) in parallel
   4. if nothing matches and the screen can scroll: swipe and repeat, up to `max_scrolls` times
3. **Guard.** A risk at or above `risk_block` stops the step as `blocked`. `allow_risky` lets the next action through.
4. **Act.** Tap the element's center. When typing, tap first, then type, Unicode included where the driver supports it.
5. **Settle.**
   - Wait while a progress indicator is visible.
   - Fast drivers (UiAutomator2, WebDriverAgent) wait for two identical reads in a row.
   - The slow `uiautomator dump` re-reads only while the screen hasn't changed yet.
6. **After-checks.**
   - Permission dialog, handled by the `permissions:` policy.
   - Crashes, via logcat or iOS crash reports.
   - Optionally, Jev's "is an error visible?" check.

## Pause and resume

The runner keeps a queue of pending steps. When a step stops, it stays at the head of the queue and the run returns with `resumable: true`. The MCP server keeps that session for 30 minutes, and `resume_flow` continues it:
- `pass`: accept the step, marked `decidedBy: claude`, and continue
- `retry`: run the step again
- `fail`: finish the run as failed

The app is not relaunched.

## Why text, not screenshots

Accessibility trees are about 1–3k tokens per screen, deterministic to diff and hash, and carry ids that become free selectors. Jev's image input is still beta. The cost is that screens without accessibility nodes (canvas, games) are invisible. For those, the run stops and Claude takes over with screenshots.

## Trust boundary

Screen text comes from the app under test, so it is untrusted:
- It is wrapped in `<<<SCREEN … SCREEN>>>`, and every question says to treat it as data.
- The risk guard can't be turned off from MCP; only the CLI flag or config can do that.
- `allow_risky` is a flow step, so a person can see it in review.
