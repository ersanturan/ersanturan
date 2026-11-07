'use strict';

function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dateRange(start, end) { const out = []; for (let d = start; d <= end; d = addDays(d, 1)) out.push(d); return out; }
const TR_DAYS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
function weekdayTr(iso) { return TR_DAYS[new Date(iso + 'T00:00:00Z').getUTCDay()]; }

/** Gidiş ve dönüş tek yön sonuçlarını kalış süresine göre eşleştirir ve toplam fiyata göre sıralar. */
function combine({ outbound, inbound, minStay, maxStay }) {
  const combos = [];
  for (const [depDate, outFlights] of Object.entries(outbound)) {
    for (let stay = minStay; stay <= maxStay; stay++) {
      const retDate = addDays(depDate, stay);
      const inFlights = inbound[retDate];
      if (!inFlights) continue;
      for (const o of outFlights) for (const i of inFlights) {
        if (o.price === null || i.price === null) continue;
        combos.push({
          depDate, retDate, stayDays: stay,
          outbound: o, inbound: i,
          oneWaySum: Math.round((o.price + i.price) * 100) / 100,
          currency: o.currency || i.currency,
        });
      }
    }
  }
  combos.sort((a, b) => a.oneWaySum - b.oneWaySum || a.depDate.localeCompare(b.depDate));
  return combos;
}

module.exports = { combine, addDays, dateRange, weekdayTr };
