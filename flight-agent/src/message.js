'use strict';
/** Günlük fiyat kontrolü için bildirim/e-posta metni (düz metin + HTML) üretir. */
const { weekdayTr } = require('./combine');

const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const shortDate = iso => { const [, m, d] = iso.split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${weekdayTr(iso)}`; };
const pair = r => `${shortDate(r.depDate)} → ${shortDate(r.retDate)}`;
const signed = v => (v > 0 ? `+${v}` : `${v}`);
const pct = (diff, base) => (base ? `${diff > 0 ? '+' : diff < 0 ? '-' : ''}%${Math.abs(diff / base * 100).toFixed(1).replace('.', ',')}` : '');
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
  const pax = `${passengers.adults} yetişkin + ${passengers.infantsOnLap} kucakta bebek`;
  const dropsS = drops.slice().sort((a, b) => a.diff - b.diff);
  const risesS = rises.slice().sort((a, b) => b.diff - a.diff);

  let title;
  if (drops.length && rises.length) title = `ESB–CDG fiyatlar değişti: ${drops.length} düşüş, ${rises.length} artış`;
  else if (drops.length) title = `ESB–CDG fiyat düştü: ${drops.length} tarih, en düşük ${Math.min(...drops.map(d => d.now))} ${cur}`;
  else if (rises.length) title = `ESB–CDG fiyat arttı: ${rises.length} tarih`;
  else title = `ESB–CDG günlük kontrol: değişiklik yok`;
  if (cheapest) title += ` · en ucuz ${cheapest.now} ${cur}`;

  // Düz metin
  const t = [];
  t.push(`Ankara (ESB) – Paris (CDG) direkt, Cuma gidiş / Pazartesi dönüş. Fiyatlar ${pax} için gidiş-dönüş toplamıdır (${cur}).`, '');
  t.push(`Dünden bugüne: ${drops.length} düşüş, ${rises.length} artış, ${unchanged.length} değişmeyen${unavailable.length ? `, ${unavailable.length} okunamayan` : ''}.`, '');
  if (dropsS.length) { t.push('FİYATI DÜŞENLER'); for (const r of dropsS) t.push(`▼ ${describe(r, cur)}`); t.push(''); }
  if (risesS.length) { t.push('FİYATI ARTANLAR'); for (const r of risesS) t.push(`▲ ${describe(r, cur)}`); t.push(''); }
  if (cheapest) t.push(`Şu an en ucuz: ${pair(cheapest)}, ${cheapest.now} ${cur}`, '');
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
  h.push(`<p style="font-size:15px"><b>Dünden bugüne:</b> <span style="color:#137333">${drops.length} düşüş</span>, <span style="color:#c5221f">${rises.length} artış</span>, ${unchanged.length} değişmeyen${unavailable.length ? `, ${unavailable.length} okunamayan` : ''}.</p>`);
  h.push(list(dropsS, '▼', 'Fiyatı düşenler', '#137333'));
  h.push(list(risesS, '▲', 'Fiyatı artanlar', '#c5221f'));
  if (cheapest) h.push(`<p style="margin-top:16px">Şu an en ucuz: <b>${esc(pair(cheapest))}, ${cheapest.now} ${cur}</b></p>`);
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
  if (cheapest) s.push(`En ucuz: ${pair(cheapest)}, ${cheapest.now} ${cur}`);

  return { title, text: t.join('\n'), html: h.join(''), short: s.join('\n') };
}

module.exports = { buildChangeMessage };
