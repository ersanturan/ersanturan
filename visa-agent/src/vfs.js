'use strict';
/**
 * VFS Global (visa.vfsglobal.com) randevu müsaitliği kontrolü — gerçek tarayıcı ile.
 *
 * Akış: panel (gerekirse giriş) → "Yeni Rezervasyon Başlat" → başvuru merkezi / randevu kategorisi /
 * alt kategori seçimi → VFS'nin gösterdiği "en erken uygun randevu" bilgisi okunur. Randevu ALINMAZ,
 * hiçbir form gönderilmez.
 *
 * Sonuç iki kaynaktan okunur: sayfanın kendi yaptığı CheckIsSlotAvailable API çağrısının yanıtı
 * (dilden bağımsız) ve ekrandaki bilgi kutusu.
 *
 * Captcha, Cloudflare doğrulaması ve tek kullanımlık kod (OTP) otomatik çözülmeye ÇALIŞILMAZ:
 * görünür tarayıcıda kullanıcının tamamlaması beklenir, olmazsa NeedsHumanError fırlatılır.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { interpret, matcher } = require('./slots');

class NeedsHumanError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
class BlockedError extends Error { constructor(msg) { super(msg); this.kind = 'blocked'; } }
class OptionNotFoundError extends Error { constructor(msg, options) { super(msg); this.kind = 'option'; this.options = options; } }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BLOCK_RE = /access denied|erişim engellendi|temporarily blocked|geçici olarak engellen|too many requests|çok fazla istek|you have been blocked|error code:? ?(403|429)\d*/i;
const CF_TITLE_RE = /just a moment|bir dakika|attention required|verify you are human/i;
const RESULT_RE = /earliest|en erken|ilk uygun|no (appointment )?slots?|uygun randevu|müsait randevu|currently no/i;

const CENTER_NAMES = ['centerCode', 'vacCode', 'center'];
const CATEGORY_NAMES = ['visaCategoryCode', 'selectedVisaCategory', 'categoryCode'];
const SUBCATEGORY_NAMES = ['selectedSubvisaCategory', 'subVisaCategoryCode', 'visaSubCategoryCode', 'subCategoryCode'];
const OPTION_SEL = '.cdk-overlay-container mat-option, .cdk-overlay-container [role="option"]';
const OTP_SEL = 'input[formcontrolname*="otp" i], input[name*="otp" i], input[id*="otp" i]';

function urls(cfg) {
  const base = (process.env.VFS_BASE_URL || 'https://visa.vfsglobal.com').replace(/\/+$/, '');
  const root = `${base}/${cfg.country}/${cfg.lang}/${cfg.mission}`;
  return { root, login: `${root}/login`, dashboard: `${root}/dashboard` };
}

/**
 * Kalıcı profilli tarayıcı: çerezler ve oturum kontroller arasında korunur, böylece her seferinde
 * giriş/captcha gerekmez. Varsayılan olarak bilgisayardaki Google Chrome kullanılır; yoksa Playwright Chromium.
 */
async function openBrowser(cfg, profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const opts = {
    headless: !!cfg.headless,
    viewport: { width: 1280, height: 900 },
    locale: cfg.lang === 'tr' ? 'tr-TR' : 'en-US',
    timezoneId: 'Europe/Istanbul',
  };
  if (process.env.PW_EXECUTABLE_PATH) return chromium.launchPersistentContext(profileDir, { ...opts, executablePath: process.env.PW_EXECUTABLE_PATH });
  if (cfg.browserChannel) {
    try { return await chromium.launchPersistentContext(profileDir, { ...opts, channel: cfg.browserChannel }); }
    catch (e) { console.warn(`"${cfg.browserChannel}" açılamadı (${String(e.message).split('\n')[0]}); Playwright Chromium kullanılıyor.`); }
  }
  return chromium.launchPersistentContext(profileDir, opts);
}

async function isVisible(loc) { try { return await loc.first().isVisible(); } catch { return false; } }
async function bodyText(page) { try { return await page.locator('body').innerText({ timeout: 3000 }); } catch { return ''; } }

/** cond() doğru bir değer döndürene kadar bekler; zaman aşımında null döner. */
async function waitUntil(cond, timeoutMs, stepMs = 1000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond().catch(() => null);
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(stepMs);
  }
}

