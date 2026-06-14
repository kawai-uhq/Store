// utils/ltcMonitor.js
// Chain-read helpers for the UNIQUE-AMOUNT model (single static address, match by amount).
//  - getLtcUsdRate(): live LTC price (CoinGecko + Kraken fallback), 15-min cache
//  - getAddressIncomingTxs(addr): incoming payments to your wallet (value + confirmations)
//  - lookupTx(hash, addr): manual/admin tx check

const axios = require('axios');

const LTC_SATOSHI = 100_000_000;
const BC_BASE = 'https://api.blockcypher.com/v1/ltc/main';

let ltcUsdRate = null;
let rateLastFetched = 0;
const RATE_TTL = 15 * 60 * 1000;

async function fetchFromCoinGecko() {
  const headers = {};
  if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  const res = await axios.get(
    'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd,eur',
    { timeout: 10000, headers }
  );
  return { usd: res.data.litecoin.usd, eur: res.data.litecoin.eur };
}

async function fetchFromKraken() {
  const res = await axios.get('https://api.kraken.com/0/public/Ticker?pair=LTCUSD,LTCEUR', { timeout: 10000 });
  const result = res.data?.result || {};
  let usd, eur;
  for (const [key, val] of Object.entries(result)) {
    const last = parseFloat(val?.c?.[0]);
    if (!last) continue;
    if (key.includes('USD')) usd = last;
    if (key.includes('EUR')) eur = last;
  }
  if (!usd || !eur) throw new Error('Kraken returned no LTC price');
  return { usd, eur };
}

async function getLtcUsdRate() {
  const now = Date.now();
  if (ltcUsdRate && now - rateLastFetched < RATE_TTL) return ltcUsdRate;
  try {
    ltcUsdRate = await fetchFromCoinGecko();
    rateLastFetched = now;
    return ltcUsdRate;
  } catch (e) {
    console.warn(`[LTCMonitor] CoinGecko failed (${e.response?.status || e.message}) — trying Kraken`);
    try {
      ltcUsdRate = await fetchFromKraken();
      rateLastFetched = now;
      return ltcUsdRate;
    } catch (e2) {
      console.error('[LTCMonitor] Kraken also failed:', e2.message);
      return ltcUsdRate || { usd: 80, eur: 74 };
    }
  }
}

function bcQuery() {
  const token = process.env.BLOCKCYPHER_TOKEN;
  return token ? `?token=${token}` : '';
}

// Incoming payments to `address`, grouped per tx: [{ txHash, valueSat, confirmations }]
async function getAddressIncomingTxs(address) {
  try {
    const url = `${BC_BASE}/addrs/${address}${bcQuery()}`;
    const res = await axios.get(url, { timeout: 15000 });
    const refs = [...(res.data.txrefs || []), ...(res.data.unconfirmed_txrefs || [])];
    const byTx = {};
    for (const r of refs) {
      if (r.tx_input_n !== -1) continue; // only received outputs
      const h = r.tx_hash;
      if (!byTx[h]) byTx[h] = { txHash: h, valueSat: 0, confirmations: r.confirmations || 0, timeMs: r.confirmed ? Date.parse(r.confirmed) : Date.now() };
      byTx[h].valueSat += r.value || 0;
      byTx[h].confirmations = r.confirmations || 0;
      if (r.confirmed) byTx[h].timeMs = Date.parse(r.confirmed);
    }
    return Object.values(byTx);
  } catch (e) {
    if (e.response?.status === 429) console.warn('[LTCMonitor] Rate limited (429) on address lookup');
    else console.error('[LTCMonitor] getAddressIncomingTxs error:', e.message);
    return [];
  }
}

async function lookupTx(txHash, walletAddress) {
  try {
    const res = await axios.get(`${BC_BASE}/txs/${txHash}${bcQuery()}`, { timeout: 15000 });
    const tx = res.data;
    let sat = 0;
    for (const o of tx.outputs || []) if (o.addresses?.includes(walletAddress)) sat += o.value;
    const timeMs = tx.confirmed ? Date.parse(tx.confirmed) : (tx.received ? Date.parse(tx.received) : Date.now());
    return { found: true, ltcAmount: sat / LTC_SATOSHI, confirmations: tx.confirmations || 0, timeMs };
  } catch (e) {
    if (e.response?.status === 404) return { found: false, error: 'Transaction not found' };
    return { found: false, error: e.message };
  }
}

module.exports = { getLtcUsdRate, getAddressIncomingTxs, lookupTx, LTC_SATOSHI };
