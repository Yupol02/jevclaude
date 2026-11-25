# Contributing

Thanks for helping! Small, focused PRs are easiest to review.

## Setup

```bash
npm install
npm test            # unit tests (no device or key needed)
npm run lint        # biome
npm run typecheck
```

`npm run jev:smoke` checks the live Jev API against a recorded screen. It needs `TYPESAFE_API_KEY` or Cloudflare keys in `.env`.

## Guidelines

- **Tests first.**
  - New parser behaviour gets an XML fixture in `test/fixtures/`.
  - New runner behaviour gets a test using `FakeDriver` / `FakeJev` from `test/helpers.ts`.
- **Deterministic before model.** If a check can be done from the UI tree, don't ask Jev.
- **Untrusted screen text.** Never put screen text into a question's `instructions`; it belongs in `state`.
- **Don't publish numbers you didn't measure.** The benchmark table in the README is filled only from `npm run bench` output.
- **Commits:** imperative subject, explain the why in the body. Run `npm run format` before pushing.

## End-to-end checklist

Run this before a release; unit tests can't cover real devices.

**Android, adb backend (`--backend adb`)**
- [ ] `jevclaude doctor` lists the phone.
- [ ] `run examples/flows/settings-smoke.yaml` passes.

**Android, UiAutomator2 backend**
- [ ] `setup android` succeeds.
- [ ] The snapshot reads in under 500 ms.
- [ ] A flow that types Turkish text (`şğüıöç`) passes.

**iOS**
- [ ] `setup ios` succeeds.
- [ ] `run examples/flows/ios-settings.yaml` passes.

**Behaviour**
- [ ] The second run of the same flow shows `cache` on the natural-language steps and 0 `pick` calls.
- [ ] A broken `expect:` stops as `uncertain`, and `resume_flow pass` continues it.
- [ ] Tapping "Delete account" in a test app is `blocked`.
- [ ] `--html`, `--junit` and `--record` produce their files.
