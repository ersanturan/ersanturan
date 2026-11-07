#!/usr/bin/env node
'use strict';
/**
 * Ankara → Paris direkt uçuş tarama agent'ı.
 *
 * Google Flights'ı (API kullanmadan, tarayıcı otomasyonuyla) tarar:
 *  1. Tarih aralığındaki her gün için gidiş ve dönüş yönünde tek yön direkt uçuşları toplar.
 *  2. Kalış süresi kısıtına uyan gidiş/dönüş çiftlerini oluşturur, toplam fiyata göre sıralar.
 *  3. En ucuz N alternatif için gidiş-dönüş aramasında uçuşları seçip gerçek toplamı doğrular.
 *  4. Sonuçları Markdown, CSV ve JSON olarak yazar.
 *
 * Kullanım: node src/agent.js [--config config.json] [--start 2027-02-01 --end 2027-03-31 ...]
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./browser');
const { scanOneWay, verifyRoundTrip, BlockedError, setPacing } = require('./scrape');
const { sleep } = require('./browser');
const { combine, addDays, dateRange } = require('./combine');
const { writeReports } = require('./report');
const { buildSearchUrl } = require('./tfs');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true; else { args[key] = next; i++; }
  }
  return args;
}

function loadConfig(args) {
  const cfgPath = path.resolve(args.config || path.join(__dirname, '..', 'config.json'));
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  const list = v => (Array.isArray(v) ? v : String(v).split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
  const num = (v, d) => (v === undefined ? d : Number(v));
  return {
    origin: list(args.from || cfg.origin || ['ESB']),
    destination: list(args.to || cfg.destination || ['CDG', 'ORY']),
    startDate: args.start || cfg.startDate || '2027-02-01',
    endDate: args.end || cfg.endDate || '2027-03-31',
    minStay: num(args['min-stay'], cfg.minStay ?? 2),
    maxStay: num(args['max-stay'], cfg.maxStay ?? 4),
    passengers: {
      adults: num(args.adults, cfg.adults ?? 2),
      children: num(args.children, cfg.children ?? 0),
      infantsInSeat: num(args['infants-seat'], cfg.infantsInSeat ?? 0),
      infantsOnLap: num(args['infants-lap'], cfg.infantsOnLap ?? 1),
    },
    maxStops: num(args['max-stops'], cfg.maxStops ?? 0),
    seat: args.seat || cfg.seat || 'economy',
    currency: (args.currency || cfg.currency || 'EUR').toUpperCase(),
    concurrency: num(args.concurrency, cfg.concurrency ?? 1),
    minDelayMs: num(args['min-delay'], cfg.minDelayMs ?? 3000),
    maxDelayMs: num(args['max-delay'], cfg.maxDelayMs ?? 5000),
    cooldownSec: num(args.cooldown, cfg.cooldownSec ?? 120),
    maxCooldowns: num(args['max-cooldowns'], cfg.maxCooldowns ?? 3),
    verifyTop: num(args['verify-top'], cfg.verifyTop ?? 20),
    outDir: path.resolve(args.out || cfg.outDir || 'results'),
    headless: args.headed ? false : (cfg.headless ?? true),
    noCache: !!args['no-cache'],
  };
}

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

/**
 * Basit işçi havuzu: N sayfa ile görev listesini işler.
 * Google captcha gösterirse captcha çözülmeye çalışılmaz; belirlenen soğuma
 * süresi kadar beklenir ve görev yeniden kuyruğa alınır. Soğuma hakkı bitince durur.
 */
