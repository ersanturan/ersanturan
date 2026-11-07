'use strict';
/**
 * Google Flights arama durumunu taşıyan "tfs" URL parametresini üretir.
 * Parametre, base64url ile kodlanmış küçük bir protobuf mesajıdır. Harici
 * kütüphane kullanmamak için gerekli protobuf alanları elle kodlanır.
 *
 * Şema (gözlemlenen):
 *   Info {
 *     repeated FlightData data = 3;
 *     repeated Passenger passengers = 8;   // 1 yetişkin, 2 çocuk, 3 koltuklu bebek, 4 kucakta bebek
 *     Seat seat = 9;                       // 1 ekonomi, 2 premium eko, 3 business, 4 first
 *     Trip trip = 19;                      // 1 gidiş-dönüş, 2 tek yön, 3 çoklu şehir
 *   }
 *   FlightData { string date = 2; int32 max_stops = 5; repeated Airport from = 13; repeated Airport to = 14; }
 *   Airport { string code = 2; }
 */

const PASSENGER = { adult: 1, child: 2, infantInSeat: 3, infantOnLap: 4 };
const SEAT = { economy: 1, premiumEconomy: 2, business: 3, first: 4 };
const TRIP = { roundTrip: 1, oneWay: 2, multiCity: 3 };

function varint(n) {
  const bytes = [];
  while (n > 127) { bytes.push((n & 127) | 128); n >>>= 7; }
  bytes.push(n);
  return Buffer.from(bytes);
}
function field(num, wireType, payload) { return Buffer.concat([varint((num << 3) | wireType), payload]); }
function strField(num, s) { const p = Buffer.from(s, 'utf8'); return field(num, 2, Buffer.concat([varint(p.length), p])); }
function intField(num, v) { return field(num, 0, varint(v)); }
function msgField(num, buf) { return field(num, 2, Buffer.concat([varint(buf.length), buf])); }

function encodeLeg({ date, from, to, maxStops }) {
  const parts = [strField(2, date)];
  if (maxStops !== undefined && maxStops !== null) parts.push(intField(5, maxStops));
  for (const code of from) parts.push(msgField(13, strField(2, code)));
  for (const code of to) parts.push(msgField(14, strField(2, code)));
  return Buffer.concat(parts);
}

/**
 * @param {object} o
 * @param {Array<{date:string, from:string[], to:string[], maxStops?:number}>} o.legs
 * @param {{adults?:number, children?:number, infantsInSeat?:number, infantsOnLap?:number}} o.passengers
 * @param {'economy'|'premiumEconomy'|'business'|'first'} [o.seat]
 * @param {'roundTrip'|'oneWay'|'multiCity'} [o.trip]
 */
function buildTfs({ legs, passengers = {}, seat = 'economy', trip = 'roundTrip' }) {
  const parts = legs.map(l => msgField(3, encodeLeg(l)));
  const pax = [];
  for (let i = 0; i < (passengers.adults || 0); i++) pax.push(PASSENGER.adult);
  for (let i = 0; i < (passengers.children || 0); i++) pax.push(PASSENGER.child);
  for (let i = 0; i < (passengers.infantsInSeat || 0); i++) pax.push(PASSENGER.infantInSeat);
  for (let i = 0; i < (passengers.infantsOnLap || 0); i++) pax.push(PASSENGER.infantOnLap);
  if (pax.length === 0) pax.push(PASSENGER.adult);
  for (const p of pax) parts.push(intField(8, p));
  parts.push(intField(9, SEAT[seat] || SEAT.economy));
  parts.push(intField(19, TRIP[trip] || TRIP.roundTrip));
  return Buffer.concat(parts).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildSearchUrl(opts, { currency = 'EUR', hl = 'en', gl = 'US' } = {}) {
  return `https://www.google.com/travel/flights?tfs=${buildTfs(opts)}&hl=${hl}&gl=${gl}&curr=${currency}`;
}

module.exports = { buildTfs, buildSearchUrl, PASSENGER, SEAT, TRIP };
