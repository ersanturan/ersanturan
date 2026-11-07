'use strict';
/**
 * ntfy.sh üzerinden bildirim + e-posta gönderir (hesap/anahtar gerekmez).
 * ntfy, "email" parametresi verilen mesajları o adrese e-posta olarak iletir.
 * Konu (topic) adı tahmin edilemez tutulmalı: konuyu bilen herkes mesajları okuyabilir.
 * İstek curl ile atılır; böylece sistem proxy'si ve CA ayarları otomatik kullanılır.
 */
const { execFileSync } = require('child_process');

function sendNtfy({ topic, title, message, email, click, tags = 'airplane', token = process.env.NTFY_TOKEN }) {
  if (!topic) throw new Error('ntfy konusu (topic) gerekli');
  const q = new URLSearchParams({ title, tags });
  if (email) q.set('email', email);
  if (click) q.set('click', click);
  const url = `https://ntfy.sh/${encodeURIComponent(topic)}?${q.toString()}`;
  // E-posta iletimi ntfy.sh'ta hesap gerektirir: erişim anahtarı (tk_...) NTFY_TOKEN ile verilir.
  const auth = token ? ['-H', `Authorization: Bearer ${token}`] : [];
  const out = execFileSync('curl', ['-sS', '--fail-with-body', '--max-time', '30', ...auth, '-X', 'POST', '--data-binary', '@-', url],
    { input: message, encoding: 'utf8' });
  return JSON.parse(out);
}

module.exports = { sendNtfy };
