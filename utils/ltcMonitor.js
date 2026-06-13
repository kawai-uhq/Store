// utils/ltcMonitor.js
// Chain-read helpers for the forwarding-address model.
//  - getLtcUsdRate(): live LTC price (CoinGecko), 5-min cache
//  - getAddressDeposit(addr): how much LTC a forwarding address has received + confirmations
//  - lookupTx(hash, addr): kept for manual checks / admin tooling
// The per-order polling loop now lives in orderProcessor.startOrderPoller().

const axios = require('axios');

const LTC_SATOSHI = 100_000_000;
const BC_BASE = 'https://api.blockcypher.com/v1/ltc/main';

let ltcUsdRate = null;
let rateLastFetched = 0;

async function getLtcUsdRate() {
  const now = Date.now();
  if (ltcUsdRate && now - rateLastFetched < 5 * 60 * 1000) return ltcUsdRate;
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd,eur',
      { timeout: 10000 }
    );
    ltcUsdRate = { usd: res.data.litecoin.usd, eur: res.data.litecoin.eur };
    rateLastFetched = now;
    return ltcUsdRate;
  } catch (e) {
    console.error('[LTCMonitor] Failed to fetch LTC rate:', e.message);
    return ltcUsdRate || { usd: 80, eur: 74 };
  }
}

function bcQuery() {
  const token = process.env.BLOCKCYPHER_TOKEN;
  return token ? `?token=${token}` : '';
}

// Total LTC received by a forwarding address + confirmations of the payment.
// Returns null if nothing has arrived yet.
// Uses min-confirmations across all incoming parts so we only deliver once the
// whole payment is settled (handles a buyer sending in two chunks).
async function getAddressDeposit(address) {
  try {
    const url = `${BC_BASE}/addrs/${address}${bcQuery()}`;
    const res = await axios.get(url, { timeout: 15000 });

    const refs = [
      ...(res.data.txrefs || []),
      ...(res.data.unconfirmed_txrefs || []),
    ];
    // Incoming outputs to this address have tx_input_n === -1
    const incoming = refs.filter((r) => r.tx_input_n === -1);
    if (incoming.length === 0) return null;

    const totalSat = incoming.reduce((s, r) => s + (r.value || 0), 0);
    const minConfs = incoming.reduce(
      (m, r) => Math.min(m, r.confirmations || 0),
      Infinity
    );
    // Newest incoming tx hash (most recent first in BlockCypher ordering)
    const newest = incoming[0];

    return {
      txHash: newest.tx_hash,
      ltcAmount: totalSat / LTC_SATOSHI,
      confirmations: minConfs === Infinity ? 0 : minConfs,
      parts: incoming.length,
    };
  } catch (e) {
    if (e.response?.status === 429) {
      console.warn('[LTCMonitor] Rate limited (429) on address lookup');
    } else if (e.response?.status !== 404) {
      console.error('[LTCMonitor] getAddressDeposit error:', e.message);
    }
    return null;
  }
}

async function lookupTx(txHash, walletAddress) {
  try {
    const url = `${BC_BASE}/txs/${txHash}${bcQuery()}`;
    const res = await axios.get(url, { timeout: 15000 });
    const tx = res.data;
    let receivedSatoshis = 0;
    for (const output of tx.outputs || []) {
      if (output.addresses?.includes(walletAddress)) receivedSatoshis += output.value;
    }
    return {
      found: true,
      ltcAmount: receivedSatoshis / LTC_SATOSHI,
      confirmations: tx.confirmations || 0,
      receivedAt: tx.received,
    };
  } catch (e) {
    if (e.response?.status === 404) return { found: false, error: 'Transaction not found' };
    return { found: false, error: e.message };
  }
}

module.exports = { getLtcUsdRate, getAddressDeposit, lookupTx };
