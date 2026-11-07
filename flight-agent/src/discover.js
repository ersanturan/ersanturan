#!/usr/bin/env node
'use strict';
/**
 * Keşif modu: bir kalkış noktasından bir ülkedeki TÜM havalimanlarına direkt uçuş olup
 * olmadığını, tarih aralığındaki her gün için Google Flights'ta tarar (API yok).
 *
 * Google tek aramada en fazla 7 varış havalimanına izin verir ("Too many locations
 * selected"); bu yüzden havalimanı listesi 7'li gruplara bölünür.
 *  1. Gidiş: her gün × her grup için tek yön direkt arama.
 *  2. Dönüş: yalnızca direkt uçuş bulunan havalimanları için her gün tek yön direkt arama.
 *  3. Şehir bazında özet (uçuş günleri, saatler, havayolu, en düşük fiyat) raporlanır.
 *
 * Kullanım: node src/discover.js [--from ESB] [--country FR] [--start 2027-02-01 --end 2027-02-28]
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./browser');
const { scanOneWay, BlockedError, setPacing } = require('./scrape');
const { runPool, log } = require('./pool');
const { dateRange, weekdayTr } = require('./combine');
const { buildSearchUrl } = require('./tfs');

const MAX_LOCATIONS = 7;

// Ticari tarifeli uçuş alan Fransa havalimanları (anakara + Korsika).
const AIRPORTS = {
  FR: {
    CDG: 'Paris', ORY: 'Paris', BVA: 'Paris (Beauvais)', LYS: 'Lyon', MRS: 'Marsilya', NCE: 'Nice', TLS: 'Toulouse',
    BOD: 'Bordeaux', NTE: 'Nantes', SXB: 'Strazburg', MLH: 'Mulhouse / Basel', LIL: 'Lille', MPL: 'Montpellier', BIQ: 'Biarritz',
    RNS: 'Rennes', BES: 'Brest', CFE: 'Clermont-Ferrand', GNB: 'Grenoble', TLN: 'Toulon', AJA: 'Ajaccio', BIA: 'Bastia',
    FSC: 'Figari', CLY: 'Calvi', PUF: 'Pau', LDE: 'Lourdes / Tarbes', PGF: 'Perpignan', BZR: 'Béziers', FNI: 'Nîmes',
    CCF: 'Carcassonne', LIG: 'Limoges', LRH: 'La Rochelle', EGC: 'Bergerac', ETZ: 'Metz / Nancy', CMF: 'Chambéry',
    TUF: 'Tours', PIS: 'Poitiers', BVE: 'Brive', RDZ: 'Rodez', DLE: 'Dole', DOL: 'Deauville', CFR: 'Caen',
    LRT: 'Lorient', UIP: 'Quimper', AVN: 'Avignon',
  },
};

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2), n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; }
  }
  return a;
}
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const country = (args.country || 'FR').toUpperCase();
  const names = AIRPORTS[country];
  if (!names && !args.airports) throw new Error(`Bilinmeyen ülke: ${country}. --airports ile liste verin.`);
  const airports = args.airports ? String(args.airports).split(',').map(s => s.trim().toUpperCase()) : Object.keys(names);
  const cfg = {
    from: String(args.from || 'ESB').split(',').map(s => s.trim().toUpperCase()),
    start: args.start || '2027-02-01', end: args.end || '2027-02-28',
    passengers: { adults: Number(args.adults ?? 2), children: Number(args.children ?? 0), infantsInSeat: 0, infantsOnLap: Number(args['infants-lap'] ?? 1) },
    currency: (args.currency || 'EUR').toUpperCase(),
    outDir: path.resolve(args.out || 'results'),
    skipReturn: !!args['skip-return'],
  };
  const poolOpts = { concurrency: 1, cooldownSec: Number(args.cooldown ?? 120), maxCooldowns: Number(args['max-cooldowns'] ?? 6) };
  setPacing(Number(args['min-delay'] ?? 3000), Number(args['max-delay'] ?? 5000));
  const cacheDir = path.join(cfg.outDir, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = k => path.join(cacheDir, k.replace(/[^a-z0-9_.-]/gi, '_') + '.json');
  const cached = k => (!args['no-cache'] && fs.existsSync(cachePath(k))) ? JSON.parse(fs.readFileSync(cachePath(k), 'utf8')) : null;

  const days = dateRange(cfg.start, cfg.end);
  const legOpts = { maxStops: 0, passengers: cfg.passengers, seat: 'economy', currency: cfg.currency };
  const results = { outbound: [], inbound: [] };
  const warnings = [];

  const suspiciousGaps = (flights, apOf, allDays, tasks) => {
    const wd = d => new Date(d + 'T00:00:00Z').getUTCDay();
    const out = new Set();
    for (const ap of new Set(flights.map(apOf).filter(Boolean))) {
      const mine = flights.filter(f => apOf(f) === ap);
      const wds = new Set(mine.map(f => wd(f.date)));
      const have = new Set(mine.map(f => f.date));
      for (const d of allDays) if (wds.has(wd(d)) && !have.has(d)) {
        const t = tasks.find(t => t.date === d && (t.to.includes(ap) || t.from.includes(ap)));
        if (t) out.add(t);
      }
    }
    return [...out].map(t => ({ ...t, done: false, label: t.label + ' (yeniden)' }));
  };

  const scanTasks = async (tasks, dir, context, fresh = false) => {
    let n = 0;
    try {
      await runPool(context, tasks, poolOpts, async (page, t) => {
        const key = `disc_${dir}_${t.from.join('-')}_${t.to.join('-')}_${t.date}_${cfg.currency}_${JSON.stringify(cfg.passengers)}`;
        let r = fresh ? null : cached(key);
        if (fresh) { const k = (dir === 'outbound' ? 'arrAirport' : 'depAirport'); for (let i = results[dir].length - 1; i >= 0; i--) { const f = results[dir][i]; if (f.date === t.date && (t.to.includes(f[k]) || t.from.includes(f[k]))) results[dir].splice(i, 1); } }
        if (!r) { r = await scanOneWay(page, { date: t.date, from: t.from, to: t.to, ...legOpts }); fs.writeFileSync(cachePath(key), JSON.stringify(r)); }
        t.done = true;
        results[dir].push(...r.flights.map(f => ({ ...f, date: t.date })));
        log(`[${++n}/${tasks.length}] ${t.label}: ${r.flights.length ? r.flights.map(f => `${f.airline} ${f.depAirport}→${f.arrAirport} ${f.depTime} ${f.price}`).join('; ') : '-'}`);
      });
    } catch (e) { if (e instanceof BlockedError) warnings.push(e.message); else throw e; }
    const missed = tasks.filter(t => !t.done);
    if (missed.length) warnings.push(`${dir === 'outbound' ? 'Gidiş' : 'Dönüş'} yönünde ${missed.length} arama tamamlanamadı: ${missed.map(t => t.label).join(', ')}`);
  };

  const groups = chunk(airports, MAX_LOCATIONS);
  log(`Keşif: ${cfg.from.join('/')} → ${airports.length} havalimanı (${groups.length} grup), ${cfg.start}..${cfg.end} (${days.length} gün), yalnızca direkt`);
  const { browser, context } = await launchBrowser();
  try {
    const outTasks = days.flatMap(date => groups.map((g, gi) => ({ date, from: cfg.from, to: g, label: `gidiş ${date} grup ${gi + 1}` })));
    await scanTasks(outTasks, 'outbound', context);

    // Şüpheli boşluklar: bir havalimanına uçuş olan haftagününde uçuş görünmeyen günler
    // (hız sınırı anında boş gelen sayfa olabilir) önbelleksiz yeniden taranır.
    const recheckOut = suspiciousGaps(results.outbound, f => f.arrAirport, days, outTasks);
    if (recheckOut.length) { log(`${recheckOut.length} şüpheli boş gidiş araması yeniden yapılıyor`); await scanTasks(recheckOut, 'outbound', context, true); }

    const found = [...new Set(results.outbound.map(f => f.arrAirport).filter(Boolean))];
    log(`Gidişte direkt uçuş bulunan havalimanları: ${found.join(', ') || 'yok'}`);
    if (found.length && !cfg.skipReturn) {
      const inTasks = days.flatMap(date => chunk(found, MAX_LOCATIONS).map((g, gi) => ({ date, from: g, to: cfg.from, label: `dönüş ${date} grup ${gi + 1}` })));
      await scanTasks(inTasks, 'inbound', context);
      const recheckIn = suspiciousGaps(results.inbound, f => f.depAirport, days, inTasks);
      if (recheckIn.length) { log(`${recheckIn.length} şüpheli boş dönüş araması yeniden yapılıyor`); await scanTasks(recheckIn, 'inbound', context, true); }
    }
  } finally { await browser.close(); }

  // Şehir bazında özet
  const byAirport = {};
  for (const dir of ['outbound', 'inbound']) for (const f of results[dir]) {
    const ap = dir === 'outbound' ? f.arrAirport : f.depAirport;
    const e = byAirport[ap] ||= { airport: ap, city: names?.[ap] || ap, outbound: [], inbound: [] };
    e[dir].push(f);
  }
  const summary = Object.values(byAirport).map(e => {
    const s = dir => {
      const fl = e[dir].slice().sort((a, b) => a.date.localeCompare(b.date));
      const wd = [...new Set(fl.map(f => new Date(f.date + 'T00:00:00Z').getUTCDay()))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(d => ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'][d]);
      const cheapest = fl.reduce((m, f) => (!m || f.price < m.price ? f : m), null);
      return { count: fl.length, dates: [...new Set(fl.map(f => f.date))], weekdays: wd, airlines: [...new Set(fl.map(f => f.airline))], times: [...new Set(fl.map(f => `${f.depTime}–${f.arrTime}`))], cheapest };
    };
    return { airport: e.airport, city: e.city, out: s('outbound'), in: s('inbound') };
  }).sort((a, b) => (a.out.cheapest?.price ?? 1e9) - (b.out.cheapest?.price ?? 1e9));

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const base = path.join(cfg.outDir, `kesif-${cfg.from.join('-')}-${country}-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ cfg, airports, summary, results, warnings }, null, 2));
  const fmt = iso => { const [, m, d] = iso.split('-'); return `${d}.${m} ${weekdayTr(iso)}`; };
  const md = [];
  md.push(`# ${cfg.from.join('/')} → ${country} direkt uçuş keşfi (${cfg.start} – ${cfg.end})`, '');
  md.push(`- Tarama zamanı: ${new Date().toISOString()}. Kaynak: Google Flights, yalnızca direkt uçuşlar.`);
  md.push(`- Taranan havalimanları (${airports.length}): ${airports.map(a => `${a}${names?.[a] ? ` (${names[a]})` : ''}`).join(', ')}`);
  md.push(`- Fiyatlar ${cfg.passengers.adults} yetişkin + ${cfg.passengers.infantsOnLap} kucakta bebek için tek yön toplamıdır (${cfg.currency}).`);
  for (const w of warnings) md.push(`> ⚠️ ${w}`);
  md.push('', `## Direkt uçuş bulunan şehirler (${summary.length})`, '');
  md.push('| Şehir | Havalimanı | Havayolu | Gidiş günleri | Gidiş saatleri | En ucuz gidiş | Dönüş günleri | Dönüş saatleri | En ucuz dönüş |');
  md.push('|---|---|---|---|---|---|---|---|---|');
  for (const s of summary) {
    md.push(`| ${s.city} | ${s.airport} | ${[...new Set([...s.out.airlines, ...s.in.airlines])].join(', ')} | ${s.out.weekdays.join(', ') || '-'} (${s.out.dates.length} gün) | ${s.out.times.join(', ') || '-'} | ${s.out.cheapest ? `${s.out.cheapest.price} ${cfg.currency} (${fmt(s.out.cheapest.date)})` : '-'} | ${s.in.weekdays.join(', ') || '-'} (${s.in.dates.length} gün) | ${s.in.times.join(', ') || '-'} | ${s.in.cheapest ? `${s.in.cheapest.price} ${cfg.currency} (${fmt(s.in.cheapest.date)})` : '-'} |`);
  }
  const none = airports.filter(a => !byAirport[a]);
  md.push('', `Direkt uçuş bulunmayan havalimanları: ${none.join(', ') || '-'}`, '');
  for (const s of summary) {
    md.push(`## ${s.city} (${s.airport}) – günlük liste`, '', '| Yön | Tarih | Uçuş | Fiyat | Link |', '|---|---|---|---|---|');
    for (const [dir, label] of [['outbound', 'Gidiş'], ['inbound', 'Dönüş']]) {
      for (const f of byAirport[s.airport][dir].sort((a, b) => a.date.localeCompare(b.date))) {
        const url = buildSearchUrl({ legs: [{ date: f.date, from: [f.depAirport], to: [f.arrAirport], maxStops: 0 }], passengers: cfg.passengers, trip: 'oneWay' }, { currency: cfg.currency });
        md.push(`| ${label} | ${fmt(f.date)} | ${f.airline} ${f.depAirport}→${f.arrAirport} ${f.depTime}–${f.arrTime} | ${f.price} ${cfg.currency} | [aç](${url}) |`);
      }
    }
    md.push('');
  }
  fs.writeFileSync(`${base}.md`, md.join('\n'));
  log(`Rapor yazıldı: ${base}.md`);
  console.log('\nDirekt uçuş bulunan şehirler:');
  for (const s of summary) console.log(`- ${s.city} (${s.airport}): ${[...new Set([...s.out.airlines, ...s.in.airlines])].join(', ')}; gidiş ${s.out.weekdays.join('/')} ${s.out.times.join(', ')}, en ucuz ${s.out.cheapest?.price ?? '-'}; dönüş ${s.in.weekdays.join('/') || '-'}, en ucuz ${s.in.cheapest?.price ?? '-'}`);
  if (warnings.length) console.log('\nUyarılar:\n- ' + warnings.join('\n- '));
}

main().catch(e => { console.error('HATA:', e); process.exit(1); });
