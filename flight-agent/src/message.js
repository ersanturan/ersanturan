'use strict';
/** Günlük fiyat kontrolü için bildirim/e-posta metni (düz metin + HTML) üretir. */
const { weekdayTr } = require('./combine');

const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const shortDate = iso => { const [, m, d] = iso.split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${weekdayTr(iso)}`; };
const pair = r => `${shortDate(r.depDate)} → ${shortDate(r.retDate)}`;
const signed = v => (v > 0 ? `+${v}` : `${v}`);
const pct = (diff, base) => (base ? `${diff > 0 ? '+' : diff < 0 ? '-' : ''}%${Math.abs(diff / base * 100).toFixed(1).replace('.', ',')}` : '');
// "1:20 PM" → "13:20"
const to24 = t => { const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(t || ''); if (!m) return t || ''; let h = Number(m[1]); const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; return `${String(h).padStart(2, '0')}:${m[2]}`; };
const flightTimes = f => (f ? `${f.airline} ${to24(f.depTime)}–${to24(f.arrTime)}` : '');
const dayChange = (r, cur) => (r.diff === null || r.diff === undefined ? 'ilk kontrol' : r.diff === 0 ? 'dünden beri değişmedi' : `dünden beri ${r.diff < 0 ? '▼' : '▲'} ${signed(r.diff)} ${cur}`);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function describe(r, cur) {
  const extra = [];
  if (r.fromBaseline !== null && r.fromBaseline !== 0) extra.push(`ilk fiyata göre ${signed(r.fromBaseline)} ${cur}`);
  if (r.diff < 0 && r.now <= r.lowest) extra.push('şimdiye kadarki en düşük');
  return `${pair(r)}: ${r.prev} → ${r.now} ${cur} (${signed(r.diff)} ${cur}, ${pct(r.diff, r.prev)})${extra.length ? ' – ' + extra.join(', ') : ''}`;
}

/**
 * @returns {{title:string, text:string, html:string, short:string}}
 */
function buildChangeMessage({ rows, drops, rises, unavailable, cheapest, cur, passengers, reportUrl }) {
  const unchanged = rows.filter(r => r.ok && r.diff === 0);
  const ranked = rows.filter(r => r.ok && r.now !== null).sort((a, b) => a.now - b.now || a.depDate.localeCompare(b.depDate));
  const best = ranked[0] || null, next = ranked.slice(1, 3);
  const pax = `${passengers.adults} yetişkin + ${passengers.infantsOnLap} kucakta bebek`;
  const dropsS = drops.slice().sort((a, b) => a.diff - b.diff);
  const risesS = rises.slice().sort((a, b) => b.diff - a.diff);

  let title;
  if (drops.length && rises.length) title = `ESB–CDG fiyatlar değişti: ${drops.length} düşüş, ${rises.length} artış`;
  else if (drops.length) title = `ESB–CDG fiyat düştü: ${drops.length} tarih, en düşük ${Math.min(...drops.map(d => d.now))} ${cur}`;
  else if (rises.length) title = `ESB–CDG fiyat arttı: ${rises.length} tarih`;
  else title = `ESB–CDG günlük kontrol: değişiklik yok`;
  if (cheapest) title += ` · günün en ucuzu ${shortDate(cheapest.depDate)}–${shortDate(cheapest.retDate)} ${cheapest.now} ${cur}`;

  // Düz metin
  const t = [];
  t.push(`Ankara (ESB) – Paris (CDG) direkt, Cuma gidiş / Pazartesi dönüş. Fiyatlar ${pax} için gidiş-dönüş toplamıdır (${cur}).`, '');
  if (best) {
    t.push('★ GÜNÜN EN UYGUN ALTERNATİFİ');
    t.push(`  ${pair(best)}: ${best.now} ${cur} (${dayChange(best, cur)})`);
    t.push(`  Gidiş ${flightTimes(best.outbound)} · Dönüş ${flightTimes(best.inbound)}`);
    if (best.link) t.push(`  ${best.link}`);
    if (next.length) t.push(`  Sıradaki en ucuzlar: ${next.map((r, i) => `${i + 2}) ${pair(r)} ${r.now} ${cur}`).join(' · ')}`);
    t.push('');
  }
  t.push(`Dünden bugüne: ${drops.length} düşüş, ${rises.length} artış, ${unchanged.length} değişmeyen${unavailable.length ? `, ${unavailable.length} okunamayan` : ''}.`, '');
  if (dropsS.length) { t.push('FİYATI DÜŞENLER'); for (const r of dropsS) t.push(`▼ ${describe(r, cur)}`); t.push(''); }
  if (risesS.length) { t.push('FİYATI ARTANLAR'); for (const r of risesS) t.push(`▲ ${describe(r, cur)}`); t.push(''); }
  t.push('TÜM TARİHLER (bugün / dün / değişim / ilk fiyat / en düşük)');
  for (const r of rows) {
    if (!r.ok) { t.push(`  ${pair(r)}: okunamadı (${r.reason})`); continue; }
    const ch = r.diff === null ? '-' : r.diff === 0 ? '=' : `${r.diff < 0 ? '▼' : '▲'} ${signed(r.diff)}`;
    t.push(`  ${pair(r)}: ${r.now} / ${r.prev ?? '-'} / ${ch} / ${r.baseline} / ${r.lowest}`);
  }
  t.push('', 'Uçuşlar AJet; temel ücrette kabin bagajı dahil değildir.');
  if (reportUrl) t.push(`Ayrıntılı tablo: ${reportUrl}`);

  // HTML
  const color = d => (d < 0 ? '#137333' : d > 0 ? '#c5221f' : '#5f6368');
  const changeCell = r => (r.diff === null ? '–' : r.diff === 0 ? '=' : `<span style="color:${color(r.diff)};font-weight:600">${r.diff < 0 ? '▼' : '▲'} ${signed(r.diff)} (${pct(r.diff, r.prev)})</span>`);
  const td = 'style="padding:6px 10px;border-bottom:1px solid #e0e0e0;white-space:nowrap"';
  const th = 'style="padding:6px 10px;border-bottom:2px solid #bdbdbd;text-align:left;white-space:nowrap"';
  const list = (items, sym, head, col) => items.length
    ? `<h3 style="margin:18px 0 6px;color:${col}">${head}</h3><ul style="margin:0;padding-left:18px">${items.map(r =>
      `<li style="margin:4px 0">${sym} <b>${esc(pair(r))}</b>: ${r.prev} → <b>${r.now} ${cur}</b> (${signed(r.diff)} ${cur}, ${pct(r.diff, r.prev)})` +
      `${r.fromBaseline ? `, ilk fiyata göre ${signed(r.fromBaseline)}` : ''}${r.diff < 0 && r.now <= r.lowest ? ' · <b>şimdiye kadarki en düşük</b>' : ''}` +
      `${r.link ? ` · <a href="${esc(r.link)}">Google Flights</a>` : ''}</li>`).join('')}</ul>` : '';
  const h = [];
  h.push('<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#202124;max-width:720px">');
  h.push(`<p>Ankara (ESB) – Paris (CDG) direkt, <b>Cuma gidiş / Pazartesi dönüş</b>. Fiyatlar ${esc(pax)} için gidiş-dönüş toplamıdır (${cur}).</p>`);
  if (best) {
    h.push('<div style="border:2px solid #1a73e8;border-radius:8px;padding:12px 16px;margin:12px 0;background:#e8f0fe">');
    h.push('<div style="font-size:12px;letter-spacing:.5px;color:#1a73e8;font-weight:700">★ GÜNÜN EN UYGUN ALTERNATİFİ</div>');
    h.push(`<div style="font-size:18px;margin:6px 0"><b>${esc(pair(best))}</b> — <b style="font-size:22px">${best.now} ${cur}</b></div>`);
    h.push(`<div style="color:${best.diff ? color(best.diff) : '#5f6368'}">${esc(dayChange(best, cur))}${best.lowest !== undefined && best.now <= best.lowest ? ' · şimdiye kadarki en düşük fiyatı' : ''}</div>`);
    h.push(`<div style="margin-top:4px">Gidiş ${esc(flightTimes(best.outbound))} · Dönüş ${esc(flightTimes(best.inbound))}</div>`);
    if (best.link) h.push(`<div style="margin-top:8px"><a href="${esc(best.link)}" style="background:#1a73e8;color:#fff;padding:6px 12px;border-radius:4px;text-decoration:none">Google Flights'ta aç</a></div>`);
    if (next.length) h.push(`<div style="margin-top:10px;font-size:13px;color:#3c4043">Sıradaki en ucuzlar: ${next.map((r, i) => `${i + 2}) ${esc(pair(r))} <b>${r.now} ${cur}</b>`).join(' · ')}</div>`);
    h.push('</div>');
  }
  h.push(`<p style="font-size:15px"><b>Dünden bugüne:</b> <span style="color:#137333">${drops.length} düşüş</span>, <span style="color:#c5221f">${rises.length} artış</span>, ${unchanged.length} değişmeyen${unavailable.length ? `, ${unavailable.length} okunamayan` : ''}.</p>`);
  h.push(list(dropsS, '▼', 'Fiyatı düşenler', '#137333'));
  h.push(list(risesS, '▲', 'Fiyatı artanlar', '#c5221f'));
  h.push('<h3 style="margin:18px 0 6px">Tüm tarihler</h3><table style="border-collapse:collapse;font-size:13px">');
  h.push(`<tr><th ${th}>Cuma → Pazartesi</th><th ${th}>Bugün</th><th ${th}>Dün</th><th ${th}>Değişim</th><th ${th}>İlk fiyat</th><th ${th}>En düşük</th><th ${th}></th></tr>`);
  for (const r of rows) {
    const bg = r.diff < 0 ? ' style="background:#e6f4ea"' : r.diff > 0 ? ' style="background:#fce8e6"' : '';
    if (!r.ok) { h.push(`<tr><td ${td}>${esc(pair(r))}</td><td ${td} colspan="6">okunamadı (${esc(r.reason || '')})</td></tr>`); continue; }
    h.push(`<tr${bg}><td ${td}>${esc(pair(r))}</td><td ${td}><b>${r.now}</b></td><td ${td}>${r.prev ?? '–'}</td><td ${td}>${changeCell(r)}</td><td ${td}>${r.baseline}</td><td ${td}>${r.lowest}</td><td ${td}>${r.link ? `<a href="${esc(r.link)}">aç</a>` : ''}</td></tr>`);
  }
  h.push('</table>');
  h.push(`<p style="color:#5f6368;font-size:12px;margin-top:16px">Uçuşlar AJet; temel ücrette kabin bagajı dahil değildir. Fiyatlar Google Flights'tan her akşam okunur.${reportUrl ? ` <a href="${esc(reportUrl)}">Ayrıntılı tablo</a>` : ''}</p></div>`);

  // Kısa (ntfy) metin
  const s = [];
  s.push(`${drops.length} düşüş, ${rises.length} artış, ${unchanged.length} değişmeyen.`);
  for (const r of dropsS.slice(0, 5)) s.push(`▼ ${pair(r)}: ${r.prev} → ${r.now} ${cur}`);
  for (const r of risesS.slice(0, 5)) s.push(`▲ ${pair(r)}: ${r.prev} → ${r.now} ${cur}`);
  if (best) s.push(`★ Günün en ucuzu: ${pair(best)}, ${best.now} ${cur} (${dayChange(best, cur)})`);

  return { title, text: t.join('\n'), html: h.join(''), short: s.join('\n') };
}

module.exports = { buildChangeMessage };
