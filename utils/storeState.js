// utils/storeState.js
// In-memory + JSON-persisted store state

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/store.json');
const DAILY_TIP_LIMIT = parseInt(process.env.TIP_DAILY_LIMIT) || 500;

const DEFAULT_STATE = {
  bglPriceEur: parseFloat(process.env.BGL_PRICE_EUR) || 1.25,
  bglPriceUsd: parseFloat(process.env.BGL_PRICE_USD) || 1.35,
  stockBgls: parseInt(process.env.STOCK_BGLS) || 1000,
  onHoldBgls: 0,
  orders: {},         // txHash -> completed order
  pendingOrders: {},  // orderId -> order awaiting payment/delivery
  seenTxHashes: {},
  dailyTipUsed: 0,
  dailyTipResetAt: null,
};

const round2 = (n) => Math.floor(n * 100) / 100;

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
    state.stockBgls = round2(parseFloat(amount));
    save(state);
  },

  getAvailableStock() {
    return Math.max(0, round2(state.stockBgls - state.onHoldBgls));
  },

  addHold(bgls) { state.onHoldBgls = round2(state.onHoldBgls + bgls); save(state); },

  removeHold(bgls) { state.onHoldBgls = Math.max(0, round2(state.onHoldBgls - bgls)); save(state); },

  // Decrement total stock only (hold is managed separately in the new flow).
  consumeStock(bgls) { state.stockBgls = Math.max(0, round2(state.stockBgls - bgls)); save(state); },

  addOrder(orderId, order) {
    state.pendingOrders[orderId] = { ...order, createdAt: Date.now() };
    save(state);
  },

  getOrder(orderId) { return state.pendingOrders[orderId] || null; },

  updateOrderField(orderId, field, value) {
    if (state.pendingOrders[orderId]) {
      state.pendingOrders[orderId][field] = value;
      save(state);
    }
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
    const key = txHash + tag;
    if (!state.seenTxHashes) state.seenTxHashes = {};
    state.seenTxHashes[key] = Date.now();
    save(state);
  },

  isTxSeen(txHash, tag = '') { return !!(state.seenTxHashes?.[txHash + tag]); },

  cleanSeenHashes() {
    if (!state.seenTxHashes) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(state.seenTxHashes)) {
      if (v < cutoff) delete state.seenTxHashes[k];
    }
    save(state);
  },

  setStoreMessageId(messageId) { state.storeMessageId = messageId; save(state); },
};