async function runPool(context, tasks, { concurrency, cooldownSec, maxCooldowns }, worker) {
  const queue = tasks.slice();
  let blocked = null, cooldowns = 0, pausedUntil = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    const page = await context.newPage();
    try {
      while (queue.length && !blocked) {
        if (Date.now() < pausedUntil) { await sleep(1000); continue; }
        const task = queue.shift();
        try { await worker(page, task); }
        catch (e) {
          if (e instanceof BlockedError) {
            queue.unshift(task);
            if (cooldowns >= maxCooldowns) { blocked = e; break; }
            cooldowns++;
            pausedUntil = Date.now() + cooldownSec * 1000;
            log(`!! Google hız sınırı/captcha gösterdi; ${cooldownSec} sn bekleniyor (${cooldowns}/${maxCooldowns})`);
            continue;
          }
          log(`  ! ${task.label || ''}: ${e.message.split('\n')[0]}`); task.error = e.message;
        }
      }
    } finally { await page.close().catch(() => {}); }
  });
  await Promise.all(runners);
  if (blocked) throw blocked;
}

async function main() {
  const cfg = loadConfig(parseArgs(process.argv.slice(2)));
  const cacheDir = path.join(cfg.outDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheKey = s => path.join(cacheDir, s.replace(/[^a-z0-9_.-]/gi, '_') + '.json');
  const readCache = k => (!cfg.noCache && fs.existsSync(cacheKey(k))) ? JSON.parse(fs.readFileSync(cacheKey(k), 'utf8')) : null;
  const writeCache = (k, v) => fs.writeFileSync(cacheKey(k), JSON.stringify(v));

  const outDates = dateRange(cfg.startDate, cfg.endDate);
  const inDates = dateRange(addDays(cfg.startDate, cfg.minStay), addDays(cfg.endDate, cfg.maxStay));
  log(`Tarama: ${cfg.origin.join('/')} → ${cfg.destination.join('/')}, gidiş ${cfg.startDate}..${cfg.endDate} (${outDates.length} gün), dönüş ${inDates[0]}..${inDates[inDates.length - 1]} (${inDates.length} gün)`);
  log(`Yolcu: ${JSON.stringify(cfg.passengers)}, aktarma ≤ ${cfg.maxStops}, para birimi ${cfg.currency}, eşzamanlı sayfa ${cfg.concurrency}, istekler arası ${cfg.minDelayMs}-${cfg.maxDelayMs} ms`);

  const warnings = [];
  const oneWay = { outbound: {}, inbound: {} };
  const legOpts = { maxStops: cfg.maxStops, passengers: cfg.passengers, seat: cfg.seat, currency: cfg.currency };
  const tasks = [
    ...outDates.map(date => ({ dir: 'outbound', date, from: cfg.origin, to: cfg.destination, label: `gidiş ${date}` })),
    ...inDates.map(date => ({ dir: 'inbound', date, from: cfg.destination, to: cfg.origin, label: `dönüş ${date}` })),
  ];

  setPacing(cfg.minDelayMs, cfg.maxDelayMs);
  const poolOpts = { concurrency: cfg.concurrency, cooldownSec: cfg.cooldownSec, maxCooldowns: cfg.maxCooldowns };
  const { browser, context } = await launchBrowser({ headless: cfg.headless });
  let done = 0;
  try {
    await runPool(context, tasks, poolOpts, async (page, t) => {
      const key = `oneway_${t.dir}_${t.from.join('-')}_${t.to.join('-')}_${t.date}_${cfg.currency}_${JSON.stringify(cfg.passengers)}_${cfg.maxStops}`;
      let res = readCache(key);
      if (!res) { res = await scanOneWay(page, { date: t.date, from: t.from, to: t.to, ...legOpts }); writeCache(key, res); }
      oneWay[t.dir][t.date] = res.flights;
      done++;
      log(`[${done}/${tasks.length}] ${t.label}: ${res.flights.length} direkt uçuş${res.flights.length ? ' – ' + res.flights.map(f => `${f.airline} ${f.depTime} ${f.price} ${f.currency}`).join('; ') : ''}`);
    });
  } catch (e) {
    if (e instanceof BlockedError) { warnings.push(e.message); log('!!', e.message); } else throw e;
  }
  for (const t of tasks) if (t.error) warnings.push(`${t.label} taranamadı: ${t.error.split('\n')[0]}`);

  const combos = combine({ outbound: oneWay.outbound, inbound: oneWay.inbound, minStay: cfg.minStay, maxStay: cfg.maxStay });
  for (const c of combos) {
    c.searchUrl = buildSearchUrl({
      legs: [{ date: c.depDate, from: cfg.origin, to: cfg.destination, maxStops: cfg.maxStops }, { date: c.retDate, from: cfg.destination, to: cfg.origin, maxStops: cfg.maxStops }],
      passengers: cfg.passengers, seat: cfg.seat, trip: 'roundTrip',
    }, { currency: cfg.currency });
  }
  log(`Toplam ${combos.length} gidiş/dönüş kombinasyonu bulundu.`);

  // Gidiş-dönüş doğrulaması (en ucuz N)
  const toVerify = combos.slice(0, cfg.verifyTop);
  if (toVerify.length && !warnings.some(w => /captcha/.test(w))) {
    log(`En ucuz ${toVerify.length} alternatif gidiş-dönüş aramasıyla doğrulanıyor...`);
    let v = 0;
    try {
      await runPool(context, toVerify.map((c, i) => ({ c, label: `doğrulama #${i + 1} ${c.depDate}→${c.retDate}` })), poolOpts, async (page, t) => {
        const key = `rt_${t.c.depDate}_${t.c.retDate}_${t.c.outbound.airline}_${t.c.outbound.depTime}_${t.c.inbound.depTime}_${cfg.currency}_${JSON.stringify(cfg.passengers)}`;
        let r = readCache(key);
        if (!r) { r = await verifyRoundTrip(page, { outbound: t.c.outbound, inbound: t.c.inbound, from: cfg.origin, to: cfg.destination, ...legOpts }); writeCache(key, r); }
        t.c.verified = r;
        v++;
        log(`[${v}/${toVerify.length}] ${t.label}: tek yön toplamı ${t.c.oneWaySum} → gidiş-dönüş ${r.ok ? r.total + ' ' + r.currency : 'doğrulanamadı (' + r.reason + ')'}`);
      });
    } catch (e) { if (e instanceof BlockedError) { warnings.push('Doğrulama sırasında: ' + e.message); } else throw e; }
    // Doğrulanmış toplam varsa ona göre yeniden sırala
    combos.sort((a, b) => (a.verified?.ok ? a.verified.total : a.oneWaySum) - (b.verified?.ok ? b.verified.total : b.oneWaySum));
  }
  await browser.close();

  const meta = {
    scannedAt: new Date().toISOString(), origin: cfg.origin, destination: cfg.destination, startDate: cfg.startDate, endDate: cfg.endDate,
    minStay: cfg.minStay, maxStay: cfg.maxStay, passengers: cfg.passengers, maxStops: cfg.maxStops, currency: cfg.currency, verifyTop: toVerify.length,
    scannedOutboundDays: outDates.length, scannedInboundDays: inDates.length,
    outboundDaysWithFlights: Object.values(oneWay.outbound).filter(f => f.length).length,
    inboundDaysWithFlights: Object.values(oneWay.inbound).filter(f => f.length).length,
    warnings,
  };
  const files = writeReports({ outDir: cfg.outDir, combos, oneWay, meta });
  log(`Rapor yazıldı: ${files.md}`);

  // Konsola kısa özet
  console.log(`\nEn ucuz ${Math.min(10, combos.length)} alternatif (${cfg.passengers.adults} yetişkin + ${cfg.passengers.infantsOnLap} bebek, toplam ${cfg.currency}):`);
  combos.slice(0, 10).forEach((c, i) => console.log(`${String(i + 1).padStart(2)}. ${c.depDate} → ${c.retDate} (${c.stayDays} gün)  ${c.outbound.airline} ${c.outbound.depTime} / ${c.inbound.airline} ${c.inbound.depTime}  tek yön toplamı ${c.oneWaySum}${c.verified?.ok ? `, gidiş-dönüş ${c.verified.total}` : ''}`));
  if (warnings.length) console.log('\nUyarılar:\n- ' + warnings.join('\n- '));
}

main().catch(e => { console.error('HATA:', e); process.exit(1); });
