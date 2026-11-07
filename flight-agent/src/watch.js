#!/usr/bin/env node
'use strict';
/**
 * Fiyat takip agent'ı (API'siz, Google Flights tarayıcı otomasyonu).
 *
 * İzleme listesindeki her gidiş-dönüş kombinasyonu için Google Flights'ta gidiş-dönüş
 * araması açılır, aynı uçuşlar seçilir ve güncel toplam fiyat okunur. Fiyat bir önceki
 * kontrole göre düştüyse "düşüş" olarak raporlanır.
 *
 * Kurulum (bir kez):  node src/watch.js --init results/son-tarama-cuma-pazartesi.json --after 2027-02-01
 * Günlük kontrol:     node src/watch.js
 *
 * Çıktılar (results/watch/):
 *   watchlist.json  izlenen kombinasyonlar ve başlangıç fiyatları
 *   history.json    her kontrolün fiyat geçmişi
 *   son-kontrol.md  son kontrolün okunur raporu
 *   alert.md        yalnızca düşüş varsa: bildirim metni (yoksa silinir)
 * Son satırda makine-okunur özet basılır:  WATCH_SUMMARY {"drops":[...], ...}
 *
 * Bildirim (isteğe bağlı): --ntfy-topic <gizli-konu> [--email adres] [--email-always]
 *   E-posta: SENDGRID_API_KEY (+ SENDGRID_FROM veya --email-from) tanımlıysa SendGrid ile,
 *   değilse NTFY_TOKEN ile ntfy.sh üzerinden gönderilir. --ntfy-topic olmadan da e-posta gider.
 *   Düşüş varsa (veya --email-always ile her kontrolde) ntfy.sh üzerinden bildirim ve
 *   e-posta gönderilir. Repo herkese açıksa adres ve konu repoya yazılmamalı, parametreyle verilmeli.
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./browser');
const { verifyRoundTrip, BlockedError, setPacing } = require('./scrape');
const { runPool, log } = require('./pool');
const { weekdayTr } = require('./combine');
const { sendNtfy, sendEmailSendGrid } = require('./notify');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2), n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; }
  }
  return a;
}
const readJson = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const keyOf = c => `${c.depDate}_${c.retDate}`;
const fmtDate = iso => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y} ${weekdayTr(iso)}`; };
const today = () => new Date().toISOString().slice(0, 10);

function init(args, dir) {
  const src = readJson(path.resolve(args.init), null);
  if (!src) throw new Error(`Kaynak rapor bulunamadı: ${args.init}`);
  const after = args.after || '0000-00-00';
  const m = src.meta;
  const items = src.combos.filter(c => c.depDate > after).map(c => ({
    key: keyOf(c), depDate: c.depDate, retDate: c.retDate,
    outbound: { airline: c.outbound.airline, depTime: c.outbound.depTime, arrTime: c.outbound.arrTime, depAirport: c.outbound.depAirport, arrAirport: c.outbound.arrAirport },
    inbound: { airline: c.inbound.airline, depTime: c.inbound.depTime, arrTime: c.inbound.arrTime, depAirport: c.inbound.depAirport, arrAirport: c.inbound.arrAirport },
    baseline: c.verified?.ok ? c.verified.total : c.oneWaySum, baselineAt: m.scannedAt,
  })).sort((a, b) => a.depDate.localeCompare(b.depDate));
  const watchlist = {
    createdAt: new Date().toISOString(), source: args.init, after,
    origin: m.origin, destination: m.destination, passengers: m.passengers, currency: m.currency, maxStops: m.maxStops,
    minDropEur: Number(args['min-drop'] ?? 1), items,
  };
  writeJson(path.join(dir, 'watchlist.json'), watchlist);
  const history = readJson(path.join(dir, 'history.json'), { checks: [] });
  // Başlangıç fiyatlarını ilk "kontrol" olarak kaydet; ilk günlük kontrol bunlarla karşılaştırılır.
  if (!history.checks.length) {
    history.checks.push({ at: m.scannedAt, source: 'baseline', prices: Object.fromEntries(items.map(i => [i.key, { ok: true, total: i.baseline }])) });
    writeJson(path.join(dir, 'history.json'), history);
  }
  console.log(`İzleme listesi oluşturuldu: ${items.length} kombinasyon (${after} sonrası).`);
  for (const i of items) console.log(`- ${i.depDate} → ${i.retDate}: ${i.baseline} ${m.currency}`);
}

/** Her kombinasyon için en son başarılı fiyat ve en düşük fiyat. */
function lastKnown(history) {
  const last = {}, min = {};
  for (const ch of history.checks) for (const [k, p] of Object.entries(ch.prices)) if (p.ok) {
    last[k] = { total: p.total, at: ch.at };
    if (min[k] === undefined || p.total < min[k]) min[k] = p.total;
  }
  return { last, min };
}

