# Ankara → Paris direkt uçuş tarama agent'ı

Google Flights'ı **API kullanmadan**, gerçek bir tarayıcıyı (Playwright + Chromium)
otomatik sürerek tarar; Ankara (ESB) → Paris (CDG/ORY) **direkt** uçuşları belirli
bir tarih aralığında, belirli kalış sürelerine göre eşleştirir ve **fiyata göre
sıralı** alternatif listesi üretir.

Varsayılan senaryo (`config.json`):

| Ayar | Değer |
|---|---|
| Rota | ESB → CDG / ORY (ve dönüşü) |
| Tarih aralığı | 1 Şubat – 31 Mart 2027 (gidiş), dönüş en geç 4 Nisan |
| Kalış | 2 – 4 gün |
| Yolcular | 2 yetişkin + 1 kucakta bebek |
| Aktarma | 0 (yalnızca direkt) |
| Para birimi | EUR (tüm yolcular için toplam) |

## Nasıl çalışır

1. **Tek yön tarama** – Aralıktaki her gün için gidiş yönünde, kalış kaydırmalı
   aralıktaki her gün için dönüş yönünde Google Flights tek yön araması açılır
   ("Nonstop" filtresi URL'ye gömülü). Sayfadaki tüm uçuş satırları okunur
   ("View more flights" varsa açılır).
2. **Eşleştirme** – Gidiş günü + 2/3/4 gün = dönüş günü olacak şekilde tüm
   gidiş/dönüş çiftleri oluşturulur; tek yön fiyatları toplanır ve sıralanır.
3. **Gidiş-dönüş doğrulama** – En ucuz N alternatif (varsayılan 20) için
   gidiş-dönüş araması açılır, aynı gidiş uçuşu tıklanır, dönüş listesinden aynı
   dönüş uçuşu bulunur ve Google'ın gösterdiği **gerçek gidiş-dönüş toplamı**
   kaydedilir. Liste bu doğrulanmış fiyata göre yeniden sıralanır.
4. **Rapor** – `results/` altına zaman damgalı `.md`, `.csv`, `.json` ve her
   zaman güncel `son-tarama.*` dosyaları yazılır. Her satırda doğrudan Google
   Flights'ta açan bir link vardır.

Arama URL'sindeki `tfs` parametresi (base64url protobuf) `src/tfs.js` içinde
elle kodlanır; dış kütüphane/servis yoktur.

## Kurulum

```bash
cd flight-agent
npm install                 # playwright
npx playwright install chromium
```

## Çalıştırma

```bash
npm run scan                           # config.json ile tam tarama
node src/agent.js --start 2027-02-08 --end 2027-02-21 --verify-top 5
node src/agent.js --currency TRY --adults 2 --infants-lap 1
node src/agent.js --from ESB --to CDG,ORY --min-stay 2 --max-stay 4
node src/agent.js --max-stops 1       # aktarmalıları da dahil et
node src/agent.js --headed             # tarayıcıyı görünür aç
node src/agent.js --no-cache           # önbelleği yok say
```

Tüm seçenekler: `--config, --from, --to, --start, --end, --min-stay, --max-stay,
--adults, --children, --infants-lap, --infants-seat, --max-stops, --seat,
--currency, --concurrency, --min-delay, --max-delay, --cooldown, --max-cooldowns,
--verify-top, --out, --headed, --no-cache`.

## Keşif modu: bir ülkedeki tüm direkt uçuş noktaları

`src/discover.js`, bir kalkış havalimanından bir ülkedeki **tüm** havalimanlarına
direkt uçuş olup olmadığını her gün için tarar. Google tek aramada en fazla 7
varış havalimanına izin verdiği için liste 7'li gruplara bölünür. Direkt uçuş
bulunan havalimanları için dönüş yönü de taranır ve şehir bazında özet çıkarılır
(uçuş günleri, saatler, havayolu, en ucuz fiyat).

```bash
npm run discover                                    # ESB → Fransa, Şubat 2027
node src/discover.js --from ESB --country FR --start 2027-03-01 --end 2027-03-31
node src/discover.js --from ESB --airports LYS,MRS,NCE --start 2027-02-01 --end 2027-02-28
```

Rapor `results/kesif-<kalkış>-<ülke>-<zaman>.md` ve `.json` olarak yazılır.
Şu an hazır ülke listesi Fransa (`FR`, 44 havalimanı); başka ülkeler için
`--airports` ile IATA kodları verilebilir.

## Fiyat takibi: düşüşte haber ver

`src/watch.js`, bir tarama raporundaki gidiş-dönüş kombinasyonlarını her
çalıştırıldığında yeniden fiyatlar. Her kombinasyon için Google Flights'ta
gidiş-dönüş araması açar, aynı uçuşları seçer ve güncel toplamı okur. Sonucu
bir önceki kontrolle karşılaştırır. AJet saatleri değiştirirse aynı havayolunun
o günkü tek direkt uçuşuyla eşleştirir ve bunu raporda belirtir.

```bash
# Bir kez: Cuma–Pazartesi listesinden 1 Şubat sonrasını izlemeye al
node src/watch.js --init results/son-tarama-cuma-pazartesi.json --after 2027-02-01 [--min-drop 1]

# Her gün
npm run watch
```

Çıktılar `results/watch/` altında:

| Dosya | İçerik |
|---|---|
| `watchlist.json` | İzlenen kombinasyonlar, uçuşlar ve başlangıç fiyatları |
| `history.json` | Her kontrolün fiyatları |
| `son-kontrol.md` | Son kontrolün tablosu: şimdi, önceki, değişim, başlangıç, en düşük, link |
| `alert.md` | Yalnızca en az `--min-drop` € düşüş varsa oluşur; bildirim metni |

Son satırdaki `WATCH_SUMMARY {...}` JSON'u düşüşleri makine-okunur verir.

Bildirim için ntfy.sh kullanılır, ayrı bir servis kurulumu gerekmez:

```bash
node src/watch.js --ntfy-topic <tahmin-edilemez-konu>                       # ntfy uygulamasına anlık bildirim
NTFY_TOKEN=tk_... node src/watch.js --ntfy-topic <konu> --email adres@ornek.com   # + e-posta
```

- Konuya ntfy uygulamasından ya da `https://ntfy.sh/<konu>` adresinden abone olunur.
- ntfy.sh hesapsız e-posta göndermeye izin vermez. E-posta için ücretsiz bir
  ntfy.sh hesabında erişim anahtarı oluşturup `NTFY_TOKEN` olarak verin.
- Repo herkese açıksa e-posta adresini ve konuyu repoya yazmayın, parametreyle verin.
Tarihi geçen kombinasyonlar otomatik atlanır. Günlük çalıştırma bir Claude
zamanlanmış görevi ile yapılır: görev komutu çalıştırır, geçmişi repoya
commit'ler ve düşüş varsa telefona bildirim gönderir.

## Nezaket ve dayanıklılık

- Sayfalar arasında 3–5 sn rastgele bekleme ve tek sayfa ile çalışır; Google'a
  yük bindirmez.
- Google "olağan dışı trafik" (captcha) gösterirse captcha **çözülmeye
  çalışılmaz**; 120 sn beklenir ve kaldığı yerden devam edilir (en fazla 3 kez),
  sonra tarama durdurulur ve o ana kadarki sonuçlar raporlanır.
- Her günün sonucu `results/cache/` altında önbelleklenir; kesilen tarama aynı
  komutla kaldığı yerden sürer.
- Bazı proxy'lerde Chromium, gstatic JS parçalarını ORB ile engeller;
  `src/browser.js` bu istekleri Playwright ağ katmanından geçirerek çözer.

## Notlar

- Fiyatlar Google Flights'ın gösterdiği, vergiler dahil, **3 yolcu toplam**
  tutarlardır; AJet temel ücretlerinde kabin bagajı dahil değildir (raporda
  işaretlenir).
- Google'ın sayfa yapısı değişirse `src/scrape.js` içindeki `li.pIav2d` ve
  `div.yR1fYc` seçicilerinin güncellenmesi gerekir.
