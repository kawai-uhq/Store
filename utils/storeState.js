// utils/storeState.js
// Runtime state (orders, holds, daily tips) persisted to data/store.json.
// Editable SETTINGS (prices, stock, address pool, autoSyncStock) live in
// config.json and are managed via utils/config.js — see get()/setPrice()/setStock().

const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_FILE = path.join(__dirname, '../data/store.json');
const DAILY_TIP_LIMIT = parseInt(process.env.TIP_DAILY_LIMIT) || 500;

const DEFAULT_STATE = {
  onHoldBgls: 0,
  orders: {},
  pendingOrders: {},
  seenTxHashes: {},
  dailyTipUsed: 0,
  dailyTipResetAt: null,
  storeMessageId: null,
};

const round2 = (n) => Math.floor(n * 100) / 100;

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // settings moved to config.json — strip any legacy copies
      delete raw.bglPriceEur; delete raw.bglPriceUsd; delete raw.stockBgls;
      return { ...DEFAULT_STATE, ...raw };
    }
  } catch (e) { console.error('[StoreState] load failed:', e.message); }
  return { ...DEFAULT_STATE };
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.error('[StoreState] save failed:', e.message); }
}

let state = load();

module.exports = {
  // Returns runtime state merged with current settings from config.json.
  get() {
    const c = config.get();
    return { ...state, bglPriceEur: c.bglPriceEur, bglPriceUsd: c.bglPriceUsd, stockBgls: c.stockBgls };
  },
  getConfig() { return config.get(); },

  setPrice(eur, usd) { config.set({ bglPriceEur: parseFloat(eur), bglPriceUsd: parseFloat(usd) }); },
  setStock(amount) { config.set({ stockBgls: round2(parseFloat(amount)) }); },
  consumeStock(bgls) { const c = config.get(); config.set({ stockBgls: Math.max(0, round2(c.stockBgls - bgls)) }); },
  getAvailableStock() { return Math.max(0, round2(config.get().stockBgls - state.onHoldBgls)); },

  addHold(bgls) { state.onHoldBgls = round2(state.onHoldBgls + bgls); save(state); },
  removeHold(bgls) { state.onHoldBgls = Math.max(0, round2(state.onHoldBgls - bgls)); save(state); },

  addOrder(orderId, order) { state.pendingOrders[orderId] = { ...order, createdAt: Date.now() }; save(state); },
  getOrder(orderId) { return state.pendingOrders[orderId] || null; },
  updateOrderField(orderId, field, value) {
    if (state.pendingOrders[orderId]) { state.pendingOrders[orderId][field] = value; save(state); }
  },
  completeOrder(orderId, txHash) {
    const order = state.pendingOrders[orderId];
    if (order) {
      state.orders[txHash || orderId] = { ...order, txHash, completedAt: Date.now() };
      delete state.pendingOrders[orderId];
      save(state);
    }
    return order;
  },
  cancelOrder(orderId) {
    const order = state.pendingOrders[orderId];
    if (order) {
      if (order.heldAmount) this.removeHold(order.heldAmount);
      delete state.pendingOrders[orderId];
      save(state);
    }
    return order;
  },
  isTxProcessed(txHash) { return !!state.orders[txHash]; },

  checkTipLimit(amount) {
    const now = Date.now();
    if (!state.dailyTipResetAt || now > state.dailyTipResetAt) {
      state.dailyTipUsed = 0;
      state.dailyTipResetAt = now + 24 * 60 * 60 * 1000;
      save(state);
    }
    return {
      canTip: state.dailyTipUsed + amount <= DAILY_TIP_LIMIT,
      used: state.dailyTipUsed,
      remaining: DAILY_TIP_LIMIT - state.dailyTipUsed,
      limit: DAILY_TIP_LIMIT,
      resetsAt: state.dailyTipResetAt,
    };
  },
  addTipUsed(amount) { state.dailyTipUsed += amount; save(state); },

  markTxSeen(txHash, tag = '') {
    if (!state.seenTxHashes) state.seenTxHashes = {};
    state.seenTxHashes[txHash + tag] = Date.now();
    save(state);
  },
  isTxSeen(txHash, tag = '') { return !!(state.seenTxHashes?.[txHash + tag]); },
  cleanSeenHashes() {
    if (!state.seenTxHashes) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(state.seenTxHashes)) if (v < cutoff) delete state.seenTxHashes[k];
    save(state);
  },

  setStoreMessageId(id) { state.storeMessageId = id; save(state); },
};
