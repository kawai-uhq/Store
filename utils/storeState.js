// utils/storeState.js
// In-memory + JSON-persisted store state

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/store.json');

const DEFAULT_STATE = {
  bglPriceEur: parseFloat(process.env.BGL_PRICE_EUR) || 1.25,
  bglPriceUsd: parseFloat(process.env.BGL_PRICE_USD) || 1.35,
  stockBgls: parseInt(process.env.STOCK_BGLS) || 1000,
  onHoldBgls: 0,
  orders: {},         // txHash -> order object
  pendingOrders: {},  // orderId -> order awaiting payment
  seenTxHashes: {},   // txHash -> confirmations seen (persisted across restarts)
  dailyTipUsed: 0,
  dailyTipResetAt: null,
};

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error('[StoreState] Failed to load state:', e.message);
  }
  return { ...DEFAULT_STATE };
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[StoreState] Failed to save state:', e.message);
  }
}

let state = load();

module.exports = {
  get() { return state; },

  setPrice(eur, usd) {
    state.bglPriceEur = parseFloat(eur);
    state.bglPriceUsd = parseFloat(usd);
    save(state);
  },

  setStock(amount) {
    state.stockBgls = Math.floor(parseFloat(amount) * 100) / 100;
    save(state);
  },

  getAvailableStock() {
    return Math.max(0, Math.floor((state.stockBgls - state.onHoldBgls) * 100) / 100);
  },

  addHold(bgls) {
    state.onHoldBgls += bgls;
    save(state);
  },

  removeHold(bgls) {
    state.onHoldBgls = Math.max(0, state.onHoldBgls - bgls);
    save(state);
  },

  deductStock(bgls) {
    state.stockBgls = Math.max(0, state.stockBgls - bgls);
    state.onHoldBgls = Math.max(0, state.onHoldBgls - bgls);
    save(state);
  },

  addOrder(orderId, order) {
    state.pendingOrders[orderId] = { ...order, createdAt: Date.now() };
    save(state);
  },

  getOrder(orderId) {
    return state.pendingOrders[orderId] || null;
  },

  completeOrder(orderId, txHash) {
    const order = state.pendingOrders[orderId];
    if (order) {
      state.orders[txHash] = { ...order, txHash, completedAt: Date.now() };
      delete state.pendingOrders[orderId];
      save(state);
    }
    return order;
  },

  cancelOrder(orderId) {
    const order = state.pendingOrders[orderId];
    if (order) {
      this.removeHold(order.bglAmount);
      delete state.pendingOrders[orderId];
      save(state);
    }
  },

  isTxProcessed(txHash) {
    return !!state.orders[txHash];
  },

  // Tip limit tracking (500 BGL per 24h rolling)
  checkTipLimit(amount) {
    const now = Date.now();
    if (!state.dailyTipResetAt || now > state.dailyTipResetAt) {
      state.dailyTipUsed = 0;
      state.dailyTipResetAt = now + 24 * 60 * 60 * 1000;
      save(state);
    }
    return {
      canTip: state.dailyTipUsed + amount <= 500,
      used: state.dailyTipUsed,
      remaining: 500 - state.dailyTipUsed,
      resetsAt: state.dailyTipResetAt,
    };
  },

  addTipUsed(amount) {
    state.dailyTipUsed += amount;
    save(state);
  },

  updateOrderField(orderId, field, value) {
    if (state.pendingOrders[orderId]) {
      state.pendingOrders[orderId][field] = value;
      save(state);
    }
  },

  // Persist seen tx hashes so restarts don't lose confirmation progress
  markTxSeen(txHash, tag = '') {
    const key = txHash + tag;
    if (!state.seenTxHashes) state.seenTxHashes = {};
    state.seenTxHashes[key] = Date.now();
    save(state);
  },

  isTxSeen(txHash, tag = '') {
    const key = txHash + tag;
    return !!(state.seenTxHashes?.[key]);
  },

  // Clean old seen hashes (older than 7 days)
  cleanSeenHashes() {
    if (!state.seenTxHashes) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(state.seenTxHashes)) {
      if (v < cutoff) delete state.seenTxHashes[k];
    }
    save(state);
  },

  setStoreMessageId(messageId) {
    state.storeMessageId = messageId;
    save(state);
  },

  // Clean up stale pending orders (>1 hour)
  cleanStaleOrders() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    let cleaned = 0;
    for (const [orderId, order] of Object.entries(state.pendingOrders)) {
      if (order.createdAt < cutoff) {
        this.removeHold(order.bglAmount);
        delete state.pendingOrders[orderId];
        cleaned++;
      }
    }
    if (cleaned > 0) save(state);
    return cleaned;
  },
};
