// utils/ltcMonitor.js
// Monitors Litecoin address for incoming transactions via BlockCypher API
// Uses persistent state so restarts don't lose confirmation progress

const axios = require('axios');
const storeState = require('./storeState');

const POLL_INTERVAL_NORMAL = 60_000;
const POLL_INTERVAL_RATELIMIT = 5 * 60_000;
const LTC_SATOSHI = 100_000_000;
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

// Startup time — ignore txs older than this
let monitorStartTime = null;

async function checkNewTransactions(walletAddress, onTransaction) {
  try {
    const token = process.env.BLOCKCYPHER_TOKEN;
    const query = token ? `?token=${token}&limit=50` : '?limit=50';
    const url = `https://api.blockcypher.com/v1/ltc/main/addrs/${walletAddress}/full${query}`;
    const res = await axios.get(url, { timeout: 15000 });

    if (currentPollInterval !== POLL_INTERVAL_NORMAL) {
      currentPollInterval = POLL_INTERVAL_NORMAL;
      console.log('[LTCMonitor] Rate limit cleared — back to 60s polling');
    }

    const txs = res.data.txs || [];
    for (const tx of txs) {
      // Skip txs from before bot started (on first poll only)
      const txTime = new Date(tx.received).getTime();
      if (txTime < monitorStartTime && storeState.isTxProcessed(tx.hash)) {
        continue;
      }

      // How much was sent TO our wallet
      let receivedSatoshis = 0;
      for (const output of tx.outputs || []) {
        if (output.addresses?.includes(walletAddress)) {
          receivedSatoshis += output.value;
        }
      }
      if (receivedSatoshis <= 0) continue;

      const ltcAmount = receivedSatoshis / LTC_SATOSHI;
      const confs = tx.confirmations || 0;

      // Already fully processed
      if (storeState.isTxProcessed(tx.hash)) continue;

      if (confs === 0) {
        // Unconfirmed — notify once
        if (!storeState.isTxSeen(tx.hash, '_unconf')) {
          storeState.markTxSeen(tx.hash, '_unconf');
          console.log(`[LTCMonitor] 🔍 Unconfirmed tx: ${ltcAmount} LTC — waiting for confirmation`);
          await onTransaction({ txHash: tx.hash, ltcAmount, confirmations: 0, pending: true });
        }
      } else if (confs >= 1 && !storeState.isTxSeen(tx.hash, '_1conf')) {
        // 1+ confirmations — trigger hold (fires once)
        storeState.markTxSeen(tx.hash, '_1conf');
        console.log(`[LTCMonitor] ✅ Confirmed tx: ${ltcAmount} LTC (${confs} confirmations)`);
        await onTransaction({ txHash: tx.hash, ltcAmount, confirmations: confs, pending: false });
      }

      if (confs >= 6 && !storeState.isTxSeen(tx.hash, '_6conf')) {
        // 6 confirmations — trigger tip (fires once)
        storeState.markTxSeen(tx.hash, '_6conf');
        console.log(`[LTCMonitor] ✅ 6 confirmations: ${ltcAmount} LTC — processing tip`);
        await onTransaction({ txHash: tx.hash, ltcAmount, confirmations: confs, pending: false });
      }
    }

  } catch (e) {
    if (e.response?.status === 429) {
      currentPollInterval = POLL_INTERVAL_RATELIMIT;
      console.warn('[LTCMonitor] Rate limited (429) — slowing to 5min polling');
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = setInterval(() => checkNewTransactions(_savedWallet, _savedCallback), currentPollInterval);
      }
    } else {
      console.error('[LTCMonitor] Poll error:', e.message);
    }
  }
}

function matchOrderByLtcAmount(ltcAmount) {
  const state = storeState.get();
  const TOLERANCE = 0.00005;
  const pending = Object.entries(state.pendingOrders);

  console.log(`[LTCMonitor] Matching ${ltcAmount} LTC against ${pending.length} pending orders:`);
  for (const [orderId, order] of pending) {
    const diff = Math.abs(order.ltcAmount - ltcAmount);
    console.log(`  ${orderId}: expected ${order.ltcAmount} LTC, diff=${diff.toFixed(8)}, user=${order.gamblitUsername}`);
    if (diff <= TOLERANCE) {
      console.log(`  ✅ Matched to ${orderId} (${order.gamblitUsername})`);
      return { orderId, order };
    }
  }
  console.log(`  ❌ No match found for ${ltcAmount} LTC`);
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

  // Clean old seen hashes on startup
  storeState.cleanSeenHashes();

  console.log(`[LTCMonitor] Starting monitor for ${walletAddress}`);
  console.log(`[LTCMonitor] Persistent tx state loaded — will resume processing any pending orders`);
  if (!process.env.BLOCKCYPHER_TOKEN) {
    console.warn('[LTCMonitor] ⚠️  No BLOCKCYPHER_TOKEN — lower rate limits');
  }

  // Initial poll
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
