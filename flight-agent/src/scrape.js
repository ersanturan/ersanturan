'use strict';
const { buildSearchUrl } = require('./tfs');
const { parseRow, flightKey } = require('./parse');
const { dismissConsent, sleep, jitter } = require('./browser');

const ROW = 'li.pIav2d';
const NO_RESULT_RE = /No nonstop flights found|No flights found|No results|couldn't find any|Try changing your dates/i;
const BLOCK_RE = /unusual traffic|not a robot|recaptcha|automated queries/i;

class BlockedError extends Error { constructor() { super('Google, otomatik trafik tespit etti (captcha). Tarama durduruldu; bir süre sonra tekrar deneyin.'); this.name = 'BlockedError'; } }

async function waitForResults(page, timeout = 45000) {
  await page.waitForFunction(
    ([row, noRe, blockRe]) => {
      const t = document.body.innerText || '';
      return !!document.querySelector(row) || new RegExp(noRe, 'i').test(t) || new RegExp(blockRe, 'i').test(t);
    },
    [ROW, NO_RESULT_RE.source, BLOCK_RE.source],
    { timeout }
  );
  let text = await page.evaluate(() => document.body.innerText || '');
  if (BLOCK_RE.test(text)) throw new BlockedError();
  // Google satırları hemen basıp arka planda sonuç çekmeye devam eder; kısa bir oturma süresi bırak.
  await sleep(2000);
  if (!(await page.locator(ROW).count())) {
    // "Sonuç yok" sayfası: geç gelen satırlara karşı kısa bir ikinci kontrol.
    await sleep(2500);
    text = await page.evaluate(() => document.body.innerText || '');
    if (BLOCK_RE.test(text)) throw new BlockedError();
  }
}

/** "View more flights" düğmesi varsa açar; böylece gizli "diğer uçuşlar" da listeye girer. */
async function expandAll(page) {
  for (let i = 0; i < 3; i++) {
    const btn = page.locator('button[aria-label*="more flights" i], button:has-text("more flights")').first();
    if (!(await btn.count()) || !(await btn.isVisible().catch(() => false))) break;
    await btn.click().catch(() => {});
    await sleep(1200);
  }
}

async function readRows(page) {
  const rows = await page.evaluate((sel) => {
    const out = [];
    for (const li of document.querySelectorAll(sel)) {
      if (!li.offsetHeight) continue; // gizli kopyaları atla
      const aria = Array.from(li.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label') || '')
        .find(a => /^From /.test(a) || /Leaves .* and arrives/.test(a)) || '';
      const lines = (li.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      out.push({ aria, lines });
    }
    return out;
  }, ROW);
  const seen = new Set();
  const flights = [];
  for (const r of rows) {
    const f = parseRow(r);
    if (!f.depTime || f.price === null) continue;
    const k = flightKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    flights.push(f);
  }
  return flights;
}

/** Sayfalar arası nezaket beklemesi (ms). Google'ı yormamak için istekler yavaş tutulur. */
const pacing = { min: 3000, max: 5000 };
function setPacing(min, max) { pacing.min = min; pacing.max = max; }

async function gotoSearch(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sleep(jitter(pacing.min, pacing.max));
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await dismissConsent(page);
      await waitForResults(page);
      return;
    } catch (e) {
      if (e instanceof BlockedError) throw e;
      if (attempt === 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}

/** Belirli bir gün için tek yön direkt uçuşları listeler. */
async function scanOneWay(page, { date, from, to, maxStops, passengers, seat, currency }) {
  const url = buildSearchUrl({ legs: [{ date, from, to, maxStops }], passengers, seat, trip: 'oneWay' }, { currency });
  await gotoSearch(page, url);
  await expandAll(page);
  const flights = await readRows(page);
  return { date, searchUrl: url, flights: flights.map(f => ({ ...f, date })) };
}

/**
 * Gidiş-dönüş aramasında verilen gidiş + dönüş uçuşunu seçerek Google'ın
 * gösterdiği gerçek gidiş-dönüş toplam fiyatını okur.
 */
async function verifyRoundTrip(page, { outbound, inbound, from, to, maxStops, passengers, seat, currency }) {
  const url = buildSearchUrl({
    legs: [{ date: outbound.date, from, to, maxStops }, { date: inbound.date, from: to, to: from, maxStops }],
    passengers, seat, trip: 'roundTrip',
  }, { currency });
  await gotoSearch(page, url);
  await expandAll(page);
  const outRows = await readRows(page);
  const outIdx = outRows.findIndex(f => f.airline === outbound.airline && f.depTime === outbound.depTime && f.arrTime === outbound.arrTime);
  if (outIdx < 0) return { ok: false, reason: 'gidiş uçuşu gidiş-dönüş aramasında bulunamadı', searchUrl: url, outboundFrom: outRows[0]?.price ?? null };
  const rowLoc = page.locator(`${ROW}:visible`).nth(outIdx);
  await rowLoc.locator('div.yR1fYc').first().click({ timeout: 15000 });
  await page.waitForFunction(() => /Returning flights/i.test(document.body.innerText || ''), null, { timeout: 45000 });
  await sleep(jitter(800, 1500));
  await expandAll(page);
  const inRows = await readRows(page);
  const match = inRows.find(f => f.airline === inbound.airline && f.depTime === inbound.depTime && f.arrTime === inbound.arrTime);
  if (!match) return { ok: false, reason: 'dönüş uçuşu gidiş-dönüş aramasında bulunamadı', searchUrl: url, outboundFrom: outRows[outIdx].price };
  return { ok: true, total: match.price, currency: match.currency, searchUrl: url, selectionUrl: page.url(), noCarryOn: match.noCarryOn };
}

module.exports = { scanOneWay, verifyRoundTrip, BlockedError, setPacing };
