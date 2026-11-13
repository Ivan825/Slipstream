/**
 * Small OpenF1 client (https://openf1.org).
 *  - Historical data (2023 onwards) is free and needs no key.
 *  - Real-time data needs an OpenF1 subscription: set OPENF1_TOKEN, or
 *    OPENF1_USERNAME + OPENF1_PASSWORD (exchanged for a token, refreshed hourly).
 * Requests are spaced out and retried on 429/5xx to respect rate limits.
 */
const BASE = process.env.OPENF1_URL || 'https://api.openf1.org/v1';
const TOKEN_URL = process.env.OPENF1_TOKEN_URL || 'https://api.openf1.org/token';
const GAP_MS = Number(process.env.OPENF1_GAP_MS || 400);
// one request at a time, GAP_MS apart, shared by every channel
let chain = Promise.resolve();
const slot = () => { const p = chain.then(() => sleep(GAP_MS)); chain = p.catch(() => {}); return p; };
let token = process.env.OPENF1_TOKEN || null;
let tokenExpires = token ? Infinity : 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const liveAvailable = () => !!(process.env.OPENF1_TOKEN || (process.env.OPENF1_USERNAME && process.env.OPENF1_PASSWORD));

async function authHeader() {
  if (process.env.OPENF1_TOKEN) return { authorization: `Bearer ${process.env.OPENF1_TOKEN}` };
  if (!process.env.OPENF1_USERNAME || !process.env.OPENF1_PASSWORD) return {};
  if (!token || Date.now() > tokenExpires - 60_000) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: process.env.OPENF1_USERNAME, password: process.env.OPENF1_PASSWORD })
    });
    if (!res.ok) throw new Error(`OpenF1 token request failed: HTTP ${res.status}`);
    const j = await res.json();
    token = j.access_token;
    tokenExpires = Date.now() + Number(j.expires_in || 3600) * 1000;
  }
  return { authorization: `Bearer ${token}` };
}

export async function openf1(endpoint, params = {}, { tries = 5 } = {}) {
  // OpenF1 filters put the operator in the key (date>=…), so build the query by hand
  const qs = Object.entries(params)
    .map(([k, v]) => {
      const m = /^(.*?)(>=|<=|>|<)$/.exec(k);
      return m ? `${encodeURIComponent(m[1])}${m[2]}${encodeURIComponent(v)}` : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  const url = `${BASE}/${endpoint}${qs ? '?' + qs : ''}`;
  for (let attempt = 1; attempt <= tries; attempt++) {
    await slot();
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'slipstream-replay', ...(await authHeader()) } });
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    }
    if (res.status === 404) return [];
    if (res.status === 401 || res.status === 403) throw new Error(`OpenF1 ${endpoint}: HTTP ${res.status} (real-time data needs an OpenF1 subscription key)`);
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * attempt * attempt);
      continue;
    }
    throw new Error(`OpenF1 ${endpoint}: HTTP ${res.status}`);
  }
  throw new Error(`OpenF1 ${endpoint}: gave up after ${tries} tries`);
}

/** sessions for a year (cached for an hour) */
const catalogCache = new Map();
export async function catalog(year) {
  const hit = catalogCache.get(year);
  if (hit && Date.now() - hit.at < 3600_000) return hit.data;
  const rows = await openf1('sessions', { year });
  const data = rows
    .filter((s) => s.date_start)
    .map((s) => ({ key: s.session_key, meeting: s.meeting_key, name: s.session_name, type: s.session_type, circuit: s.circuit_short_name, country: s.country_name, location: s.location, start: s.date_start, end: s.date_end }))
    .sort((a, b) => a.start.localeCompare(b.start));
  catalogCache.set(year, { at: Date.now(), data });
  return data;
}