async function check(args, dir) {
  const wl = readJson(path.join(dir, 'watchlist.json'), null);
  if (!wl) throw new Error('İzleme listesi yok. Önce --init ile oluşturun.');
  const histPath = path.join(dir, 'history.json');
  const history = readJson(histPath, { checks: [] });
  const { last, min } = lastKnown(history);
  const active = wl.items.filter(i => i.depDate >= today());
  log(`Fiyat kontrolü: ${active.length} aktif kombinasyon (${wl.items.length - active.length} tanesinin tarihi geçti).`);

  setPacing(Number(args['min-delay'] ?? 3000), Number(args['max-delay'] ?? 5000));
  const prices = {};
  const warnings = [];
  const { browser, context } = await launchBrowser();
  try {
    let n = 0;
    const poolOpts = { concurrency: 1, cooldownSec: Number(args.cooldown ?? 120), maxCooldowns: Number(args['max-cooldowns'] ?? 6) };
    const worker = async (page, t) => {
        const r = await verifyRoundTrip(page, {
          outbound: { ...t.i.outbound, date: t.i.depDate }, inbound: { ...t.i.inbound, date: t.i.retDate }, from: wl.origin, to: wl.destination, maxStops: wl.maxStops,
          passengers: wl.passengers, seat: 'economy', currency: wl.currency, loose: true,
        });
        prices[t.i.key] = r.ok
          ? { ok: true, total: r.total, link: r.selectionUrl, scheduleChanged: r.scheduleChanged, outboundFlight: r.outboundFlight, inboundFlight: r.inboundFlight }
          : { ok: false, reason: r.reason, link: r.searchUrl };
        log(`[${++n}/${active.length}] ${t.label}: ${r.ok ? `${r.total} ${wl.currency} (önceki ${last[t.i.key]?.total ?? '-'})` : `bulunamadı – ${r.reason}`}`);
    };
    await runPool(context, active.map(i => ({ i, label: `${i.depDate}→${i.retDate}` })), poolOpts, worker);
    // Zaman aşımı vb. nedeniyle okunamayanları bir kez daha dene.
    const retry = active.filter(i => !prices[i.key] || !prices[i.key].ok);
    if (retry.length) {
      log(`${retry.length} kombinasyon yeniden deneniyor`);
      n = active.length - retry.length;
      await runPool(context, retry.map(i => ({ i, label: `${i.depDate}→${i.retDate} (tekrar)` })), poolOpts, worker);
    }
  } catch (e) {
    if (e instanceof BlockedError) warnings.push(e.message); else throw e;
  } finally { await browser.close(); }
  for (const i of active) if (!prices[i.key]) { prices[i.key] = { ok: false, reason: 'kontrol tamamlanamadı (hız sınırı)' }; }

  const at = new Date().toISOString();
  history.checks.push({ at, source: 'daily', prices: Object.fromEntries(Object.entries(prices).map(([k, p]) => [k, p.ok ? { ok: true, total: p.total } : { ok: false, reason: p.reason }])) });
  writeJson(histPath, history);

  const rows = active.map(i => {
    const p = prices[i.key], prev = last[i.key]?.total ?? null;
    const diff = p.ok && prev !== null ? Math.round((p.total - prev) * 100) / 100 : null;
    return { ...i, now: p.ok ? p.total : null, prev, diff, lowest: p.ok ? Math.min(p.total, min[i.key] ?? Infinity) : (min[i.key] ?? null),
      fromBaseline: p.ok ? Math.round((p.total - i.baseline) * 100) / 100 : null, ok: p.ok, reason: p.reason, link: p.link,
      scheduleChanged: p.scheduleChanged, outboundFlight: p.outboundFlight, inboundFlight: p.inboundFlight };
  });
  const drops = rows.filter(r => r.diff !== null && -r.diff >= wl.minDropEur);
  const rises = rows.filter(r => r.diff !== null && r.diff > 0);
  const unavailable = rows.filter(r => !r.ok);
  const cheapest = rows.filter(r => r.ok).sort((a, b) => a.now - b.now)[0] || null;
  const cur = wl.currency;

  const md = [];
  md.push(`# ESB → CDG Cuma–Pazartesi fiyat takibi`, '');
  md.push(`- Son kontrol: ${at}`);
  md.push(`- Yolcular: ${wl.passengers.adults} yetişkin + ${wl.passengers.infantsOnLap} kucakta bebek, gidiş-dönüş toplam (${cur}), yalnızca direkt`);
  md.push(`- Düşüş: ${drops.length}, artış: ${rises.length}, değişmeyen: ${rows.length - drops.length - rises.length - unavailable.length}, kontrol edilemeyen: ${unavailable.length}`);
  if (cheapest) md.push(`- Şu an en ucuzu: ${fmtDate(cheapest.depDate)} → ${fmtDate(cheapest.retDate)}, ${cheapest.now} ${cur}`);
  for (const w of warnings) md.push(`> ⚠️ ${w}`);
  md.push('', '| Gidiş | Dönüş | Şimdi | Önceki | Değişim | Başlangıç | En düşük | Link |', '|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const ch = r.diff === null ? '-' : r.diff < 0 ? `🔻 ${r.diff}` : r.diff > 0 ? `🔺 +${r.diff}` : '0';
    const note = r.ok ? (r.scheduleChanged ? ` (saat değişti: ${r.outboundFlight} / ${r.inboundFlight})` : '') : ` (${r.reason})`;
    md.push(`| ${fmtDate(r.depDate)} | ${fmtDate(r.retDate)} | ${r.now ?? '-'}${note} | ${r.prev ?? '-'} | ${ch} | ${r.baseline} | ${r.lowest ?? '-'} | ${r.link ? `[aç](${r.link})` : '-'} |`);
  }
  fs.writeFileSync(path.join(dir, 'son-kontrol.md'), md.join('\n') + '\n');

  const alertPath = path.join(dir, 'alert.md');
  if (drops.length) {
    const a = [`ESB→CDG fiyat düştü (${drops.length} tarih):`];
    for (const d of drops.sort((x, y) => x.now - y.now)) a.push(`- ${fmtDate(d.depDate)} → ${fmtDate(d.retDate)}: ${d.prev} → ${d.now} ${cur} (${d.diff})${d.now <= d.lowest ? ', şimdiye kadarki en düşük' : ''} ${d.link || ''}`);
    fs.writeFileSync(alertPath, a.join('\n') + '\n');
  } else if (fs.existsSync(alertPath)) fs.unlinkSync(alertPath);

  // Bildirim / e-posta
  let notified = null;
  const wantEmail = !!args.email, viaSendGrid = wantEmail && !!process.env.SENDGRID_API_KEY;
  if ((args['ntfy-topic'] || viaSendGrid) && (drops.length || args['email-always'])) {
    const lines = [];
    if (drops.length) {
      lines.push(`Fiyatı düşen ${drops.length} tarih (2 yetişkin + 1 bebek, gidiş-dönüş toplam):`, '');
      for (const d of drops.sort((x, y) => x.now - y.now)) {
        lines.push(`• ${fmtDate(d.depDate)} → ${fmtDate(d.retDate)}: ${d.prev} → ${d.now} ${cur} (${d.diff} ${cur})${d.now <= d.lowest ? ' – şimdiye kadarki en düşük' : ''}`);
        if (d.link) lines.push(`  ${d.link}`);
      }
    } else lines.push('Bugün fiyat düşüşü yok.');
    lines.push('');
    if (cheapest) lines.push(`Şu an en ucuz Cuma–Pazartesi: ${fmtDate(cheapest.depDate)} → ${fmtDate(cheapest.retDate)}, ${cheapest.now} ${cur}`);
    lines.push(`Kontrol edilen: ${rows.length}, okunamayan: ${unavailable.length}. Uçuşlar AJet direkt ESB–CDG, kabin bagajı dahil değil.`);
    lines.push('Tüm tablo: https://github.com/ersanturan/ersanturan/blob/HEAD/flight-agent/results/watch/son-kontrol.md');
    const title = drops.length
      ? `ESB–CDG fiyat düştü: ${drops.length} tarih, en düşük ${Math.min(...drops.map(d => d.now))} ${cur}`
      : `ESB–CDG günlük kontrol: düşüş yok, en ucuz ${cheapest ? cheapest.now + ' ' + cur : '-'}`;
    const text = lines.join('\n');
    notified = { ok: true };
    if (args['ntfy-topic']) {
      try {
        const r = sendNtfy({ topic: args['ntfy-topic'], title, message: text, email: (wantEmail && !viaSendGrid) ? args.email : undefined, click: drops[0]?.link, tags: drops.length ? 'airplane,chart_with_downwards_trend' : 'airplane' });
        notified.ntfy = { ok: true, id: r.id };
        log(`ntfy bildirimi gönderildi: ${r.id}`);
      } catch (e) { notified.ok = false; notified.ntfy = { ok: false, error: String(e.stdout || e.stderr || e.message).slice(0, 300) }; log(`!! ntfy bildirimi gönderilemedi: ${notified.ntfy.error}`); }
    }
    if (viaSendGrid) {
      try {
        sendEmailSendGrid({ to: args.email, from: args['email-from'] || process.env.SENDGRID_FROM, subject: title, text });
        notified.email = { ok: true, via: 'sendgrid', to: args.email };
        log(`E-posta gönderildi (SendGrid): ${args.email}`);
      } catch (e) { notified.ok = false; notified.email = { ok: false, via: 'sendgrid', error: String(e.message).slice(0, 300) }; log(`!! E-posta gönderilemedi: ${notified.email.error}`); }
    }
  }

  console.log(md.slice(0, 6).join('\n'));
  const summary = {
    at, checked: rows.length, ok: rows.length - unavailable.length, unavailable: unavailable.length, warnings,
    drops: drops.map(d => ({ depDate: d.depDate, retDate: d.retDate, prev: d.prev, now: d.now, diff: d.diff, allTimeLow: d.now <= d.lowest, link: d.link })),
    cheapest: cheapest ? { depDate: cheapest.depDate, retDate: cheapest.retDate, now: cheapest.now } : null, currency: cur, notified,
  };
  console.log('WATCH_SUMMARY ' + JSON.stringify(summary));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir || 'results/watch');
  fs.mkdirSync(dir, { recursive: true });
  if (args.init) return init(args, dir);
  return check(args, dir);
}

main().catch(e => { console.error('HATA:', e); process.exit(1); });
