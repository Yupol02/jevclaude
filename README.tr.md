# JevClaude (Türkçe)

[![npm](https://img.shields.io/npm/v/jevclaude?color=cb3837&logo=npm)](https://www.npmjs.com/package/jevclaude)
[![CI](https://github.com/Yupol02/jevclaude/actions/workflows/ci.yml/badge.svg)](https://github.com/Yupol02/jevclaude/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Claude Code için token yakmayan mobil uygulama testi.** Android gerçek telefonda doğrulandı; iOS (simülatör) desteği yazıldı ama henüz deneysel.

Claude test akışını bir kez yazar. Yerel bir çalıştırıcı (runner) cihazı yönetir. Adım başına küçük kararları [TypeSafe Jev](https://docs.typesafe.ai) yaklaşık 200 ms'de verir:
- hangi elemana dokunulacak
- adım geçti mi
- ekranda hata var mı
- aksiyon riskli mi

Tekrar çalıştırmalarda önbellek devreye girer ve model çağrısı yapılmaz. Claude yalnızca bir şey bozulduğunda ya da Jev emin olmadığında devreye girer; kararını verip testi **kaldığı yerden devam ettirebilir**.


**Ölçüldü** (Galaxy S22 Ultra, aynı görev, 3'er çalıştırma):
- **Samsung Hesap Makinesi** (12 × 7, "=" basmadan önizlemeyi kontrol et, temizle): JevClaude medyanı **4,9 sn ve ≈ 0,00013 $**, düz Claude Code **52,6 sn ve ≈ 0,19 $**. Yani yaklaşık 11 kat daha hızlı ve 1.400 kat daha ucuz. İki yöntem de 3/3 geçti.
- **Gerçek bir Compose uygulaması** (etkinlik oluşturma, eski sürüm, yavaş sürücü): 47 sn'ye karşı 90 sn, ≈ 0,0008 $'a karşı 0,28 $.

Hepsi akış bir kez yazıldıktan sonraki çalıştırma başına. Örneklem küçük; ayrıntılar için [README.md](README.md#benchmark) dosyasına bak.

**0.3.0 son kontrol:** Hesap Makinesi, Saat, Ayarlar ve Play Store akışları 3'er kez çalıştı; 15 çalıştırmanın hepsi geçti (çalıştırma başına 4,6–7,7 sn). Yanlış beklentiler p = 0,01 ile başarısız oldu. Risk koruması Play Store'daki "Yükle" butonunu engelliyor (p = 0,81–0,87). Jev'e giden ekran özetinde e-posta, telefon ve kart/IBAN numaraları maskeleniyor.

## Neden?

Claude Code telefonu kendisi sürdüğünde her adım tam bir LLM turu oluyor: ekran görüntüsü, okuma, düşünme, aksiyon. Bu hem yavaş hem pahalı. Oysa bu kararların çoğu küçük ve tiplidir: "Bu 30 elemandan hangisi giriş butonu?", "Ekranda sepet görünüyor mu, evet/hayır?". JevClaude'da her adım şu sırayla çözülür:

1. **Kesin eşleşme:** id veya metin birebir tutuyorsa model çağrılmaz.
2. **Önbellek:** bir önceki çalıştırmada bulunan seçici kullanılır. Eleman artık yoksa Jev'e sorulur ve önbellek kendini onarır.
3. **Jev:** eleman seçimi ve risk tek çağrıda sorulur.
4. **Claude:** güven eşiğin altındaysa çalıştırma "uncertain" olarak durur; Claude `resume_flow` ile pass, retry ya da fail der.

**Risk koruması:** satın alma, silme, mesaj gönderme gibi aksiyonlar varsayılan olarak engellenir. Kullanıcı onay vermeden geçmez.

## Hızlı başlangıç

```bash
npm install && npm run build
node dist/cli.js init            # config, örnek akış ve .env oluşturur
# .env dosyasına TYPESAFE_API_KEY yaz
node dist/cli.js setup android   # opsiyonel: hızlı okuma + Türkçe karakter yazma (UiAutomator2)
node dist/cli.js setup ios       # simülatörü açar, WebDriverAgent'ı kurar
node dist/cli.js doctor          # her şey hazır mı kontrol eder
node dist/cli.js run examples/flows/settings-smoke.yaml --html rapor.html
```

Claude Code'a bağlamak için:

```bash
claude mcp add jevclaude -- node /tam/yol/JevClaude/dist/cli.js mcp
```

Ardından Claude'a *"telefonumda giriş akışını test et"* demen yeterli.

## Örnek akış

```yaml
name: giriş testi
app: com.ornek.magaza
permissions: allow
steps:
  - launch
  - tap: "Giriş yap butonu"
  - type: { into: "e-posta alanı", text: "${TEST_EMAIL}" }
  - type: { into: { id: password }, text: "${TEST_PASSWORD}", submit: true }
  - wait_for: "Ana Sayfa"
  - expect: "Kullanıcı giriş yapmış ve adı görünüyor"
```

Tüm söz dizimi: [docs/flow-reference.md](docs/flow-reference.md). Maestro akışları `jevclaude import-maestro` ile içeri, `export-maestro` ile dışarı aktarılabilir.

## Sınırlar

- **Jev'in zayıf yanları:** sayma ve aritmetikte zayıf. Sayıları `see:` ile kontrol et.
- **Görünmeyen ekranlar:** canvas, oyun ve semantics kullanmayan Flutter ekranları boş görünür.
- **Android'de yazı:** yalnız adb ile ASCII yazılır. Türkçe karakter için `setup android` gerekir.
- **iOS:** şimdilik yalnızca simülatörde çalışır.

Ayrıntılar ve karşılaştırma: [README.md](README.md), [docs/comparison.md](docs/comparison.md).
