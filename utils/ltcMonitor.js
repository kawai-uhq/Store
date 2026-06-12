// utils/ltcMonitor.js
// Monitors Litecoin address for incoming transactions via BlockCypher API

const axios = require('axios');
const storeState = require('./storeState');

const LTC_SATOSHI = 100_000_000;
const CONFIRMATIONS_NEEDED = 1;

// Poll every 60s normally; backs off to 5min on 429
const POLL_INTERVAL_NORMAL = 60_000;
const POLL_INTERVAL_RATELIMIT = 5 * 60_000;
let currentPollInterval = POLL_INTERVAL_NORMAL;

// LTC/USD rate cache
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

async function bglToLtc(bglAmount, currency = 'eur') {
  const state = storeState.get();
  const price = currency === 'usd' ? state.bglPriceUsd : state.bglPriceEur;
  const fiatTotal = bglAmount * price;
  const rates = await getLtcUsdRate();
  const ltcRate = currency === 'usd' ? rates.usd : rates.eur;
  return (fiatTotal / ltcRate).toFixed(6);
}

async function fiatToBglAndLtc(fiatAmount, currency = 'eur') {
  const state = storeState.get();
  const price = currency === 'usd' ? state.bglPriceUsd : state.bglPriceEur;
  const bglAmount = Math.floor(fiatAmount / price);
  const rates = await getLtcUsdRate();
  const ltcRate = currency === 'usd' ? rates.usd : rates.eur;
  const ltcAmount = (fiatAmount / ltcRate).toFixed(6);
  return { bglAmount, ltcAmount };
}

// Hashes seen this session
const seenTxHashes = new Set();
// Timestamp of bot startup — ignore older txs
let monitorStartTime = null;

async function checkNewTransactions(walletAddress, onTransaction) {
  try {
    const token = process.env.BLOCKCYPHER_TOKEN;
    const query = token ? `?token=${token}&limit=10` : '?limit=10';
    const url = `https://api.blockcypher.com/v1/ltc/main/addrs/${walletAddress}/full${query}`;
    const res = await axios.get(url, { timeout: 15000 });

    // Reset poll interval to normal on success
    if (currentPollInterval !== POLL_INTERVAL_NORMAL) {
      currentPollInterval = POLL_INTERVAL_NORMAL;
      console.log('[LTCMonitor] Rate limit cleared — resuming normal polling (60s)');
    }

    const txs = res.data.txs || [];
    for (const tx of txs) {
      if (seenTxHashes.has(tx.hash)) continue;

      // Skip anything older than bot startup
      const txTime = new Date(tx.received).getTime();
      if (txTime < monitorStartTime) {
        seenTxHashes.add(tx.hash);
        seenTxHashes.add(tx.hash + '_hold');
        continue;
      }

      // Sum satoshis sent TO our wallet
      let receivedSatoshis = 0;
      for (const output of tx.outputs || []) {
        if (output.addresses?.includes(walletAddress)) {
          receivedSatoshis += output.value;
        }
      }
      if (receivedSatoshis <= 0) continue;

      const ltcAmount = receivedSatoshis / LTC_SATOSHI;

      if (tx.confirmations >= CONFIRMATIONS_NEEDED) {
        seenTxHashes.add(tx.hash);
        seenTxHashes.add(tx.hash + '_hold');
        if (!storeState.isTxProcessed(tx.hash)) {
          await onTransaction({ txHash: tx.hash, ltcAmount, confirmations: tx.confirmations, pending: false });
        }
      } else if (!seenTxHashes.has(tx.hash + '_hold')) {
        seenTxHashes.add(tx.hash + '_hold');
        await onTransaction({ txHash: tx.hash, ltcAmount, confirmations: 0, pending: true });
      }
    }

  } catch (e) {
    if (e.response?.status === 429) {
      currentPollInterval = POLL_INTERVAL_RATELIMIT;
      console.warn('[LTCMonitor] Rate limited by BlockCypher (429) — slowing to 5min polling');
      console.warn('  -> Add BLOCKCYPHER_TOKEN to .env to get a higher rate limit (free at blockcypher.com)');
      // Reschedule timer at slower rate
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = setInterval(() => checkNewTransactions(walletAddress, _savedCallback), currentPollInterval);
      }
    } else {
      console.error('[LTCMonitor] Poll error:', e.message);
    }
  }
}

function matchOrderByLtcAmount(ltcAmount) {
  const state = storeState.get();
  const TOLERANCE = 0.00005;
  for (const [orderId, order] of Object.entries(state.pendingOrders)) {
    if (Math.abs(order.ltcAmount - ltcAmount) <= TOLERANCE) {
      return { orderId, order };
    }
  }
  return null;
}

let pollTimer = null;
let _savedCallback = null;
let _savedWallet = null;

function startMonitor(walletAddress, onTransaction) {
  if (pollTimer) clearInterval(pollTimer);

  monitorStartTime = Date.now();
  _savedCallback = onTransaction;
  _savedWallet = walletAddress;

  console.log(`[LTCMonitor] Starting monitor for ${walletAddress}`);
  console.log(`[LTCMonitor] Ignoring all txs before ${new Date(monitorStartTime).toISOString()}`);
  if (!process.env.BLOCKCYPHER_TOKEN) {
    console.warn('[LTCMonitor] ⚠️  No BLOCKCYPHER_TOKEN set — using unauthenticated API (lower rate limits)');
    console.warn('  -> Get a free token at https://accounts.blockcypher.com/');
  }

  // First poll (marks old txs as seen silently)
  checkNewTransactions(walletAddress, onTransaction);

  pollTimer = setInterval(() => {
    checkNewTransactions(walletAddress, onTransaction);
  }, POLL_INTERVAL_NORMAL);
}

function stopMonitor() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = {
  startMonitor,
  stopMonitor,
  getLtcUsdRate,
  bglToLtc,
  fiatToBglAndLtc,
  matchOrderByLtcAmount,
};

