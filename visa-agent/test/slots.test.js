'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matcher, parseApiDate, parseDomDate, interpret, isSuitable, decideNotify, nextTargetState, fmtDateTr } = require('../src/slots');

test('matcher Türkçe karakter ve büyük/küçük harf farkını yok sayar', () => {
  const m = matcher('kisa|short');
  assert.ok(m('KISA SÜRELİ VİZE'));
  assert.ok(m('Kısa Süreli Vize (90 güne kadar)'));
  assert.ok(m('Short Stay'));
  assert.ok(!m('Uzun Süreli Vize'));
  assert.ok(matcher('turizm|touris')('TURİZM'));
  assert.ok(matcher('ankara')('Fransa Vize Başvuru Merkezi - ANKARA'));
  assert.ok(!matcher('ankara')('Fransa Vize Başvuru Merkezi - İstanbul'));
});

test('tarih ayrıştırma', () => {
  assert.equal(parseApiDate('11/21/2026 00:00:00'), '2026-11-21');
  assert.equal(parseApiDate('21/11/2026 00:00:00'), '2026-11-21');
  assert.equal(parseApiDate('2026-11-21T00:00:00'), '2026-11-21');
  assert.equal(parseApiDate(null), null);
  assert.equal(parseApiDate('02/30/2026'), null);
  assert.equal(parseDomDate('Bireysel başvuru için en erken uygun randevu: 05-12-2026'), '2026-12-05');
  assert.equal(parseDomDate('Earliest available slot for Individual is : 21-11-2026'), '2026-11-21');
  assert.equal(parseDomDate('randevu yok'), null);
});

test('interpret: API ve ekran metni', () => {
  const none = interpret({ api: { earliestDate: null, earliestSlotLists: [], error: { code: 1035, description: 'No slots available', type: 'Info' } }, domText: '' });
  assert.equal(none.status, 'none');
  assert.equal(none.message, '1035 No slots available');

  const avail = interpret({ api: { earliestDate: '12/05/2026 00:00:00', earliestSlotLists: [{ applicant: 'Individual', date: '12/05/2026 00:00:00' }], error: null }, domText: 'Earliest available slot for Individual is : 05-12-2026' });
  assert.deepEqual([avail.status, avail.earliest], ['available', '2026-12-05']);

  // Yalnızca ekran metni (API yakalanamadıysa)
  assert.equal(interpret({ api: null, domText: 'Üzgünüz, şu anda uygun randevu bulunmamaktadır.' }).status, 'none');
  assert.equal(interpret({ api: null, domText: 'We are sorry but no appointment slots are currently available.' }).status, 'none');
  assert.deepEqual(Object.values(interpret({ api: null, domText: 'En erken uygun randevu: 03-01-2027' })).slice(0, 2), ['available', '2027-01-03']);
  assert.equal(interpret({ api: null, domText: '' }).status, 'unknown');
  // Ekranda eski bir tarih kalmış olsa bile API "yok" diyorsa yok sayılır
  assert.equal(interpret({ api: { error: { code: 1035, description: 'No slots available' } }, domText: 'En erken uygun randevu: 03-01-2027' }).status, 'none');
});

test('isSuitable tarih aralığı', () => {
  const r = { status: 'available', earliest: '2027-01-10' };
  assert.ok(isSuitable(r, {}));
  assert.ok(isSuitable(r, { latestDate: '2027-01-15' }));
  assert.ok(!isSuitable(r, { latestDate: '2027-01-05' }));
  assert.ok(!isSuitable(r, { earliestDate: '2027-01-11' }));
  assert.ok(!isSuitable({ status: 'none', earliest: null }, {}));
  assert.ok(isSuitable({ status: 'available', earliest: null }, {}));
  assert.ok(!isSuitable({ status: 'available', earliest: null }, { latestDate: '2027-01-05' }));
});

test('decideNotify / nextTargetState: tekrar etmeyen bildirim', () => {
  const at = '2026-11-12T08:00:00.000Z';
  const cur = (earliest, suitable = true) => ({ center: 'Ankara', status: suitable ? 'available' : 'none', earliest, suitable });

  assert.equal(decideNotify(undefined, cur(null, false)), null);
  assert.equal(decideNotify(undefined, cur('2026-12-05')), 'new');

  let s = nextTargetState(undefined, cur('2026-12-05'), { reason: 'new', sent: true, at });
  assert.equal(decideNotify(s, cur('2026-12-05')), null, 'aynı randevu için tekrar bildirim yok');
  assert.equal(decideNotify(s, cur('2026-12-08')), null, 'daha geç tarih bildirilmez');
  assert.equal(decideNotify(s, cur('2026-12-01')), 'earlier');
  assert.equal(decideNotify(s, cur('2026-12-05'), { remindHours: 6, now: Date.parse(at) + 7 * 3600e3 }), 'reminder');

  // Randevu kapanıp yeniden açılırsa tekrar bildirilir
  s = nextTargetState(s, cur(null, false), { reason: null, sent: false, at });
  assert.equal(s.suitable, false);
  assert.equal(decideNotify(s, cur('2026-12-20')), 'new');

  // Gönderilemeyen bildirim bir sonraki kontrolde tekrar denenir
  const failed = nextTargetState(undefined, cur('2026-12-05'), { reason: 'new', sent: false, at });
  assert.equal(decideNotify(failed, cur('2026-12-05')), 'new');
  const notified = nextTargetState(undefined, cur('2026-12-05'), { reason: 'new', sent: true, at });
  const earlierFailed = nextTargetState(notified, cur('2026-12-01'), { reason: 'earlier', sent: false, at });
  assert.equal(decideNotify(earlierFailed, cur('2026-12-01')), 'earlier');
});

test('fmtDateTr', () => {
  assert.equal(fmtDateTr('2026-11-21'), '21.11.2026 Cumartesi');
  assert.equal(fmtDateTr(null), 'belirtilmemiş');
});
