# Security

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab), not in public issues.

## Keys

- **Where keys live.** Jev keys (`TYPESAFE_API_KEY`, `CLOUDFLARE_API_TOKEN`) are read from the environment or `.env`. `.env` is git-ignored. Never commit it, and never put keys in flow files.
- **What gets sent.** Flows reference credentials as `${VAR}`. Typed values are sent to the device, never to Jev.
- **Passwords on screen.** Password fields are rendered as `password` flags, without their content, in what Jev sees.

## What leaves your machine

Each Jev call sends a compact text dump of the current screen to the configured provider (TypeSafe or Cloudflare). Before it is sent, e-mail addresses, phone numbers and card/IBAN-like numbers are replaced with `<email>`, `<phone>`, `<card-number>` and `<iban>`. Names and other free text are not masked, so don't test production accounts or screens with personal data you can't share with that provider. Screenshots and videos stay local in `reports/`.

## Risk guard

Before each tap or type, Jev is asked whether the action is risky: money, installing/updating/uninstalling apps, deleting data or accounts, messaging other people, or security/account changes. At or above `risk_block` the step is **blocked**.

The guard is not a sandbox. It is a second line of defence, so test on test accounts and test devices.

- The guard can be turned off only by the CLI flag `--no-risk-guard` or by config. It cannot be turned off from MCP.
- `allow_risky: true` in a flow lets exactly one following action through. Treat it like a code-review item.

## Prompt injection

Text shown by the app under test is untrusted. It is delimited as data in every Jev request and never used as instructions. Reports returned to Claude label the screen dump as screen content.
