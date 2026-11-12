'use strict';
/**
 * E-posta gönderimi ve mesaj metinleri.
 * Öncelik: SMTP (ör. Gmail + uygulama şifresi) → SendGrid. --dry-run'da gönderilmez,
 * state/outbox/ altına JSON olarak yazılır.
 */
const fs = require('fs');
const path = require('path');
const { fmtDateTr } = require('./slots');

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nowTr = (d = new Date()) => d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'short' });
const splitAddrs = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);

function mailMode(env = process.env) {
  if (env.SMTP_USER && env.SMTP_PASS) return 'smtp';
  if (env.SENDGRID_API_KEY && env.SENDGRID_FROM) return 'sendgrid';
  return null;
}

async function sendMail({ to, subject, text, html }, { dryRun = false, outboxDir, env = process.env } = {}) {
  const recipients = splitAddrs(to);
  if (!recipients.length) throw new Error('Alıcı adresi yok (NOTIFY_TO).');
  if (dryRun) {
    fs.mkdirSync(outboxDir, { recursive: true });
    const file = path.join(outboxDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}.json`);
    fs.writeFileSync(file, JSON.stringify({ to: recipients, subject, text, html }, null, 2) + '\n');
    return { via: 'dry-run', file };
  }
  const mode = mailMode(env);
  if (mode === 'smtp') {
    const nodemailer = require('nodemailer');
    const port = Number(env.SMTP_PORT || 465);
    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
      auth: { user: env.SMTP_USER, pass: String(env.SMTP_PASS).replace(/\s+/g, '') },
    });
    const info = await transport.sendMail({ from: { name: 'VFS Randevu Takibi', address: env.MAIL_FROM || env.SMTP_USER }, to: recipients, subject, text, html });
    return { via: 'smtp', id: info.messageId };
  }
  if (mode === 'sendgrid') {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: recipients.map(email => ({ email })) }],
        from: { email: env.SENDGRID_FROM, name: 'VFS Randevu Takibi' }, subject,
        content: [{ type: 'text/plain', value: text }, ...(html ? [{ type: 'text/html', value: html }] : [])],
        tracking_settings: { click_tracking: { enable: false, enable_text: false } },
      }),
    });
    if (res.status !== 202) throw new Error(`SendGrid ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { via: 'sendgrid' };
  }
  throw new Error('E-posta ayarı yok: .env dosyasında SMTP_USER ve SMTP_PASS (veya SENDGRID_API_KEY ve SENDGRID_FROM) tanımlayın.');
}

const REASON = {
  new: { subject: 'VFS Fransa vize randevusu açıldı', lead: 'VFS Global Fransa vize sisteminde uygun randevu göründü.' },
  earlier: { subject: 'Daha erken VFS Fransa vize randevusu', lead: 'Daha önce bildirilenden daha erken bir randevu tarihi göründü.' },
  reminder: { subject: 'Hatırlatma: VFS Fransa vize randevusu hâlâ açık', lead: 'Daha önce bildirilen randevu hâlâ açık görünüyor.' },
};

