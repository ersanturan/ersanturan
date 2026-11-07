'use strict';
const fs = require('fs');
const path = require('path');
const { weekdayTr } = require('./combine');

function fmtFlight(f) {
  const bag = f.noCarryOn ? ' (kabin bagajı dahil değil)' : '';
  return `${f.airline} ${f.depAirport}→${f.arrAirport} ${f.depTime}–${f.arrTime}${bag}`;
}
function fmtDate(iso) { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y} ${weekdayTr(iso)}`; }
function money(v, cur) { return v === null || v === undefined ? '-' : `${v.toLocaleString('tr-TR')} ${cur || ''}`.trim(); }
function csvEscape(v) { const s = v === null || v === undefined ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

function writeReports({ outDir, combos, oneWay, meta }) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const base = path.join(outDir, `alternatifler-${stamp}`);

  fs.writeFileSync(`${base}.json`, JSON.stringify({ meta, combos, oneWay }, null, 2));

  const header = ['sira', 'gidis_tarihi', 'gidis_gun', 'donus_tarihi', 'donus_gun', 'kalis_gun', 'gidis_ucus', 'donus_ucus',
    'tek_yon_toplam', 'gidis_donus_dogrulanan', 'para_birimi', 'kabin_bagaji', 'arama_linki'];
  const rows = combos.map((c, i) => [i + 1, c.depDate, weekdayTr(c.depDate), c.retDate, weekdayTr(c.retDate), c.stayDays,
    fmtFlight(c.outbound), fmtFlight(c.inbound), c.oneWaySum, c.verified?.total ?? '', c.currency,
    (c.outbound.noCarryOn || c.inbound.noCarryOn) ? 'dahil degil' : 'dahil', c.verified?.selectionUrl || c.searchUrl || '']);
  fs.writeFileSync(`${base}.csv`, [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\n') + '\n');

  const md = [];
  md.push(`# ${meta.origin.join('/')} → ${meta.destination.join('/')} direkt uçuş alternatifleri`);
  md.push('');
  md.push(`- Tarama zamanı: ${meta.scannedAt}`);
  md.push(`- Tarih aralığı: ${meta.startDate} – ${meta.endDate}, kalış ${meta.minStay}–${meta.maxStay} gün`);
  md.push(`- Yolcular: ${meta.passengers.adults} yetişkin, ${meta.passengers.children} çocuk, ${meta.passengers.infantsOnLap} kucakta bebek, ${meta.passengers.infantsInSeat} koltuklu bebek`);
  md.push(`- Fiyatlar tüm yolcular için toplamdır (${meta.currency}). Kaynak: Google Flights, ${meta.maxStops === 0 ? 'yalnızca direkt uçuşlar' : `en fazla ${meta.maxStops} aktarma`}.`);
  md.push(`- Taranan gün sayısı: gidiş ${meta.scannedOutboundDays}, dönüş ${meta.scannedInboundDays}. Direkt uçuş bulunan gün: gidiş ${meta.outboundDaysWithFlights}, dönüş ${meta.inboundDaysWithFlights}.`);
  md.push(`- "Tek yön toplamı" iki tek yön fiyatının toplamıdır; "G/D doğrulanan" Google'ın gidiş-dönüş aramasında aynı uçuşlar seçilince gösterdiği gerçek toplamdır (ilk ${meta.verifyTop} alternatif için kontrol edildi).`);
  if (meta.warnings?.length) { md.push(''); for (const w of meta.warnings) md.push(`> ⚠️ ${w}`); }
  md.push('');
  md.push(`## Fiyata göre sıralı alternatifler (${combos.length})`);
  md.push('');
  md.push('| # | Gidiş | Dönüş | Kalış | Gidiş uçuşu | Dönüş uçuşu | Tek yön toplamı | G/D doğrulanan | Link |');
  md.push('|---|---|---|---|---|---|---|---|---|');
  combos.forEach((c, i) => {
    const link = c.verified?.selectionUrl || c.searchUrl;
    md.push(`| ${i + 1} | ${fmtDate(c.depDate)} | ${fmtDate(c.retDate)} | ${c.stayDays} gün | ${fmtFlight(c.outbound)} | ${fmtFlight(c.inbound)} | ${money(c.oneWaySum, c.currency)} | ${c.verified?.ok ? money(c.verified.total, c.verified.currency || c.currency) : (c.verified ? `? (${c.verified.reason})` : '-')} | ${link ? `[aç](${link})` : '-'} |`);
  });
  md.push('');
  md.push('## Günlere göre tek yön direkt uçuşlar');
  md.push('');
  for (const dir of ['outbound', 'inbound']) {
    md.push(`### ${dir === 'outbound' ? 'Gidiş' : 'Dönüş'}`);
    md.push('');
    md.push('| Tarih | Uçuş | Süre | Fiyat |');
    md.push('|---|---|---|---|');
    for (const [date, flights] of Object.entries(oneWay[dir]).sort()) {
      if (!flights.length) continue;
      for (const f of flights) md.push(`| ${fmtDate(date)} | ${fmtFlight(f)} | ${f.durationMin ? `${Math.floor(f.durationMin / 60)}s ${f.durationMin % 60}dk` : '-'} | ${money(f.price, f.currency)} |`);
    }
    md.push('');
  }
  fs.writeFileSync(`${base}.md`, md.join('\n'));
  fs.copyFileSync(`${base}.md`, path.join(outDir, 'son-tarama.md'));
  fs.copyFileSync(`${base}.csv`, path.join(outDir, 'son-tarama.csv'));
  fs.copyFileSync(`${base}.json`, path.join(outDir, 'son-tarama.json'));
  return { md: `${base}.md`, csv: `${base}.csv`, json: `${base}.json` };
}

module.exports = { writeReports, fmtFlight, fmtDate };