async function checkBlocked(page) {
  const title = await page.title().catch(() => '');
  const text = (await bodyText(page)).slice(0, 4000);
  if (BLOCK_RE.test(title) || BLOCK_RE.test(text)) {
    throw new BlockedError(`VFS erişimi engelledi: ${`${title} ${text}`.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }
}

async function acceptCookies(page) {
  const btn = page.locator('#onetrust-accept-btn-handler, button:has-text("Tümünü Kabul Et"), button:has-text("Accept All Cookies")').first();
  if (await isVisible(btn)) await btn.click({ timeout: 5000 }).catch(() => {});
}

/** Cloudflare "Just a moment..." ara sayfası: kendiliğinden geçmesi, görünür modda kullanıcının tamamlaması beklenir. */
async function waitCloudflare(page, ctx) {
  if (!CF_TITLE_RE.test(await page.title().catch(() => ''))) return;
  ctx.log('Cloudflare doğrulaması bekleniyor...');
  const ok = await waitUntil(async () => !CF_TITLE_RE.test(await page.title()), ctx.cfg.headless ? 30000 : ctx.humanWaitMs);
  if (!ok) throw new NeedsHumanError('cloudflare', 'Cloudflare "insan mısınız" doğrulaması geçilemedi.');
}

const emailInput = page => page.locator('input[formcontrolname="username"], input#email, input[type="email"]').first();
const passwordInput = page => page.locator('input[formcontrolname="password"], input#password, input[type="password"]').first();
const submitButton = page => page.locator('button').filter({ hasText: /oturum aç|giriş yap|sign in|log ?in/i }).first();
const startButton = page => page.locator('button, a').filter({ hasText: /start new booking|yeni rezervasyon|yeni randevu/i }).first();

async function onDashboard(page) { return /\/dashboard/i.test(page.url()) && isVisible(startButton(page)); }

async function login(page, ctx) {
  const { cfg, creds, log } = ctx;
  if (!creds.email || !creds.password) throw new NeedsHumanError('config', 'VFS_EMAIL / VFS_PASSWORD tanımlı değil (.env dosyası).');
  if (!/\/login/i.test(page.url())) await page.goto(urls(cfg).login, { waitUntil: 'domcontentloaded' });
  await waitCloudflare(page, ctx);
  await checkBlocked(page);
  const email = emailInput(page);
  await email.waitFor({ state: 'visible', timeout: 45000 });
  await acceptCookies(page);
  await email.fill(creds.email);
  await passwordInput(page).fill(creds.password);

  // Cloudflare Turnstile tamamlanana kadar giriş düğmesi pasif kalır; çoğu zaman kendiliğinden geçer.
  const btn = submitButton(page);
  if (!await waitUntil(() => btn.isEnabled(), 20000)) {
    if (cfg.headless) throw new NeedsHumanError('captcha', 'Giriş sayfasında captcha doğrulaması geçilemedi (görünmez modda kullanıcı tamamlayamaz).');
    log(`Giriş captcha'sı bekleniyor: tarayıcı penceresinde "insan mısınız" doğrulamasını tamamlayın (en fazla ${Math.round(ctx.humanWaitMs / 60000)} dk).`);
    if (!await waitUntil(() => btn.isEnabled(), ctx.humanWaitMs)) throw new NeedsHumanError('captcha', 'Giriş captcha\'sı tamamlanmadı.');
  }
  await btn.click();

  const outcome = await waitUntil(async () => {
    if (await onDashboard(page)) return 'ok';
    if (await isVisible(page.locator(OTP_SEL))) return 'otp';
    const t = await bodyText(page);
    if (BLOCK_RE.test(t)) return 'blocked';
    const err = (await page.locator('mat-error, .alert-danger, .error-message, .invalid-feedback').allInnerTexts().catch(() => [])).join(' ').trim();
    return err ? `error:${err}` : null;
  }, 60000);

  if (outcome === 'otp') {
    if (cfg.headless) throw new NeedsHumanError('otp', 'VFS giriş için tek kullanımlık kod (OTP) istiyor.');
    log(`VFS tek kullanımlık kod (OTP) istiyor: e-postanıza gelen kodu tarayıcı penceresine girin (en fazla ${Math.round(ctx.humanWaitMs / 60000)} dk).`);
    if (!await waitUntil(() => onDashboard(page), ctx.humanWaitMs)) throw new NeedsHumanError('otp', 'Tek kullanımlık kod (OTP) girilmedi.');
  } else if (outcome === 'blocked') {
    await checkBlocked(page);
    throw new BlockedError('VFS girişte erişimi engelledi.');
  } else if (!outcome) {
    throw new NeedsHumanError('login', 'Giriş 60 sn içinde tamamlanmadı.');
  } else if (outcome.startsWith('error:')) {
    throw new NeedsHumanError('login', `Giriş başarısız: ${outcome.slice(6).replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  log('VFS girişi yapıldı.');
}

/** Paneli açar; oturum düşmüşse giriş yapar. */
async function gotoDashboard(page, ctx) {
  await page.goto(urls(ctx.cfg).dashboard, { waitUntil: 'domcontentloaded' });
  await waitCloudflare(page, ctx);
  const where = await waitUntil(async () => {
    if (await onDashboard(page)) return 'dashboard';
    if (/\/login/i.test(page.url()) || await isVisible(emailInput(page))) return 'login';
    return null;
  }, 45000);
  await checkBlocked(page);
  if (where === 'login') await login(page, ctx);
  else if (!where) throw new Error(`VFS paneli yüklenemedi (adres: ${page.url()}).`);
}

async function pickSelect(page, names, index) {
  const byName = page.locator(names.map(n => `mat-select[formcontrolname="${n}"]`).join(', ')).first();
  return (await byName.count()) ? byName : page.locator('mat-select').nth(index);
}

/** Angular Material açılır listesinden desene uyan ilk seçeneği seçer; bulunamazsa görünen seçenekleri raporlar. */
async function selectOption(page, select, pattern, label, log) {
  await select.waitFor({ state: 'visible', timeout: 30000 });
  await waitUntil(async () => (await select.getAttribute('aria-disabled')) !== 'true', 20000, 500);
  await select.click();
  const opts = page.locator(OPTION_SEL);
  await waitUntil(async () => (await opts.count()) > 0, 20000, 500);
  await sleep(500);
  const texts = (await opts.allInnerTexts().catch(() => [])).map(t => t.replace(/\s+/g, ' ').trim());
  const test = matcher(pattern);
  const idx = texts.findIndex(t => t && test(t));
  if (idx < 0) {
    await page.keyboard.press('Escape').catch(() => {});
    const shown = texts.filter(Boolean);
    throw new OptionNotFoundError(`${label} için /${pattern}/ desenine uyan seçenek yok. Görünen seçenekler: ${shown.join(' | ') || '(liste boş)'}`, shown);
  }
  await opts.nth(idx).click();
  await waitUntil(async () => (await opts.count()) === 0, 5000, 200);
  log(`${label}: ${texts[idx]}`);
  return texts[idx];
}

/**
 * Bir başvuru merkezi için randevu durumunu okur.
 * Dönüş: { center, category, subcategory, status: 'available'|'none'|'unknown', earliest, message, domText, api }
 */
async function checkCenter(page, ctx, centerPattern) {
  const { cfg, log } = ctx;
  await gotoDashboard(page, ctx);

  const responses = [];
  const onResponse = async res => {
    if (!/CheckIsSlotAvailable/i.test(res.url())) return;
    const entry = { at: Date.now(), json: null };
    responses.push(entry);
    try { entry.json = await res.json(); } catch { /* JSON değil */ }
  };
  page.on('response', onResponse);
  try {
    await startButton(page).click();
    await page.locator('mat-select').first().waitFor({ state: 'visible', timeout: 45000 });
    await checkBlocked(page);

    const center = await selectOption(page, await pickSelect(page, CENTER_NAMES, 0), centerPattern, 'Başvuru merkezi', log);
    const category = await selectOption(page, await pickSelect(page, CATEGORY_NAMES, 1), cfg.category, 'Randevu kategorisi', log);
    const before = Date.now();
    const subcategory = await selectOption(page, await pickSelect(page, SUBCATEGORY_NAMES, 2), cfg.subcategory, 'Alt kategori', log);

    const resultBox = page.locator('.alert, [role="alert"], .border-info').filter({ hasText: RESULT_RE });
    const latestApi = () => [...responses].reverse().find(r => r.at >= before && r.json)?.json;
    await waitUntil(async () => latestApi() || isVisible(resultBox), 30000, 500);
    await sleep(1500); // ekran metninin güncellenmesi için
    const domText = (await resultBox.allInnerTexts().catch(() => [])).join(' ').replace(/\s+/g, ' ').trim();
    await checkBlocked(page);
    const api = latestApi() ?? [...responses].reverse().find(r => r.json)?.json ?? null;
    return { center, category, subcategory, ...interpret({ api, domText }), domText, api };
  } finally {
    page.off('response', onResponse);
  }
}

/** Hata ayıklama için ekran görüntüsü + HTML kaydeder (yalnızca yerel; kişisel veri içerebilir). */
async function saveDebug(page, dir, label) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`${base}.html`, await page.content().catch(() => ''));
    const files = fs.readdirSync(dir).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 40))) fs.unlinkSync(path.join(dir, f));
    return `${base}.png`;
  } catch { return null; }
}

module.exports = { openBrowser, checkCenter, saveDebug, urls, NeedsHumanError, BlockedError, OptionNotFoundError };
