#!/usr/bin/env node
'use strict';
/**
 * VFS Global Fransa vize randevu takip agent'ı.
 *
 *   npm start                 sürekli çalışır: ~15 dk'da bir kontrol eder (config.json → intervalMinutes)
 *   npm run once              tek kontrol yapar ve çıkar (Görev Zamanlayıcı / cron için)
 *   npm run test-mail         NOTIFY_TO adresine deneme e-postası gönderir
 *
 * Seçenekler: --once, --test-mail, --dry-run (e-posta göndermez, state/outbox/'a yazar), --headless,
 *             --interval <dk>, --config <dosya>, --state-dir <klasör>
 *
 * Uygun randevu ilk kez göründüğünde (ya da daha erken bir tarih çıktığında) NOTIFY_TO adresine e-posta
 * gider; randevu açık kaldıkça aynı bildirim tekrarlanmaz. Agent takılırsa (captcha, OTP, engelleme,
 * yanlış kategori) ERROR_NOTIFY_TO / SMTP_USER adresine uyarı gider.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
require('./env').loadEnv(path.join(ROOT, '.env'));

const vfs = require('./vfs');
const { isSuitable, decideNotify, nextTargetState, fmtDateTr } = require('./slots');
const { sendMail, mailMode, slotMessage, problemMessage, testMessage } = require('./mail');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2), n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; }
  }
  return a;
}
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
const log = (...m) => console.log(`[${stamp()}]`, ...m);

const DEFAULTS = {
  country: 'tur', mission: 'fra', lang: 'tr', centers: ['Ankara'], category: 'kisa|short', subcategory: 'turizm|turist|touris',
  earliestDate: null, latestDate: null, intervalMinutes: 15, jitterMinutes: 5, blockedBackoffMinutes: 120, humanWaitMinutes: 5,
  remindHours: 0, errorAlertAfter: 3, errorAlertHours: 6, headless: false, browserChannel: 'chrome',
};

const args = parseArgs(process.argv.slice(2));
const cfg = { ...DEFAULTS, ...readJson(path.resolve(args.config || path.join(ROOT, 'config.json')), {}) };
if (args.headless) cfg.headless = true;
if (args.interval) cfg.intervalMinutes = Number(args.interval);
// VFS hesabın engellenmemesi için 5 dakikadan sık kontrol edilmez.
cfg.intervalMinutes = Math.max(5, Number(cfg.intervalMinutes) || 15);
const dryRun = !!args['dry-run'];

const STATE_DIR = path.resolve(args['state-dir'] || path.join(ROOT, 'state'));
const P = {
  state: path.join(STATE_DIR, 'state.json'),
  history: path.join(STATE_DIR, 'history.jsonl'),
  debug: path.join(STATE_DIR, 'debug'),
  outbox: path.join(STATE_DIR, 'outbox'),
  profile: path.join(STATE_DIR, 'profile'),
};
fs.mkdirSync(STATE_DIR, { recursive: true });

const NOTIFY_TO = process.env.NOTIFY_TO;
const ERROR_TO = process.env.ERROR_NOTIFY_TO || process.env.SMTP_USER || process.env.SENDGRID_FROM || NOTIFY_TO;
const mailOpts = { dryRun, outboxDir: P.outbox };
const capitalize = s => s.charAt(0).toLocaleUpperCase('tr-TR') + s.slice(1);
const centerLabel = pattern => capitalize(String(pattern).split('|')[0]);

function preflight() {
  const problems = [];
  if (!process.env.VFS_EMAIL || !process.env.VFS_PASSWORD) problems.push('VFS_EMAIL ve VFS_PASSWORD tanımlı değil.');
  if (!NOTIFY_TO) problems.push('NOTIFY_TO (bildirim adresi) tanımlı değil.');
  if (!dryRun && !mailMode()) problems.push('E-posta ayarı yok: SMTP_USER ve SMTP_PASS (Gmail uygulama şifresi) tanımlayın.');
  if (problems.length) {
    console.error(`Ayarlar eksik (${path.join(ROOT, '.env')}):\n- ${problems.join('\n- ')}\nÖrnek için .env.example dosyasına bakın.`);
    process.exit(2);
  }
}

/** Tüm merkezleri bir kez kontrol eder. Dönüş: { ok, backoffMin } */
async function runCheck(ctx, page) {
  const state = readJson(P.state, { targets: {}, failures: 0, lastProblemAlertAt: null });
  let ok = true, backoffMin = 0;

  for (const centerPattern of cfg.centers) {
    const key = [centerPattern, cfg.category, cfg.subcategory].join(' / ');
    const at = new Date().toISOString();
    try {
      const r = await vfs.checkCenter(page, ctx, centerPattern);
      r.centerLabel = centerLabel(centerPattern);
      r.suitable = isSuitable(r, cfg);
      const statusTr = { available: `RANDEVU VAR – en erken ${fmtDateTr(r.earliest)}`, none: 'uygun randevu yok', unknown: 'sonuç okunamadı' }[r.status];
      log(`${r.centerLabel}: ${statusTr}${r.status === 'available' && !r.suitable ? ' (tarih aralığı dışında)' : ''}${r.message ? ` — "${r.message}"` : ''}`);
      fs.appendFileSync(P.history, JSON.stringify({ at, center: r.center, status: r.status, earliest: r.earliest, suitable: r.suitable, message: r.message }) + '\n');

      if (r.status === 'unknown') {
        const shot = await vfs.saveDebug(page, P.debug, 'sonuc-okunamadi');
        throw Object.assign(new Error(`Randevu sonucu okunamadı (sayfa yapısı değişmiş olabilir).${shot ? ` Ekran görüntüsü: ${shot}` : ''}`), { kind: 'error', debugFile: shot });
      }

      const prev = state.targets[key];
      const reason = decideNotify(prev, r, { remindHours: Number(cfg.remindHours) || 0 });
      let sent = false;
      if (reason) {
        try {
          const msg = slotMessage({ r, reason, loginUrl: vfs.urls(cfg).login });
          const res = await sendMail({ to: NOTIFY_TO, ...msg }, mailOpts);
          sent = true;
          log(`E-posta gönderildi (${res.via}) → ${NOTIFY_TO}: ${msg.subject}`);
        } catch (e) {
          ok = false;
          log(`!! E-posta gönderilemedi, sonraki kontrolde tekrar denenecek: ${e.message}`);
        }
      }
      state.targets[key] = nextTargetState(prev, r, { reason, sent, at });
      state.failures = 0;
    } catch (e) {
      ok = false;
      const kind = e.kind || 'error';
      state.failures = (state.failures || 0) + 1;
      if (kind === 'blocked') backoffMin = Number(cfg.blockedBackoffMinutes) || 120;
      const debugFile = e.debugFile || await vfs.saveDebug(page, P.debug, kind);
      log(`!! ${centerLabel(centerPattern)} kontrol edilemedi (${kind}): ${e.message}`);
      if (e.options) writeJson(path.join(STATE_DIR, 'secenekler.json'), { at, error: e.message, options: e.options });
      fs.appendFileSync(P.history, JSON.stringify({ at, center: centerPattern, status: 'error', kind, error: String(e.message).slice(0, 300) }) + '\n');

      // Operatör uyarısı: yanlış kategori gibi ayar sorunlarında hemen, diğerlerinde birkaç ardışık hatadan sonra.
      const due = kind === 'option' || kind === 'config' || state.failures >= (Number(cfg.errorAlertAfter) || 3);
      const quiet = state.lastProblemAlertAt && Date.now() - Date.parse(state.lastProblemAlertAt) < (Number(cfg.errorAlertHours) || 6) * 3600e3;
      if (due && !quiet && ERROR_TO) {
        try {
          await sendMail({ to: ERROR_TO, ...problemMessage({ kind, error: e.message, failures: state.failures, debugFile }) }, mailOpts);
          state.lastProblemAlertAt = new Date().toISOString();
          log(`Uyarı e-postası gönderildi → ${ERROR_TO}`);
        } catch (me) { log(`!! Uyarı e-postası da gönderilemedi: ${me.message}`); }
      }
    } finally {
      writeJson(P.state, state);
    }
  }
  return { ok, backoffMin };
}

