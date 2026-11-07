'use strict';
const { chromium } = require('playwright');

/**
 * Tarayıcıyı açar ve Google Flights için gerekli bağlamı kurar.
 * - Bazı kurumsal proxy'lerin arkasında Chromium, gstatic.com'dan gelen JS
 *   parçalarını ERR_BLOCKED_BY_ORB ile düşürüyor; aynı isteği Playwright'ın
 *   ağ katmanı üzerinden tekrar çekip teslim etmek bunu çözüyor.
 */
async function launchBrowser({ headless = true, executablePath } = {}) {
  const browser = await chromium.launch({ headless, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1400, height: 1200 },
    timezoneId: 'Europe/Istanbul',
  });
  await context.route(/gstatic\.com\/.*\/js\//, async route => {
    try { const r = await route.fetch(); await route.fulfill({ response: r }); }
    catch { await route.continue().catch(() => {}); }
  });
  return { browser, context };
}

/** AB konumlarında çıkan çerez onay ekranını geçer (varsa). */
async function dismissConsent(page) {
  try {
    if (/consent\.google\./.test(page.url())) {
      const btn = page.locator('button:has-text("Reject all"), button:has-text("Accept all")').first();
      if (await btn.count()) { await btn.click(); await page.waitForLoadState('domcontentloaded'); }
    }
  } catch { /* yoksay */ }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

module.exports = { launchBrowser, dismissConsent, sleep, jitter };
