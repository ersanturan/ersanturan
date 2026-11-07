'use strict';
const { BlockedError } = require('./scrape');
const { sleep } = require('./browser');

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

/**
 * Basit işçi havuzu: N sayfa ile görev listesini işler.
 * Google captcha gösterirse captcha çözülmeye çalışılmaz; belirlenen soğuma
 * süresi kadar beklenir ve görev yeniden kuyruğa alınır. Soğuma hakkı bitince durur.
 */
async function runPool(context, tasks, { concurrency, cooldownSec, maxCooldowns }, worker) {
  const queue = tasks.slice();
  let blocked = null, cooldowns = 0, pausedUntil = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    const page = await context.newPage();
    try {
      while (queue.length && !blocked) {
        if (Date.now() < pausedUntil) { await sleep(1000); continue; }
        const task = queue.shift();
        try { await worker(page, task); }
        catch (e) {
          if (e instanceof BlockedError) {
            queue.unshift(task);
            if (cooldowns >= maxCooldowns) { blocked = e; break; }
            cooldowns++;
            pausedUntil = Date.now() + cooldownSec * 1000;
            log(`!! Google hız sınırı/captcha gösterdi; ${cooldownSec} sn bekleniyor (${cooldowns}/${maxCooldowns})`);
            continue;
          }
          log(`  ! ${task.label || ''}: ${e.message.split('\n')[0]}`); task.error = e.message;
        }
      }
    } finally { await page.close().catch(() => {}); }
  });
  await Promise.all(runners);
  if (blocked) throw blocked;
}

module.exports = { runPool, log };