/** Uygun randevu e-postası. r: checkCenter sonucu; loginUrl: VFS giriş sayfası. */
function slotMessage({ r, reason = 'new', loginUrl, at = new Date() }) {
  const R = REASON[reason] || REASON.new;
  const date = fmtDateTr(r.earliest);
  const subject = `${R.subject} – ${r.centerLabel}${r.earliest ? `, en erken ${date}` : ''}`;
  const rows = [
    ['Başvuru merkezi', r.center],
    ['Kategori', [r.category, r.subcategory].filter(Boolean).join(' / ')],
    ['En erken tarih', date],
    ['VFS\'nin mesajı', r.message || '-'],
    ['Kontrol zamanı', `${nowTr(at)} (TSİ)`],
  ];
  const text = [
    'Merhaba,', '', R.lead, '',
    ...rows.map(([k, v]) => `${k}: ${v}`), '',
    'Randevu otomatik olarak ALINMADI. Boş randevular hızla doluyor; hemen giriş yapıp rezervasyonu tamamlayın:',
    loginUrl, '', '— VFS Randevu Takibi',
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1a1a1a;max-width:560px">
<p>Merhaba,</p><p><b>${esc(R.lead)}</b></p>
<table style="border-collapse:collapse;margin:12px 0">${rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#555;vertical-align:top">${esc(k)}</td><td style="padding:6px 0"><b>${esc(v)}</b></td></tr>`).join('')}</table>
<p>Randevu otomatik olarak <b>alınmadı</b>. Boş randevular hızla doluyor; hemen giriş yapıp rezervasyonu tamamlayın:</p>
<p><a href="${esc(loginUrl)}" style="display:inline-block;background:#1f4fa3;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">VFS'ye giriş yap</a></p>
<p style="color:#777;font-size:13px">— VFS Randevu Takibi</p></div>`;
  return { subject, text, html };
}

const HELP = {
  captcha: 'Giriş sayfasındaki "insan mısınız" doğrulaması tamamlanmadı. Agent\'ın açtığı tarayıcı penceresinde doğrulamayı tamamlayın; agent bir sonraki kontrolde devam eder.',
  cloudflare: 'Cloudflare doğrulama sayfası geçilemedi. Tarayıcı penceresinde doğrulamayı tamamlayın ya da bir süre bekleyin.',
  otp: 'VFS giriş için e-postaya tek kullanımlık kod (OTP) gönderdi. Kodu agent\'ın açtığı tarayıcı penceresine girin.',
  login: 'VFS girişi başarısız. .env dosyasındaki VFS_EMAIL / VFS_PASSWORD bilgilerini ve hesabın kilitli olmadığını kontrol edin.',
  blocked: 'VFS erişimi geçici olarak engelledi (çok sık kontrol). Agent bekleyip kendiliğinden tekrar deneyecek; config.json\'daki intervalMinutes değerini artırmayı düşünün.',
  option: 'Merkez veya vize kategorisi seçeneği bulunamadı. Aşağıdaki listeden doğru seçeneğe uyan bir deseni config.json\'a (centers / category / subcategory) yazın.',
  config: '.env dosyasındaki ayarları kontrol edin.',
  error: 'Beklenmeyen bir hata oluştu. Ayrıntı için ekran görüntüsüne bakın.',
};

/** Agent takıldığında operatöre giden uyarı. */
function problemMessage({ kind, error, failures, debugFile, at = new Date() }) {
  const help = HELP[kind] || HELP.error;
  const subject = `VFS randevu takibi: müdahale gerekli (${kind})`;
  const lines = [
    'Randevu takibi şu an randevuları kontrol edemiyor.', '',
    `Sorun: ${error}`, `Ardışık başarısız kontrol: ${failures}`, `Zaman: ${nowTr(at)} (TSİ)`, '',
    `Ne yapmalı: ${help}`,
    ...(debugFile ? ['', `Ekran görüntüsü (agent'ın çalıştığı bilgisayarda): ${debugFile}`] : []),
    '', '— VFS Randevu Takibi',
  ];
  const text = lines.join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;max-width:560px">${lines.map(l => (l ? `<p style="margin:4px 0">${esc(l)}</p>` : '<br>')).join('')}</div>`;
  return { subject, text, html };
}

function testMessage({ to }) {
  const text = [
    'Merhaba,', '',
    'Bu, VFS Fransa vize randevu takibinin deneme e-postasıdır. Bu e-postayı aldıysanız',
    'bildirimler çalışıyor: uygun randevu açıldığında bu adrese haber gelecek.', '',
    `Alıcı: ${to}`, `Zaman: ${nowTr()} (TSİ)`, '', '— VFS Randevu Takibi',
  ].join('\n');
  return { subject: 'VFS randevu takibi: deneme e-postası', text, html: `<pre style="font-family:Arial,Helvetica,sans-serif;font-size:15px">${esc(text)}</pre>` };
}

module.exports = { sendMail, mailMode, slotMessage, problemMessage, testMessage, nowTr };
