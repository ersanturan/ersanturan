# VFS Global Fransa vize randevu takibi

VFS Global'in Fransa vize sitesini ([visa.vfsglobal.com/tur/tr/fra](https://visa.vfsglobal.com/tur/tr/fra/login))
**kendi bilgisayarınızda, gerçek bir Chrome penceresiyle** düzenli aralıklarla kontrol eder. Uygun bir
randevu göründüğünde belirlediğiniz adrese **e-posta** gönderir.

Varsayılan ayarlar (`config.json`):

| Ayar | Değer |
|---|---|
| Başvuru merkezi | Ankara |
| Randevu kategorisi | Kısa süreli vize → Turizm |
| Tarih sınırı | Yok: herhangi bir boş randevu açıldığında haber verir |
| Kontrol sıklığı | 15–20 dakikada bir |

Agent **randevu almaz**, ödeme yapmaz, giriş dışında hiçbir form göndermez. Yalnızca VFS'nin
"en erken uygun randevu" bilgisini okur ve haber verir; rezervasyonu siz yaparsınız.

## Nasıl çalışır

1. Ayrı bir Chrome profiliyle (`state/profile/`) pencere açar. Çerezler ve oturum kontroller arasında
   korunur, böylece her seferinde yeniden giriş gerekmez.
2. VFS hesabınızla giriş yapar → **Yeni Rezervasyon Başlat** → Ankara / Kısa süreli / Turizm seçer.
3. Sonucu iki yerden okur: sayfanın kendi yaptığı `CheckIsSlotAvailable` API yanıtı ve ekrandaki
   bilgi kutusu ("En erken uygun randevu: 05-12-2026" / "Uygun randevu bulunmamaktadır").
4. E-posta ne zaman gider:
   - Randevu yokken randevu açılırsa,
   - Daha önce bildirilenden **daha erken** bir tarih çıkarsa,
   - Randevular kapanıp yeniden açılırsa.

   Aynı randevu açık kaldığı sürece her kontrolde tekrar e-posta gitmez. Gönderim başarısız olursa
   bir sonraki kontrolde tekrar denenir.
5. **Captcha ve tek kullanımlık kod (OTP) otomatik çözülmez.** VFS bunları isterse agent pencerede
   5 dakika boyunca sizin tamamlamanızı bekler. Agent 3 kontrol üst üste başarısız olursa
   (captcha, OTP, şifre hatası ve benzeri) size "müdahale gerekli" e-postası gönderir. Bu e-posta
   `ERROR_NOTIFY_TO` adresine, o boşsa gönderen Gmail adresine gider. Agent en fazla 6 saatte bir
   uyarı gönderir.
6. VFS "çok fazla istek / erişim engellendi" derse agent 2 saat bekleyip tekrar dener.

## Kurulum (bir kez)

