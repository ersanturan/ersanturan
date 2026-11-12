'use strict';
/**
 * VFS yanıtlarını yorumlama ve "bildirim gitsin mi" kararı. Tarayıcıdan bağımsız, saf fonksiyonlar.
 */

const pad = n => String(n).padStart(2, '0');
const toIso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const validDate = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/** Türkçe karakter ve büyük/küçük harf farkını yok sayan karşılaştırma için metni sadeleştirir. */
function fold(s) {
  return String(s ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
}

/** config'deki desen ("kisa|short") için eşleştirici; "Kısa Süreli", "KISA", "Short Stay" hepsi eşleşir. */
function matcher(pattern) {
  const re = new RegExp(fold(pattern));
  return text => re.test(fold(text));
}

/**
 * VFS API tarihi: "11/21/2026 00:00:00" biçiminde ay/gün/yıl. İlk sayı 12'den büyükse gün/ay kabul edilir.
 * ISO biçimi de desteklenir.
 */
function parseApiDate(s) {
  if (!s) return null;
  const str = String(s);
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]) ? toIso(+m[1], +m[2], +m[3]) : null;
  m = str.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (!m) return null;
  const a = +m[1], b = +m[2], y = +m[3];
  const [mo, d] = a > 12 ? [b, a] : [a, b];
  return validDate(y, mo, d) ? toIso(y, mo, d) : null;
}

/** Ekrandaki bilgi kutusu: "... en erken uygun randevu: 21-11-2026" biçiminde gün-ay-yıl. */
function parseDomDate(text) {
  const m = String(text ?? '').match(/(\d{1,2})[-./](\d{1,2})[-./](\d{4})/);
  if (!m) return null;
  let d = +m[1], mo = +m[2];
  const y = +m[3];
  if (mo > 12 && d <= 12) [d, mo] = [mo, d];
  return validDate(y, mo, d) ? toIso(y, mo, d) : null;
}

const NO_SLOT_RE = /no (appointment )?slots?|currently no|not available|uygun randevu (yok|bulunma)|randevu bulunmamaktad|musait randevu (yok|bulunma)|bos randevu (yok|bulunma)/;

/**
 * API yanıtı ve ekran metninden sonucu çıkarır.
 * status: 'available' (randevu var), 'none' (yok), 'unknown' (okunamadı)
 * earliest: en erken tarih (YYYY-MM-DD) ya da null
 */
function interpret({ api, domText }) {
  let status = 'unknown';
  let earliest = null;
  const text = String(domText ?? '').replace(/\s+/g, ' ').trim();
  let message = text.slice(0, 400);

  if (api && typeof api === 'object') {
    const list = Array.isArray(api.earliestSlotLists) ? api.earliestSlotLists : [];
    const dates = [api.earliestDate, ...list.map(x => x && x.date)].map(parseApiDate).filter(Boolean).sort();
    if (dates.length) { status = 'available'; earliest = dates[0]; }
    else if (api.error && (api.error.code === 1035 || /no slot/i.test(api.error.description || ''))) status = 'none';
    if (!message && api.error && (api.error.description || api.error.code)) message = `${api.error.code ?? ''} ${api.error.description ?? ''}`.trim();
  }

  // Ekrandaki gün-ay-yıl biçimi API'nin ay/gün biçiminden daha az belirsiz; ikisi birden varsa ekran esas alınır.
  const domDate = parseDomDate(text);
  if (domDate && status !== 'none') { status = 'available'; earliest = domDate; }
  else if (status === 'unknown' && NO_SLOT_RE.test(fold(text))) status = 'none';

  return { status, earliest, message };
}

/** Sonuç config'deki tarih aralığına uyuyor mu? (earliestDate / latestDate boşsa sınır yok) */
function isSuitable(r, cfg = {}) {
  if (r.status !== 'available') return false;
  if (!r.earliest) return !cfg.earliestDate && !cfg.latestDate;
  if (cfg.earliestDate && r.earliest < cfg.earliestDate) return false;
  if (cfg.latestDate && r.earliest > cfg.latestDate) return false;
  return true;
}

/**
 * Bildirim gerekip gerekmediği ve nedeni:
 *  'new'      randevu yokken uygun randevu açıldı (ya da önceki bildirim gönderilemedi)
 *  'earlier'  bildirilenden daha erken bir tarih çıktı
 *  'reminder' remindHours > 0 ise, randevu hâlâ açıkken hatırlatma
 * prev: bu merkez için bir önceki kesin sonuçtan kalan durum.
 */
function decideNotify(prev, cur, { remindHours = 0, now = Date.now() } = {}) {
  if (!cur.suitable) return null;
  if (!prev || !prev.suitable || !prev.notifiedAt) return 'new';
  if (cur.earliest && prev.notifiedEarliest && cur.earliest < prev.notifiedEarliest) return 'earlier';
  if (remindHours > 0 && now - Date.parse(prev.notifiedAt) >= remindHours * 3600e3) return 'reminder';
  return null;
}

/** Bir kontrol sonrası saklanacak durum. Bildirim gerekip gönderilemediyse bir sonraki kontrolde tekrar denenir. */
function nextTargetState(prev, cur, { reason, sent, at }) {
  const failed = !!reason && !sent;
  return {
    center: cur.center, category: cur.category, subcategory: cur.subcategory,
    status: cur.status, earliest: cur.earliest, checkedAt: at,
    suitable: failed ? !!(prev && prev.suitable && prev.notifiedAt) : cur.suitable,
    notifiedAt: sent ? at : (cur.suitable ? prev?.notifiedAt ?? null : null),
    notifiedEarliest: sent ? cur.earliest : (cur.suitable ? prev?.notifiedEarliest ?? null : null),
  };
}

const WEEKDAYS_TR = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
/** "2026-11-21" → "21.11.2026 Cumartesi" */
function fmtDateTr(iso) {
  if (!iso) return 'belirtilmemiş';
  const [y, m, d] = iso.split('-').map(Number);
  return `${pad(d)}.${pad(m)}.${y} ${WEEKDAYS_TR[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
}

module.exports = { fold, matcher, parseApiDate, parseDomDate, interpret, isSuitable, decideNotify, nextTargetState, fmtDateTr };
