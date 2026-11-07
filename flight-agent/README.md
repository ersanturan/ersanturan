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
