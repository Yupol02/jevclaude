---
name: device-test
description: Test the app on a real phone (Android) or iOS simulator through JevClaude — write a short test plan file (e.g. CihazdaTestEdilecek.md) and run it in one call with the jevclaude MCP tool run_plan. Use whenever the user asks to test, check or verify something in the app on a device ("cihazda test et", "telefonda dene", "fener açılıyor mu", "arama başlıyor mu").
---

# Test on the device with a plan file

You decide **what** to test. JevClaude does the device work: it runs the whole plan locally, reads exact texts and device states without a model, and asks a small model (Jev) only about fuzzy checks. That is far faster and cheaper than you driving the phone. So **never drive the device step by step yourself** (no `adb shell input`, no screenshots, no step-by-step `snapshot` loops) unless run_plan can't do something.

## 1. Know the app

- Read the app's source in this repo for the exact on-screen texts, button labels, field hints, ids and the package name (Android `applicationId`, iOS bundle id). Exact texts make steps deterministic and free.
- Only if the source doesn't tell you, call the `snapshot` tool once on the screen you need.

## 2. Write the plan file

Default name: `CihazdaTestEdilecek.md` in the project root (or the path the user gave). Format:

```markdown
uygulama: com.example.app

## Fener komutu
1. Uygulamayı aç
2. "Yaz ya da konuş" alanına "feneri aç" yaz ve gönder
3. Kontrol: fener açık
4. Kontrol: asistan feneri açtığını söylüyor

## Ayarlar araması
1. Uygulamayı aç
2. "Ayarlar" sekmesine dokun
3. "Ayarlarda ara" alanına "kişilik" yaz
4. Klavyeyi kapat
5. Kontrol: "Kişilik" görünüyor
6. Kontrol: "Temalar" görünmüyor
```

Rules:
- One `## Title` per test. Start every test with `Uygulamayı aç` (it restarts the app, so tests don't depend on each other).
- Numbered steps, one action or one check per line. Put exact on-screen texts in "double quotes".
- Actions: `Uygulamayı aç` · `Uygulamayı kapat` · `"X"e dokun` · `Varsa "X"e dokun` · `"Alan" alanına "metin" yaz [ve gönder]` · `Klavyeyi kapat` · `Geri dön` · `Aşağı/Yukarı kaydır` · `2 saniye bekle` · `"X" görünene kadar bekle` · `https://… adresini aç` · `Aramayı kapat`. English works too (`Tap "X"`, `Type "text" into "Field" and send`, `Go back`, `Scroll down`, `Wait 2 seconds`, `Check: …`).
- Checks start with `Kontrol:` (or `Check:`):
  - **Device state, read from the phone (no model):** `fener açık/kapalı` · `arama başladı` / `arama yok` · `alarm kurulu` / `alarm 07:00` / `alarm yok` · `müzik çalıyor/durdu` · `Wi-Fi açık/kapalı` · `Bluetooth açık/kapalı` · `uçak modu açık/kapalı` · `bildirim "metin"` · `"com.paket.adi" ön planda`.
  - **Exact screen text (no model):** `"Kaydedildi" görünüyor` · `"Hata" görünmüyor`.
  - **Anything else** is a sentence Jev judges against the screen: keep it to one checkable claim ("Ayarlar sayfası açık"). Check numbers with exact text, not sentences.
- If the app asks before acting ("Arayayım mı?", "Emin misin?"), the plan must answer it: wait for the question, then tap or type the answer. Check the app's code for such confirmations.
- Add `(isteğe bağlı)` at the end of a step whose failure shouldn't stop the test.
- **Phone calls:** by default a call the app starts is ended at once and the step is BLOCKED. Only if the user agreed that this test may really call someone, add `izin: arama` under that test's heading. The call is ended right after `Kontrol: arama başladı` passes. Prefer a test contact/number the user named.
- `izin: izinler` under a heading lets the test grant system permission dialogs (otherwise the test stops there).
- Never put passwords or personal data in the plan; use `${VAR}` placeholders from `.env`.
- `.txt` and `.pdf` plans use the same lines.

To see how the plan will be read without touching the device: `npx jevclaude plan CihazdaTestEdilecek.md --check`.

## 3. Run it — one call

Call the MCP tool `run_plan` with `plan_file`. (Without MCP: `npx jevclaude plan CihazdaTestEdilecek.md`.)

## 4. Read the report

One line per passing test; failing tests come with the step, the reason, the screen as text and a screenshot path.

| Result | What to do |
|---|---|
| ✓ PASSED | Done. |
| ✗ FAILED | Read the reason and screen. Fix the app (it's a bug) or the plan line (wrong text). Re-run only those tests: `run_plan` with `only: ["Title"]`. |
| ? UNCERTAIN | Jev wasn't sure. Judge from the screen text yourself; tighten the check (exact text) if it's flaky. |
| ⛔ BLOCKED | A risky action, a permission dialog, or a call without `izin: arama`. **Ask the user** before allowing it. |

Tell the user the results in a short table and mention the HTML report path.
