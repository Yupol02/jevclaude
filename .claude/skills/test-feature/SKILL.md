---
name: test-feature
description: Test a feature of the mobile app (Android phone or iOS simulator) with the jevclaude MCP server — write a flow, run it in one call, read only the short report, resume if it pauses. Use when the user asks to test, check or verify an app feature on a device.
---

# Test a feature on the device (jevclaude)

Goal: verify the feature with as few of your own tokens and turns as possible. The `jevclaude` MCP server runs the steps locally. Exact selectors and its replay cache need no model; TypeSafe Jev handles the remaining per-step decisions. So you should **not** drive the device step by step.

## 1. Learn the screens (only if you need to)

- If the app's source is in this repo, read it for screen texts and view ids / accessibility identifiers. Exact selectors are free and deterministic.
- Otherwise call `snapshot` once. It returns compact text, not a screenshot.

## 2. Write one flow for the feature

The syntax is in the `run_flow` tool description.

- Prefer `tap: { id: ... }`, `tap: { text: ... }`, `see:` and `wait_for:` when you know the exact id or text.
- Use natural-language `tap:` and `expect:` only where the exact value is unknown or fuzzy. Keep each `expect:` to one checkable claim.
- Check numbers and counts with `see:`; Jev is weak at counting.
- Never put real credentials in a flow. Use `${TEST_EMAIL}`-style variables from `.env`.
- Set `permissions: allow` only if the user said granting permissions to their test app is fine.
- Save reusable flows under `flows/` (e.g. `flows/login.yaml`) and reuse them with `run: flows/login.yaml`.

## 3. Run it

Call `run_flow` once, with `flow_file` for saved flows.

## 4. Read the report

| Report says | What to do |
|---|---|
| `PASSED` | Tell the user; done. |
| `FAILED` | Diagnose with the screen dump, crash lines and screenshot path. Fix the app or the flow, then `resume_flow` with `retry`, or run again. |
| `UNCERTAIN` | Judge the screen dump yourself, then `resume_flow` with `pass`, `retry` or `fail`. Consider tightening the step afterwards. |
| `BLOCKED` | A risky action (payment, deletion, sending messages, account change) or a permission dialog. **Ask the user.** Only with their explicit OK, `resume_flow pass` (one-off), or add `- allow_risky: true` before that step in the saved flow. |

Mention the HTML report path to the user when there is one.
