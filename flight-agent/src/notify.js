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

/**
 * SendGrid v3 mail/send ile düz metin e-posta gönderir.
 * Anahtar SENDGRID_API_KEY ortam değişkeninden okunur. Tanımlı değilse istek başlıksız gider:
 * Claude ortamında anahtar "Network secrets" (Bearer, api.sendgrid.com) olarak eklendiyse
 * proxy Authorization başlığını kendisi ekler. "from" SendGrid'de doğrulanmış
 * bir gönderici olmalıdır (SENDGRID_FROM veya --email-from).
 */
function sendEmailSendGrid({ to, from, subject, text, html, apiKey = process.env.SENDGRID_API_KEY, fromName = 'Uçuş Fiyat Takibi' }) {
  if (!from) throw new Error('Gönderici adresi (SENDGRID_FROM / --email-from) gerekli');
  const recipients = String(to).split(',').map(s => s.trim()).filter(Boolean).map(email => ({ email }));
  const body = JSON.stringify({
    personalizations: [{ to: recipients }],
    from: { email: from, name: fromName },
    subject,
    content: [{ type: 'text/plain', value: text }, ...(html ? [{ type: 'text/html', value: html }] : [])],
    tracking_settings: { click_tracking: { enable: false, enable_text: false } },
  });
  const out = execFileSync('curl', ['-sS', '--max-time', '30', '-o', '-', '-w', '\n%{http_code}',
    ...(apiKey ? ['-H', `Authorization: Bearer ${apiKey}`] : []), '-H', 'Content-Type: application/json',
    '-X', 'POST', '--data-binary', '@-', 'https://api.sendgrid.com/v3/mail/send'], { input: body, encoding: 'utf8' });
  const lines = out.trimEnd().split('\n');
  const code = Number(lines.pop());
  if (code !== 202) throw new Error(`SendGrid ${code}${!apiKey && code === 401 ? ' (anahtar yok: ortamda SENDGRID_API_KEY ya da api.sendgrid.com için Bearer ağ gizli anahtarı tanımlı değil)' : ''}: ${lines.join(' ').slice(0, 300)}`);
  return { ok: true, status: code };
}

module.exports = { sendNtfy, sendEmailSendGrid };
