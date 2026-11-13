/**
 * Small OpenF1 client (https://openf1.org): historical data is free and needs
 * no key. Requests are spaced out and retried on 429/5xx to stay within the
 * public rate limit.
 */
const BASE = process.env.OPENF1_URL || 'https://api.openf1.org/v1';
const GAP_MS = 400;
let last = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openf1(endpoint, params = {}, { tries = 5 } = {}) {
  // OpenF1 filters use operators in the key (date>…), so build the query by hand
  const qs = Object.entries(params)
    .map(([k, v]) => {
      const m = /^(.*?)(>=|<=|>|<)$/.exec(k);
      return m ? `${encodeURIComponent(m[1])}${m[2]}${encodeURIComponent(v)}` : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  const url = `${BASE}/${endpoint}${qs ? '?' + qs : ''}`;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'slipstream-replay' } });
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    }
    if (res.status === 404) return [];
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * attempt * attempt);
      continue;
    }
    throw new Error(`OpenF1 ${endpoint}: HTTP ${res.status}`);
  }
  throw new Error(`OpenF1 ${endpoint}: gave up after ${tries} tries`);
}
