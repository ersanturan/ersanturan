'use strict';
/** Google Flights sonuç satırını (aria-label + görünür metin) yapısal veriye çevirir. */

const TIME_RE = /^\d{1,2}:\d{2}\s?(AM|PM)?(\s?\+\d)?$/i;

function parseDuration(s) {
  const m = /(\d+)\s*hr(?:\s*(\d+)\s*min)?/.exec(s || '') || /(\d+)\s*min/.exec(s || '');
  if (!m) return null;
  if (/hr/.test(m[0])) return parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
  return parseInt(m[1], 10);
}

function parseRow({ aria = '', lines = [] }) {
  const text = lines.join(' | ');
  let price = null, currency = null;
  const pm = /From ([\d,\.]+) ([A-Za-z ]+?)(?: round trip)?\s*(?:total)?\./.exec(aria);
  if (pm) { price = parseFloat(pm[1].replace(/,/g, '')); currency = pm[2].trim(); }
  if (price === null) {
    const lm = /([€$£₺])\s?([\d,\.]+)|([\d,\.]+)\s?(TRY|TL|EUR|USD)/.exec(text);
    if (lm) { price = parseFloat((lm[2] || lm[3]).replace(/,/g, '')); currency = lm[1] || lm[4]; }
  }
  const times = lines.filter(l => TIME_RE.test(l));
  const depTime = times[0] || null;
  const arrTime = times[1] || null;
  const am = /(Nonstop|\d+ stops?) flight with ([^.]+?)\./i.exec(aria);
  let airline = am ? am[2].trim() : null;
  if (!airline) {
    const idx = lines.findIndex(l => TIME_RE.test(l));
    airline = lines.slice(idx + 1).find(l => !TIME_RE.test(l) && !/^[–-]$/.test(l) && !/hr|min/.test(l)) || null;
  }
  const dm = /Total duration ([^.]+)\./.exec(aria);
  const durationMin = parseDuration(dm ? dm[1] : lines.find(l => /\d+\s*hr|\d+\s*min/.test(l)));
  const ap = /\b([A-Z]{3})[–-]([A-Z]{3})\b/.exec(text);
  const stops = /Nonstop/i.test(text) ? 0 : (() => { const s = /(\d+) stop/.exec(text); return s ? parseInt(s[1], 10) : null; })();
  const nm = /Leaves (.+?) at .+? and arrives at (.+?) at /.exec(aria);
  return {
    airline, depTime, arrTime, durationMin,
    depAirport: ap ? ap[1] : null, arrAirport: ap ? ap[2] : null,
    depAirportName: nm ? nm[1] : null, arrAirportName: nm ? nm[2] : null,
    stops, price, currency,
    noCarryOn: /does not include overhead bin|doesn't include overhead bin/i.test(aria + ' ' + text),
    raw: text,
  };
}

function flightKey(f) { return [f.airline, f.depAirport, f.arrAirport, f.depTime, f.arrTime].join('|'); }

module.exports = { parseRow, parseDuration, flightKey };
