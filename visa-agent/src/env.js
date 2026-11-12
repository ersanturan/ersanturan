'use strict';
const fs = require('fs');

/**
 * Basit .env yükleyici (bağımlılıksız). "ANAHTAR=değer" satırlarını okur.
 * Zaten tanımlı ortam değişkenlerinin üzerine yazmaz. Değerdeki "#" yorum sayılmaz
 * (şifrelerde geçebilir); tırnak içindeki değerlerin tırnakları atılır.
 */
function loadEnv(file) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

module.exports = { loadEnv };
