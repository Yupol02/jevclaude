# JevClaude (Türkçe)

[![npm](https://img.shields.io/npm/v/jevclaude?color=cb3837&logo=npm)](https://www.npmjs.com/package/jevclaude)
[![CI](https://github.com/Yupol02/jevclaude/actions/workflows/ci.yml/badge.svg)](https://github.com/Yupol02/jevclaude/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Claude Code için token yakmayan mobil uygulama testi.** Android gerçek telefonda doğrulandı; iOS (simülatör) desteği yazıldı ama henüz deneysel.

Claude **neyin** test edileceğine karar verir ve bunu sade Türkçe ya da İngilizce kısa bir plan dosyasına yazar (`CihazdaTestEdilecek.md`, `.txt` ya da `.pdf`). JevClaude planın tamamını telefonda tek çağrıda çalıştırır ve yalnızca sonuçları geri gönderir. Adımlar ve cihaz durumları (fener açık mı, arama başladı mı, alarm kuruldu mu) kurallarla, model çağrılmadan okunur. Geriye kalan bulanık kararları [TypeSafe Jev](https://docs.typesafe.ai) yaklaşık 200 ms'de verir:
- hangi elemana dokunulacak
- adım geçti mi
- ekranda hata var mı
- aksiyon riskli mi

Tekrar çalıştırmalarda önbellek devreye girer ve model çağrısı yapılmaz. Claude yalnızca bir şey bozulduğunda ya da Jev emin olmadığında devreye girer; kararını verip testi **kaldığı yerden devam ettirebilir**.


**Ölçüldü** (Galaxy S22 Ultra, aynı görev, 3'er çalıştırma):
- **Samsung Hesap Makinesi** (12 × 7, "=" basmadan önizlemeyi kontrol et, temizle): JevClaude medyanı **4,9 sn ve ≈ 0,00013 $**, düz Claude Code **52,6 sn ve ≈ 0,19 $**. Yani yaklaşık 11 kat daha hızlı ve 1.400 kat daha ucuz. İki yöntem de 3/3 geçti.
- **Gerçek bir Compose uygulaması** (etkinlik oluşturma, eski sürüm, yavaş sürücü): 47 sn'ye karşı 90 sn, ≈ 0,0008 $'a karşı 0,28 $.
- **İkinci bir gerçek uygulama** (Galaxy S23 FE, 4 sekmelik salt okunur tur, Türkçe arama dahil): JevClaude **13,0 sn ve ≈ 0,00024 $** (3/3), düz Claude Code 98,2 sn ve ≈ 0,36 $ (2/3; `adb` "ş" ve "ı" yazamadığı için bir kez kaybetti).
- **Maestro 2.12.1** (S23 FE, aynı Hesap Makinesi adımları): akış 26 sn, açılışla birlikte 60–63 sn, 4/5. JevClaude: 6,7–7,8 sn, 5/5.

Hepsi akış bir kez yazıldıktan sonraki çalıştırma başına. Örneklem küçük; ayrıntılar için [README.md](README.md#benchmark) dosyasına bak.

**0.3.0 son kontrol:** Hesap Makinesi, Saat, Ayarlar ve Play Store akışları 3'er kez çalıştı; 15 çalıştırmanın hepsi geçti (çalıştırma başına 4,6–7,7 sn). Yanlış beklentiler p = 0,01 ile başarısız oldu. Risk koruması Play Store'daki "Yükle" butonunu engelliyor (p = 0,81–0,87). Jev'e giden ekran özetinde e-posta, telefon ve kart/IBAN numaraları maskeleniyor.

**0.4.0 — web sayfaları:** Chrome öndeyken sayfa içeriği Chrome DevTools üzerinden okunuyor (metinler, bağlantılar, butonlar, giriş kutuları). Böylece `see`, `tap`, `type` ve `expect` web sayfalarında da çalışıyor; Türkçe arama dahil örnek akış telefonda 6/6 geçti. Yeni `open:` adımı bir URL'yi ya da derin bağlantıyı doğrudan açıyor.

**0.5.0 — test planları:** Claude Code `CihazdaTestEdilecek.md` yazar, JevClaude onu tek çağrıda çalıştırır; fener, arama, alarm gibi durumlar doğrudan telefondan okunur. Gerçek telefonda CLI ile doğrulandı. Claude Code'un skill ile kendi başına plan yazıp `run_plan` çağırması henüz uçtan uca denenmedi.

**0.4.1 — ikinci telefon:** Akışlar Galaxy S23 FE'de değiştirilmeden çalıştırıldı. Bulunan hatalar düzeltildi: kayarak açılan ekranlarda (ör. Hesap Makinesi tuş takımı) erken dokunma, kaydırma bitmeden dokunma, Chrome'un otomatik çevirisiyle değişen bağlantı metinleri (bağlantılar artık gittiği adresi de taşıyor) ve her çalıştırmada biriken `adb forward` kayıtları. `expect:` artık p ≥ 0,75'te geçiyor.

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
node dist/cli.js init            # Claude Code skill'i, .mcp.json, config ve .env
# .env dosyasına TYPESAFE_API_KEY yaz
node dist/cli.js setup android   # opsiyonel: hızlı okuma + Türkçe karakter yazma (UiAutomator2)
node dist/cli.js setup ios       # simülatörü açar, WebDriverAgent'ı kurar
node dist/cli.js doctor          # her şey hazır mı kontrol eder
node dist/cli.js run examples/flows/settings-smoke.yaml --html rapor.html
```

### Kendi projende kullanmak

1. Uygulamanın deposunda:
   ```bash
   npx jevclaude init
   ```
   Bu komut Claude Code skill'ini (`.claude/skills/device-test/SKILL.md`) kurar, MCP sunucusunu `.mcp.json`'a ekler, `jevclaude.config.yaml` ve `.env` oluşturur. Telefona dokunmaz, örnek test eklemez.
2. `.env` dosyasına `TYPESAFE_API_KEY` yaz.
3. Telefonu USB hata ayıklama açık bağla: `npx jevclaude setup android && npx jevclaude doctor`
4. Claude Code'a örneğin *"cihazda test et: asistana 'feneri aç' yazınca fener açılıyor mu?"* de. Claude kodundan kesin metinleri okur, `CihazdaTestEdilecek.md`'yi yazar, `run_plan` ile çalıştırır ve sonuçları söyler. Telefonu kendisi sürmez.

## Test planı

```markdown
uygulama: com.ornek.asistan

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
npx jevclaude plan CihazdaTestEdilecek.md --check   # her satırın nasıl okunacağını gösterir, cihaz gerekmez
npx jevclaude plan CihazdaTestEdilecek.md           # çalıştırır (MCP: run_plan)
```

- **Aksiyonlar:** `Uygulamayı aç` (uygulamayı yeniden başlatır), `"X"e dokun`, `Varsa "X"e dokun`, `"Alan" alanına "metin" yaz ve gönder`, `Geri dön`, `Klavyeyi kapat`, `Aşağı kaydır`, `2 saniye bekle`, `"X" görünene kadar bekle`, `Aramayı kapat`.
- **Cihaz durumu (model yok, telefondan okunur):** `Kontrol: fener açık`, `arama başladı`, `alarm 07:00`, `müzik çalıyor`, `Wi-Fi kapalı`, `Bluetooth açık`, `bildirim "…"`.
- **Ekrandaki kesin metin (model yok):** `Kontrol: "Kaydedildi" görünüyor`, `Kontrol: "Hata" görünmüyor`.
- **Diğer her cümle:** Jev ekrana bakarak karar verir.
- Okunamayan bir satır, satır numarasıyla birlikte hata olarak bildirilir; plan asla yarım tahminle çalışmaz. Bir test başarısız olsa da diğerleri çalışır.
- **Telefon araması varsayılan olarak engellidir.** `izin: arama` yazmayan bir testte uygulama arama başlatırsa arama hemen kapatılır ve adım BLOCKED olur. `izin: arama` varsa arama, `Kontrol: arama başladı` doğrulanınca hemen kapatılır. Testten önce zaten süren bir aramaya dokunulmaz.

MCP'yi elle eklemek istersen: `claude mcp add jevclaude -- npx -y jevclaude mcp`

## YAML akışları (ileri düzey)

Planlar YAML akışlarına çevrilir. Plan biçiminin vermediği kontrol gerektiğinde (alt akışlar, `else`'li `if_visible`, zaman aşımları) akışı doğrudan da yazabilirsin:

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
