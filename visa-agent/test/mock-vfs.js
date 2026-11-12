'use strict';
/**
 * Test için VFS benzeri yerel sunucu. Gerçek sitenin yapısını taklit eder (OneTrust çerez düğmesi,
 * formcontrolname'li giriş alanları, Turnstile'ı taklit eden geç etkinleşen düğme, Angular Material
 * mat-select / cdk-overlay seçimleri, CheckIsSlotAvailable API'si ve bilgi kutusu).
 * Agent'ın akışını test eder; gerçek VFS'nin birebir aynısı olduğu iddia edilmez.
 */
const http = require('http');

const CENTERS = ['Fransa Vize Başvuru Merkezi - İstanbul', 'Fransa Vize Başvuru Merkezi - ANKARA', 'Fransa Vize Başvuru Merkezi - İzmir'];
const CATEGORIES = ['Uzun Süreli Vize', 'Kısa Süreli Vize (90 güne kadar)'];
const SUBCATEGORIES = ['İş', 'Turizm', 'Aile / Arkadaş Ziyareti'];

const html = (title, body, script = '') => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title>
<style>mat-select{display:block;border:1px solid #999;padding:8px;margin:8px;width:400px;cursor:pointer}mat-option{display:block;padding:6px}</style></head>
<body>${body}<div class="cdk-overlay-container"></div><script>${script}</script></body></html>`;

const LOGIN = html('VFS Global', `
<div id="onetrust-banner-sdk"><button id="onetrust-accept-btn-handler">Tümünü Kabul Et</button></div>
<form id="f"><input id="email" formcontrolname="username" type="text"><input id="password" formcontrolname="password" type="password">
<mat-error id="err"></mat-error><button type="submit" id="b" disabled>Oturum Aç</button></form>`, `
document.getElementById('onetrust-accept-btn-handler').onclick = () => document.getElementById('onetrust-banner-sdk').remove();
setTimeout(() => { document.getElementById('b').disabled = false; }, 1500);
document.getElementById('f').onsubmit = async e => {
  e.preventDefault();
  const r = await fetch('/user/login', { method: 'POST', body: JSON.stringify({ u: email.value, p: password.value }) });
  if (r.ok) { sessionStorage.setItem('tok', '1'); setTimeout(() => { location.href = 'dashboard'; }, 300); }
  else document.getElementById('err').textContent = 'Geçersiz e-posta veya şifre';
};`);

const DASHBOARD = html('VFS Global', '<div id="app">Yükleniyor...</div>', `
if (!sessionStorage.getItem('tok')) location.href = 'login';
else setTimeout(() => { document.getElementById('app').innerHTML = '<h1>Randevu Detayları</h1><button id="start">Yeni Rezervasyon Başlat</button>';
  document.getElementById('start').onclick = () => { location.href = 'application-detail'; }; }, 500);`);

const DETAIL = html('VFS Global', `
<mat-select formcontrolname="centerCode" aria-disabled="false"><span>Başvuru merkezinizi seçin</span></mat-select>
<mat-select formcontrolname="visaCategoryCode" aria-disabled="true"><span>Randevu kategorinizi seçin</span></mat-select>
<mat-select formcontrolname="selectedSubvisaCategory" aria-disabled="true"><span>Alt kategorinizi seçin</span></mat-select>
<div id="result"></div>`, `
if (!sessionStorage.getItem('tok')) location.href = 'login';
const lists = [${JSON.stringify(CENTERS)}, ${JSON.stringify(CATEGORIES)}, ${JSON.stringify(SUBCATEGORIES)}];
const selects = [...document.querySelectorAll('mat-select')];
const overlay = document.querySelector('.cdk-overlay-container');
selects.forEach((s, i) => s.addEventListener('click', () => {
  if (s.getAttribute('aria-disabled') === 'true') return;
  overlay.innerHTML = '<div class="cdk-overlay-pane" role="listbox"></div>';
  // seçenekler gecikmeli yüklenir (gerçek sitede API'den gelir)
  setTimeout(() => {
    for (const t of lists[i]) {
      const o = document.createElement('mat-option'); o.setAttribute('role', 'option'); o.innerHTML = '<span> ' + t + ' </span>';
      o.onclick = () => { s.querySelector('span').textContent = t; overlay.innerHTML = '';
        if (selects[i + 1]) selects[i + 1].setAttribute('aria-disabled', 'false');
        if (i === 2) check(); };
      overlay.firstChild.appendChild(o);
    }
  }, 300);
}));
async function check() {
  const r = await fetch('/appointment/CheckIsSlotAvailable', { method: 'POST' });
  const j = await r.json();
  setTimeout(() => {
    document.getElementById('result').innerHTML = j.earliestDate
      ? '<div class="alert alert-info">Bireysel başvuru için en erken uygun randevu: ' + j._dom + '</div>'
      : '<div class="alert alert-info">Üzgünüz, şu anda uygun randevu bulunmamaktadır. Lütfen daha sonra tekrar deneyin.</div>';
  }, 400);
}`);

/** mode: { slot: null | 'YYYY-MM-DD', blocked: bool } */
function startMockVfs({ email = 'test@ornek.com', password = 'gizli' } = {}) {
  const state = { slot: null, blocked: false, logins: 0, checks: 0 };
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'text/html; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    if (state.blocked) return send(403, '<html><head><title>Access Denied</title></head><body>Access denied. Error code 403201</body></html>');
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/user/login') {
      let b = ''; req.on('data', c => { b += c; });
      return req.on('end', () => { const { u: e, p } = JSON.parse(b || '{}'); state.logins++; send(e === email && p === password ? 200 : 401, '{}', 'application/json'); });
    }
    if (req.method === 'POST' && u.pathname === '/appointment/CheckIsSlotAvailable') {
      state.checks++;
      if (!state.slot) return send(200, JSON.stringify({ earliestDate: null, earliestSlotLists: [], error: { code: 1035, description: 'No slots available', type: 'Info' } }), 'application/json');
      const [y, m, d] = state.slot.split('-');
      const api = `${m}/${d}/${y} 00:00:00`;
      return send(200, JSON.stringify({ earliestDate: api, earliestSlotLists: [{ applicant: 'Individual', date: api }], error: null, _dom: `${d}-${m}-${y}` }), 'application/json');
    }
    if (/\/login$/.test(u.pathname)) return send(200, LOGIN);
    if (/\/dashboard$/.test(u.pathname)) return send(200, DASHBOARD);
    if (/\/application-detail$/.test(u.pathname)) return send(200, DETAIL);
    send(404, 'not found');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise(r => server.close(r)) });
  }));
}

module.exports = { startMockVfs };
