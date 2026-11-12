'use strict';
/**
 * Uçtan uca test: agent'ı yerel sahte VFS sunucusuna karşı gerçek tarayıcıyla, deneme modunda
 * (e-posta gönderilmez, state/outbox'a yazılır) tek kontrol olarak çalıştırır.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { startMockVfs } = require('./mock-vfs');

const AGENT = path.join(__dirname, '..', 'src', 'agent.js');
const daysFromNow = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const trDate = iso => iso.split('-').reverse().join('.');

function runAgent(env, dir, extra = []) {
  return new Promise(resolve => {
    execFile(process.execPath, [AGENT, '--once', '--dry-run', '--headless', '--state-dir', dir, '--config', path.join(dir, 'config.json'), ...extra], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.PW_EXECUTABLE_PATH ? { PW_EXECUTABLE_PATH: process.env.PW_EXECUTABLE_PATH } : {}), ...env },
      timeout: 120000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
}
const outbox = dir => (fs.existsSync(path.join(dir, 'outbox')) ? fs.readdirSync(path.join(dir, 'outbox')).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, 'outbox', f), 'utf8'))) : []);

test('sahte VFS ile tam akış: yok → açıldı → tekrar yok → daha erken → kapandı → yeniden açıldı', { timeout: 600000 }, async () => {
  const mock = await startMockVfs();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-agent-'));
  const env = { VFS_BASE_URL: mock.url, VFS_EMAIL: 'test@ornek.com', VFS_PASSWORD: 'gizli', NOTIFY_TO: 'alici@ornek.com', ERROR_NOTIFY_TO: 'operator@ornek.com' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ centers: ['ankara'], category: 'kisa|short', subcategory: 'turizm|touris', headless: true, browserChannel: null }));
  try {
    let r = await runAgent(env, dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Başvuru merkezi: Fransa Vize Başvuru Merkezi - ANKARA/);
    assert.match(r.out, /Alt kategori: Turizm/);
    assert.match(r.out, /uygun randevu yok/);
    assert.equal(outbox(dir).length, 0);

    const d1 = daysFromNow(23);
    mock.state.slot = d1;
    r = await runAgent(env, dir);
    assert.equal(r.code, 0, r.out);
    let mails = outbox(dir);
    assert.equal(mails.length, 1, r.out);
    assert.deepEqual(mails[0].to, ['alici@ornek.com']);
    assert.match(mails[0].subject, /VFS Fransa vize randevusu açıldı – Ankara, en erken/);
    assert.ok(mails[0].subject.includes(trDate(d1)), mails[0].subject);
    assert.ok(mails[0].text.includes(`${mock.url}/tur/tr/fra/login`));

    r = await runAgent(env, dir);
    assert.equal(outbox(dir).length, 1, 'aynı randevu için ikinci e-posta gitmemeli');

    const d2 = daysFromNow(16);
    mock.state.slot = d2;
    r = await runAgent(env, dir);
    mails = outbox(dir);
    assert.equal(mails.length, 2, r.out);
    assert.match(mails[1].subject, /^Daha erken VFS Fransa vize randevusu/);
    assert.ok(mails[1].subject.includes(trDate(d2)));

    mock.state.slot = null;
    r = await runAgent(env, dir);
    assert.match(r.out, /uygun randevu yok/);
    mock.state.slot = daysFromNow(30);
    r = await runAgent(env, dir);
    mails = outbox(dir);
    assert.equal(mails.length, 3, r.out);
    assert.match(mails[2].subject, /açıldı/);

    const history = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(history.map(h => h.status), ['none', 'available', 'available', 'available', 'none', 'available']);
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('yanlış kategori: seçenekler listelenir ve operatöre uyarı gider', { timeout: 120000 }, async () => {
  const mock = await startMockVfs();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-agent-'));
  const env = { VFS_BASE_URL: mock.url, VFS_EMAIL: 'test@ornek.com', VFS_PASSWORD: 'gizli', NOTIFY_TO: 'alici@ornek.com', ERROR_NOTIFY_TO: 'operator@ornek.com' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ centers: ['ankara'], category: 'kisa', subcategory: 'ogrenci', headless: true, browserChannel: null }));
  try {
    const r = await runAgent(env, dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Görünen seçenekler: İş \| Turizm \| Aile \/ Arkadaş Ziyareti/);
    const mails = outbox(dir);
    assert.equal(mails.length, 1);
    assert.deepEqual(mails[0].to, ['operator@ornek.com']);
    assert.match(mails[0].subject, /müdahale gerekli \(option\)/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'secenekler.json'), 'utf8')).options, ['İş', 'Turizm', 'Aile / Arkadaş Ziyareti']);
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('yanlış şifre ve engelleme algılanır', { timeout: 180000 }, async () => {
  const mock = await startMockVfs();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-agent-'));
  const env = { VFS_BASE_URL: mock.url, VFS_EMAIL: 'test@ornek.com', VFS_PASSWORD: 'yanlis', NOTIFY_TO: 'alici@ornek.com' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ centers: ['ankara'], headless: true, browserChannel: null }));
  try {
    let r = await runAgent(env, dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /kontrol edilemedi \(login\): Giriş başarısız: Geçersiz e-posta veya şifre/);
    mock.state.blocked = true;
    r = await runAgent({ ...env, VFS_PASSWORD: 'gizli' }, dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /kontrol edilemedi \(blocked\)/);
    assert.equal(outbox(dir).length, 0, 'ilk hatalarda uyarı e-postası gitmez (errorAlertAfter=3)');
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