async function main() {
  if (args['test-mail']) {
    if (!NOTIFY_TO) { console.error('NOTIFY_TO tanımlı değil (.env).'); process.exit(2); }
    const res = await sendMail({ to: NOTIFY_TO, ...testMessage({ to: NOTIFY_TO }) }, mailOpts);
    log(`Deneme e-postası gönderildi (${res.via}) → ${NOTIFY_TO}${res.file ? ` (${res.file})` : ''}`);
    return;
  }
  preflight();
  const ctx = {
    cfg, log,
    creds: { email: process.env.VFS_EMAIL, password: process.env.VFS_PASSWORD },
    humanWaitMs: Math.max(1, Number(cfg.humanWaitMinutes) || 5) * 60000,
  };
  log(`VFS Fransa randevu takibi başladı: ${cfg.centers.map(centerLabel).join(', ')} · kategori /${cfg.category}/ · alt kategori /${cfg.subcategory}/` +
    `${cfg.latestDate ? ` · en geç ${cfg.latestDate}` : ''} · bildirim: ${NOTIFY_TO}${dryRun ? ' (deneme modu, e-posta gönderilmez)' : ''}`);

  let context = null, page = null, last = { ok: false };
  const closeBrowser = async () => { const c = context; context = null; page = null; if (c) await c.close().catch(() => {}); };
  const getPage = async () => {
    if (!context) {
      context = await vfs.openBrowser(cfg, P.profile);
      context.on('close', () => { context = null; page = null; });
    }
    if (!page || page.isClosed()) page = context.pages()[0] || await context.newPage();
    return page;
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { log('Durduruluyor...'); await closeBrowser(); process.exit(0); });

  for (;;) {
    try { last = await runCheck(ctx, await getPage()); }
    catch (e) { last = { ok: false }; log(`!! Beklenmeyen hata: ${e.stack || e}`); await closeBrowser(); }
    if (args.once) break;
    const waitMin = last.backoffMin || cfg.intervalMinutes + Math.random() * (Number(cfg.jitterMinutes) || 0);
    log(`Sonraki kontrol ${Math.round(waitMin)} dk sonra.`);
    await sleep(waitMin * 60000);
  }
  await closeBrowser();
  process.exitCode = last.ok ? 0 : 1;
}

main().catch(e => { console.error('HATA:', e); process.exit(1); });