1. [Node.js](https://nodejs.org) (18 veya üstü) ve Google Chrome kurulu olmalı.
2. Kodu indirip bağımlılıkları kurun:

   ```bash
   git clone https://github.com/ersanturan/ersanturan.git
   cd ersanturan/visa-agent
   npm install
   # Chrome yoksa: npx playwright install chromium
   ```

3. **Gmail uygulama şifresi** oluşturun (e-postayı göndermek için; normal Gmail şifresi çalışmaz):
   Google hesabınızda 2 adımlı doğrulama açık olmalı → <https://myaccount.google.com/apppasswords>
   → ad olarak "VFS takip" yazın → verilen 16 haneli şifreyi kopyalayın.
4. `.env.example` dosyasını `.env` adıyla kopyalayın (Windows: `copy .env.example .env`,
   Mac/Linux: `cp .env.example .env`) ve doldurun:

   ```ini
   VFS_EMAIL=vfs-hesabiniz@ornek.com
   VFS_PASSWORD=vfs-sifreniz
   NOTIFY_TO=bildirim-gidecek@adres.com
   SMTP_USER=gonderen-gmail-adresiniz@gmail.com
   SMTP_PASS=abcd efgh ijkl mnop
   ```

   `.env` repoya gönderilmez (`.gitignore`). Bu repo herkese açık olduğu için şifreleri ve
   adresleri başka hiçbir dosyaya yazmayın.
5. E-postanın çalıştığını deneyin. `NOTIFY_TO` adresine bir deneme e-postası gelmeli; gelmediyse
   spam klasörüne de bakın:

   ```bash
   npm run test-mail
   ```

## Çalıştırma

```bash
npm start        # sürekli çalışır, 15–20 dk'da bir kontrol eder (durdurmak için Ctrl+C)
npm run once     # tek kontrol yapar ve çıkar
```

- İlk çalıştırmada VFS captcha veya e-postaya gelen bir kod isteyebilir; açılan pencerede tamamlayın.
- Agent'ın çalışması için terminal ve bilgisayar açık kalmalı. Bilgisayarın uyku moduna geçmesini
  kapatın. Bilgisayar yeniden başlarsa `npm start` komutunu tekrar çalıştırın.
- Terminalde her kontrolün sonucu yazılır:
  `Ankara: uygun randevu yok` ya da `Ankara: RANDEVU VAR – en erken 05.12.2026 Cumartesi`.

## Ayarlar (`config.json`)

| Ayar | Varsayılan | Açıklama |
|---|---|---|
| `centers` | `["Ankara"]` | Kontrol edilecek merkezler; seçenek metninde geçen kelime (ör. `["Ankara", "İstanbul"]`) |
| `category` | `kisa\|short` | Randevu kategorisi deseni (büyük/küçük harf ve Türkçe karakter fark etmez) |
| `subcategory` | `turizm\|turist\|touris` | Alt kategori deseni |
| `earliestDate` / `latestDate` | `null` | Yalnızca bu aralıktaki randevular için haber ver (ör. `"2027-01-15"`) |
| `intervalMinutes` / `jitterMinutes` | `15` / `5` | Kontrol aralığı ve buna eklenen rastgele süre (en az 5 dk) |
| `blockedBackoffMinutes` | `120` | VFS engellerse bekleme süresi |
| `humanWaitMinutes` | `5` | Captcha/OTP için sizi bekleme süresi |
| `remindHours` | `0` | 0'dan büyükse, randevu açık kaldıkça bu kadar saatte bir hatırlatır |
| `errorAlertAfter` / `errorAlertHours` | `3` / `6` | Kaç ardışık hatada "müdahale gerekli" e-postası gideceği ve en sık ne kadar aralıkla |
| `headless` | `false` | `true` ise pencere açılmaz (captcha/OTP gerekirse tamamlanamaz) |
| `browserChannel` | `chrome` | Bilgisayardaki Chrome; bulunamazsa Playwright Chromium kullanılır |

VFS'deki kategori adları beklenenden farklıysa agent görünen seçenekleri terminale ve
`state/secenekler.json` dosyasına yazar, size uyarı e-postası gönderir. O durumda `category` /
`subcategory` desenini listedeki adla eşleşecek şekilde güncelleyin.

## Dosyalar (`state/`, repoya gönderilmez)

| Dosya | İçerik |
|---|---|
| `state.json` | Son durum ve son bildirim (tekrar e-posta gitmemesi için) |
| `history.jsonl` | Her kontrolün sonucu |
| `debug/` | Sorun anında ekran görüntüsü ve sayfa HTML'i (son 40 dosya) |
| `secenekler.json` | Kategori bulunamadığında VFS'de görünen seçenekler |
| `profile/` | Agent'ın Chrome profili (oturum çerezleri) |

## Dikkat edilmesi gerekenler

- **Agent gerçek VFS sitesinde henüz denenmedi.** Geliştirildiği bulut ortamı VFS'ye erişemiyordu.
  Akış, VFS'nin yapısını taklit eden yerel bir test sunucusuyla doğrulandı (`npm test`). Bu yüzden
  ilk çalıştırmayı başında bekleyerek yapın. Sonuç okunamazsa `state/debug/` altındaki ekran
  görüntüsüne bakın; VFS sayfa yapısını değiştirdiyse seçicilerin (`src/vfs.js`) güncellenmesi gerekir.
- VFS otomatik erişimi kullanım koşullarında kısıtlayabilir ve çok sık kontrol eden hesapları geçici
  olarak engelleyebilir. Bu yüzden kontrol aralığını 15 dakikanın altına indirmeyin; agent 5 dakikanın
  altını zaten kabul etmez. Agent captcha'yı veya bot korumasını aşmaya çalışmaz.
- Boş randevular çok çabuk dolabilir. E-posta geldiğinde hemen giriş yapıp rezervasyonu tamamlayın.

## Test

```bash
npm test   # birim testleri + sahte VFS sunucusuyla uçtan uca akış (Playwright Chromium gerekir)
```
