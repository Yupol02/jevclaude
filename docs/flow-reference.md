# Flow reference

A flow is a YAML file: a header, then `steps`. Steps run top to bottom. The run stops at the first step that is not `passed`, unless that step is `optional`.

## Header

| Key | Required | Meaning |
|---|---|---|
| `app` | yes | Android package (`com.example.shop`) or iOS bundle id (`com.apple.Preferences`) |
| `name` | | Shown in reports |
| `platform` | | `android` or `ios`. Needed only when both kinds of device are connected |
| `fresh_start` | | Stop the app before the first step |
| `permissions` | | `allow`, `deny`, or `stop` (default). What to do when a system permission dialog appears |
| `env` | | Default values for `${VAR}`. Environment variables override them |
| `tags` | | Used by `jevclaude run --tag NAME` |

## Steps

### Actions

| Step | Example | Notes |
|---|---|---|
| `launch` | `- launch` / `- launch: com.other.app` | Waits for the screen to settle, then checks the app is in the foreground |
| `open` | `- open: "https://example.com/page"` / `- open: "myapp://orders/42"` | Opens a URL or deep link in the flow's app (Android VIEW intent, iOS WebDriverAgent `/url`). In Chrome it opens a new tab |
| `stop` | `- stop` | Force-stops or terminates the app |
| `tap` | `- tap: "Log in button"` | Natural language: exact label, then cache, then Jev. Scrolls to find the target (`scroll: false` disables this) |
| | `- tap: { id: btn_login }` | Exact selector: `id` (resource-id / accessibility id), `text`, `desc`, or a combination |
| `type` | `- type: { into: "email field", text: "${EMAIL}", submit: true }` | Taps the field, then types. `submit` presses Enter afterwards |
| `swipe` | `- swipe: up` | `up`, `down`, `left`, `right`. Content moves the other way |
| `key` | `- key: enter` | `enter`, `back`, `home`, `tab`, `delete`, `search`, or an Android `KEYCODE_*` |
| `back` | `- back` | iOS: navigation-bar back button, or an edge swipe |
| `hide_keyboard` | `- hide_keyboard` | |
| `wait` | `- wait: 500` | Milliseconds. Prefer `wait_for` |

### Checks

| Step | Example | Decided by |
|---|---|---|
| `see` | `- see: "Welcome"` | Deterministic. Some element's text, description or child text contains the string (case-insensitive). Retried for 6 s |
| `not_see` | `- not_see: "Error"` | Deterministic |
| `wait_for` | `- wait_for: "Home"` | Deterministic. Like `see`, with a 10 s window |
| `expect` | `- expect: "Cart shows the red sneakers"` | Jev. p ≥ 0.75 passes, p ≤ 0.15 fails, anything between is `uncertain`. Re-asked only when the screen changes |

### Control

| Step | Example |
|---|---|
| `if_visible` | `- if_visible: "Rate us"` with `then: [ { tap: { text: "Later" } } ]` and an optional `else: [...]` |
| `run` | `- run: flows/login.yaml`. Inlines another file's steps (path relative to this file). A sub-flow can be a bare list of steps |
| `allow_risky` | `- allow_risky: true`. Lets the next tap or type run even if Jev flags it as risky. **Only add this when a person approved that action.** |

### Modifiers

`tap`, `type`, `see`, `not_see`, `wait_for` and `expect` accept two modifiers:
- `optional: true`: a failure is reported but doesn't stop the flow.
- `timeout: <ms>`: overrides the retry window.

```yaml
- see: "Promo"
  optional: true
  timeout: 2000
```

## Web pages

In Chrome, page content is read through Chrome DevTools and appears as `Web.<tag>` elements (`Web.a`, `Web.button`, `Web.input`, `Web.p`, …). Ids come from the page's `id` / `name` attributes, prefixed with `web:` (e.g. `tap: { id: "web:searchIcon" }`). Only what is visible is listed; elements under an overlay are skipped; `tap:` scrolls the page to find a target.

## Variables

`${NAME}` is replaced from the environment (including `.env`) and then from the flow's `env:`. A missing variable fails the step with a clear message. Keep credentials in `.env`, never in flow files.

## Writing good flows

- **Exact selectors are free.** When you know an id or exact text (from the app's source), use `{ id: ... }` or `see:`.
- **Use natural language** for targets whose text changes, or that you can only describe ("the first product card").
- **Check numbers with `see:`.** Jev is weak at counting and arithmetic.
- **Unlabeled fields:** tap targets with no label are shown to Jev with `near="…"`, the text they touch. "the date field" can then match a field whose only visible text is "Tarih boş olamaz". Prefer adding a real `contentDescription` / `semantics` label to the app.
- **Describe what must be true, not where it is.** Jev reads literally: "results under the search field" fails on a phone whose search bar is at the bottom.
- **Keep `expect:` to one checkable claim.** "Home screen with the user's name at the top" is good. "Everything looks right" is not.
- **Commit `.jevclaude/cache/`** so CI re-runs need no model calls for element picks.
