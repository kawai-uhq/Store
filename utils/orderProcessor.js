// utils/orderProcessor.js — UNIQUE-AMOUNT order lifecycle (no forwarding)
//   Buy modal (username + USD) -> quote exact unique LTC amount on ONE static
//   address -> show address + QR -> poll that address, match payment BY AMOUNT
//   -> deliver BGLs at DELIVERY_CONFIRMATIONS.

const { MessageFlags, AttachmentBuilder } = require('discord.js');
const crypto = require('crypto');
const fs = require('fs');

const storeState = require('./storeState');
const ltcMonitor = require('./ltcMonitor');
const gamblit = require('./gamblit');
const { bip21, makeQrBuffer } = require('./qr');
const {
  buildOrderConfirmation, buildCopyReply, buildOrderCompleted,
  buildOrderFailed, buildPaymentDetected, buildPaymentReceived, buildStockInfo,
} = require('./components');
const { buildBuyModal, buildTxModal } = require('./orderModal');
const { refreshStoreMessage } = require('../commands/admin');

const NOTIFY_CONFIRMATIONS = parseInt(process.env.NOTIFY_CONFIRMATIONS) || 1;   // DM "payment detected" at this many confs
const DELIVERY_CONFIRMATIONS = parseInt(process.env.DELIVERY_CONFIRMATIONS) || 2; // tip at this many confs
const ORDER_TTL_MS = 60 * 60 * 1000;
const TOL_SAT = 800;       // amount-match tolerance
const SPACING_SAT = 2000;  // gap between unique amounts (> 2*TOL_SAT)

// Vouch request (sent in DM after delivery)
const VOUCH_URL = process.env.VOUCH_CHANNEL_URL || 'https://discord.com/channels/1514248323983474849/1517560644554199122';
const VOUCH_TARGET = process.env.VOUCH_TARGET_ID || '1445760217986895963';

const generateOrderId = () => 'ORD-' + crypto.randomBytes(4).toString('hex').toUpperCase();

// Pick a collision-free LTC amount near baseLtc, spaced from other pending orders.
function uniqueLtcAmount(baseLtc, pendingOrders) {
  const usedSat = Object.values(pendingOrders).filter((o) => o.expectedSat).map((o) => o.expectedSat);
  const baseSat = Math.round(baseLtc * 1e8);
  for (let k = 1; k <= 80; k++) {
    const cand = baseSat + k * SPACING_SAT;
    if (usedSat.every((u) => Math.abs(u - cand) > TOL_SAT)) return cand;
  }
  return baseSat + Math.floor(Math.random() * 200000) + SPACING_SAT; // fallback
}

const TX_GRACE_MS = 15 * 60 * 1000; // allow payments up to 15 min before order creation

// Assign a pool address not currently used by another active order (random).
// Falls back to a reused address (unique amount still disambiguates).
function pickAddress(pendingOrders) {
  const list = (process.env.LTC_WALLET_ADDRESSES || process.env.LTC_WALLET_ADDRESS || '')
    .split(',').map((a) => a.trim()).filter(Boolean);
  if (!list.length) return null;
  const used = new Set(Object.values(pendingOrders).filter((o) => o.status === 'pending' || o.status === 'paid').map((o) => o.address));
  const free = list.filter((a) => !used.has(a));
  const pickFrom = free.length ? free : list;
  return pickFrom[Math.floor(Math.random() * pickFrom.length)];
}

// ─── Tip queue (one at a time, 16s gap) ───────────────────────────────────────
let lastTipTime = 0, tipRunning = false;
const tipQueue = [];
function enqueueTip(fn) {
  return new Promise((resolve, reject) => { tipQueue.push({ fn, resolve, reject }); processTipQueue(); });
}
async function processTipQueue() {
  if (tipRunning) return;
  tipRunning = true;
  while (tipQueue.length) {
    const { fn, resolve, reject } = tipQueue.shift();
    try {
      const wait = 16000 - (Date.now() - lastTipTime);
      if (lastTipTime > 0 && wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastTipTime = Date.now();
      resolve(await fn());
    } catch (e) { reject(e); }
  }
  tipRunning = false;
}

// ─── Buy / stock ──────────────────────────────────────────────────────────────
async function handleBuyButton(interaction) {
  if (!storeState.isShopOpen()) {
    return interaction.reply({ content: '🔴 The shop is currently **closed**. Please check back later.', flags: MessageFlags.Ephemeral });
  }
  await interaction.showModal(buildBuyModal());
}
async function handleStockButton(interaction) { await interaction.reply(await buildStockInfo()); }

async function handleBuyModalSubmit(interaction, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!storeState.isShopOpen()) return interaction.editReply(buildOrderFailed({ reason: 'The shop is currently closed.' }));
  const gamblitUsername = interaction.fields.getTextInputValue('gamblit_username').trim();
  const usd = parseFloat(interaction.fields.getTextInputValue('usd_amount').trim());

  if (isNaN(usd) || usd <= 0) return interaction.editReply(buildOrderFailed({ reason: 'Invalid USD amount. Enter a number like `5`.' }));

  try {
    const address = pickAddress(storeState.get().pendingOrders);
    if (!address) return interaction.editReply(buildOrderFailed({ reason: 'Store wallet not configured. Contact support.' }));

    const rates = await ltcMonitor.getLtcUsdRate();
    const state = storeState.get();
    const bglAmount = Math.floor((usd / state.bglPriceUsd) * 100) / 100;
    if (bglAmount <= 0) return interaction.editReply(buildOrderFailed({ reason: `That USD amount is under the price of 1 BGL ($${state.bglPriceUsd.toFixed(2)}).` }));

    const available = storeState.getAvailableStock();
    if (bglAmount > available) return interaction.editReply(buildOrderFailed({ reason: `Not enough stock — you'd get **${bglAmount} BGLs** but only **${available}** are available.` }));

    const baseLtc = usd / rates.usd;
    const expectedSat = uniqueLtcAmount(baseLtc, state.pendingOrders);
    const ltcAmount = (expectedSat / 1e8).toFixed(8);

    const orderId = generateOrderId();
    const expiresAt = Date.now() + ORDER_TTL_MS;
    const uri = bip21(address, ltcAmount, `AutoStore ${orderId}`);
    const qrBuf = await makeQrBuffer(uri);

    storeState.addOrder(orderId, {
      orderId, gamblitUsername, userId: interaction.user.id, username: interaction.user.username,
      address, ltcAmount, expectedSat, usdAmount: usd.toFixed(2),
      bglAmount, estBgl: bglAmount, heldAmount: bglAmount,
      status: 'pending', notifiedDetected: false, depositTxHash: null, expiresAt,
    });
    storeState.addHold(bglAmount);
    await refreshStoreMessage(client).catch(() => {});

    const payload = buildOrderConfirmation({ orderId, bglAmount, usdAmount: usd.toFixed(2), ltcAmount, address, expiresAt, confirmations: DELIVERY_CONFIRMATIONS });
    payload.files = [{ attachment: qrBuf, name: 'qr.png' }];
    await interaction.editReply(payload);

    await logToAdmin(client, { type: 'ORDER_CREATED', orderId, bglAmount, usd: usd.toFixed(2), ltcAmount, gamblitUsername, userTag: interaction.user.tag });
  } catch (e) {
    console.error('[OrderProcessor] Modal submit error:', e.message);
    return interaction.editReply(buildOrderFailed({ reason: 'An internal error occurred. Please try again.' }));
  }
}

async function handleCopyAddress(interaction, orderId) {
  const order = storeState.getOrder(orderId);
  if (!order) return interaction.reply({ content: '❌ Order not found or already completed.', flags: MessageFlags.Ephemeral });
  return interaction.reply(buildCopyReply({ address: order.address, ltcAmount: order.ltcAmount }));
}

async function handleTxIdButton(interaction, orderId) {
  const order = storeState.getOrder(orderId);
  if (!order) return interaction.reply({ content: '❌ Order not found or already completed.', flags: MessageFlags.Ephemeral });
  if (order.userId !== interaction.user.id) return interaction.reply({ content: '❌ This is not your order.', flags: MessageFlags.Ephemeral });
  await interaction.showModal(buildTxModal(orderId));
}

async function handleTxModalSubmit(interaction, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const orderId = interaction.customId.replace('modal_txid_', '');
  const raw = interaction.fields.getTextInputValue('tx_hash').trim().toLowerCase();
  const txHash = raw.replace(/[^a-f0-9]/g, '');

  const order = storeState.getOrder(orderId);
  if (!order) return interaction.editReply(buildOrderFailed({ reason: 'Order not found or already completed.' }));
  if (order.userId !== interaction.user.id) return interaction.editReply(buildOrderFailed({ reason: 'This is not your order.' }));
  if (order.status !== 'pending') {
    const msg = order.status === 'underpaid'
      ? 'This order was underpaid and needs manual support — please contact us for a refund.'
      : 'This order already has a payment recorded and is being processed.';
    return interaction.editReply(buildOrderFailed({ orderId, reason: msg }));
  }
  if (!/^[a-f0-9]{64}$/.test(txHash)) return interaction.editReply(buildOrderFailed({ orderId, reason: 'That doesn\'t look like a valid Litecoin TX hash (should be 64 hex characters).' }));

  // Reject a hash already linked elsewhere or already completed
  const all = storeState.get().pendingOrders;
  const dup = Object.values(all).find((o) => o.orderId !== orderId && o.depositTxHash === txHash);
  if (dup || storeState.isTxProcessed(txHash)) return interaction.editReply(buildOrderFailed({ orderId, reason: 'That transaction is already linked to another order.' }));

  const res = await ltcMonitor.lookupTx(txHash, order.address);
  if (!res.found) return interaction.editReply(buildOrderFailed({ orderId, reason: 'Transaction not found yet. Wait ~30s after sending, then try again.' }));

  const paidSat = Math.round(res.ltcAmount * 1e8);
  // Proportional both ways: deliver BGLs worth exactly what was paid.
  let deliverBgl = order.bglAmount;
  if (Math.abs(paidSat - order.expectedSat) > TOL_SAT) {
    deliverBgl = Math.floor((order.bglAmount * (paidSat / order.expectedSat)) * 100) / 100;
  }
  if (deliverBgl <= 0) {
    storeState.updateOrderField(orderId, 'depositTxHash', txHash);
    storeState.updateOrderField(orderId, 'status', 'underpaid');
    storeState.removeHold(order.heldAmount || 0);
    storeState.updateOrderField(orderId, 'heldAmount', 0);
    await refreshStoreMessage(client).catch(() => {});
    await logToAdmin(client, { type: 'UNDERPAID', orderId, paid: res.ltcAmount, expected: order.ltcAmount, note: 'too small to tip' });
    return interaction.editReply(buildOrderFailed({ orderId, reason: `You sent **${res.ltcAmount} LTC**, which is too small to deliver any BGLs. Please contact support for a refund.` }));
  }
  storeState.updateOrderField(orderId, 'deliverBgl', deliverBgl);

  // Reject payments made before this order existed (prevents claiming old transactions).
  if (res.timeMs && res.timeMs < (order.createdAt || 0) - TX_GRACE_MS) {
    return interaction.editReply(buildOrderFailed({ orderId, reason: 'That transaction was made before this order was created, so it can\'t be applied here. Please send a new payment for this order (or contact support if you believe this is a mistake).' }));
  }

  // Link the payment
  storeState.updateOrderField(orderId, 'depositTxHash', txHash);
  storeState.updateOrderField(orderId, 'status', 'paid');
  storeState.updateOrderField(orderId, 'notifiedDetected', false);

  if (paidSat > order.expectedSat + TOL_SAT) {
    await logToAdmin(client, { type: 'OVERPAID', orderId, paid: res.ltcAmount, expected: order.ltcAmount, surplus: ((paidSat - order.expectedSat) / 1e8).toFixed(8) });
  }

  // Acknowledge submission; notification (1 conf) and delivery (2 conf) proceed by confirmations.
  await interaction.editReply(buildPaymentReceived({ orderId, ltcAmount: res.ltcAmount, confirmations: res.confirmations, notify: NOTIFY_CONFIRMATIONS, target: DELIVERY_CONFIRMATIONS }));
  await logToAdmin(client, { type: 'PAYMENT_SUBMITTED', orderId, ltc: res.ltcAmount, confirmations: res.confirmations, via: 'tx-submit' });

  await progressOrder(storeState.getOrder(orderId), res, client);
}

// Shared confirmation handler: notify at NOTIFY_CONFIRMATIONS, deliver at DELIVERY_CONFIRMATIONS.
async function progressOrder(o, res, client) {
  if (!o || delivering.has(o.orderId) || o.status === 'done' || o.status === 'delivering') return;
  const conf = res.confirmations || 0;

  if (conf >= NOTIFY_CONFIRMATIONS && !o.notifiedDetected) {
    storeState.updateOrderField(o.orderId, 'notifiedDetected', true);
    try {
      const user = await client.users.fetch(o.userId);
      await user.send(buildPaymentDetected({ orderId: o.orderId, ltcAmount: res.ltcAmount, gamblitUsername: o.gamblitUsername, confirmations: conf, target: DELIVERY_CONFIRMATIONS }));
    } catch (_) {}
    await logToAdmin(client, { type: 'PAYMENT_DETECTED', orderId: o.orderId, ltc: res.ltcAmount, confirmations: conf });
  }

  if (conf >= DELIVERY_CONFIRMATIONS) {
    delivering.add(o.orderId);
    deliverOrder(storeState.getOrder(o.orderId), { txHash: o.depositTxHash, confirmations: conf, valueSat: Math.round(res.ltcAmount * 1e8) }, client)
      .finally(() => delivering.delete(o.orderId));
  }
}

async function handleCancelOrder(interaction, orderId, client) {
  const order = storeState.getOrder(orderId);
  if (!order) return interaction.reply({ content: '❌ Order not found or already completed.', flags: MessageFlags.Ephemeral });
  if (order.userId !== interaction.user.id) return interaction.reply({ content: '❌ This is not your order.', flags: MessageFlags.Ephemeral });
  if (order.status !== 'pending') return interaction.reply({ content: '❌ Payment already detected — this order can no longer be cancelled.', flags: MessageFlags.Ephemeral });
  storeState.cancelOrder(orderId);
  await refreshStoreMessage(client).catch(() => {});
  return interaction.reply({ content: `✅ Order \`${orderId}\` cancelled.`, flags: MessageFlags.Ephemeral });
}

// ─── Polling: match payments by amount ────────────────────────────────────────
const delivering = new Set();
let pollTimer = null;

function startOrderPoller(client, intervalMs = 60_000) {
  if (pollTimer) clearInterval(pollTimer);
  storeState.cleanSeenHashes();
  const mode = process.env.ADDRESS_AUTODETECT === 'true' ? 'submitted TX IDs + address autodetect' : 'submitted TX IDs only';
  console.log(`[Poller] Confirmation watcher running (${mode}, notify at ${NOTIFY_CONFIRMATIONS} conf, deliver at ${DELIVERY_CONFIRMATIONS} conf)`);
  const tick = () => pollOnce(client).catch((e) => console.error('[Poller] tick error:', e.message));
  tick();
  pollTimer = setInterval(tick, intervalMs);
}
function stopOrderPoller() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function pollOnce(client) {
  // Optional: scan the whole address to auto-match payments (off by default).
  if (process.env.ADDRESS_AUTODETECT === 'true') {
    await autoDetect(client).catch((e) => console.error('[Poller] autoDetect:', e.message));
  }

  // Always: check ONLY submitted TX IDs for confirmation progress + delivery.
  const state = storeState.get();
  const submitted = Object.values(state.pendingOrders).filter((o) => o.status === 'paid' && o.depositTxHash);
  for (const o of submitted) {
    if (delivering.has(o.orderId)) continue;
    const res = await ltcMonitor.lookupTx(o.depositTxHash, o.address);
    if (!res.found) continue;
    await progressOrder(o, res, client);
  }
}

// Optional address-scan auto-detection. Enable with ADDRESS_AUTODETECT=true if you
// also want payments matched without the buyer submitting a TX ID.
async function autoDetect(client) {
  const state = storeState.get();
  const pending = Object.values(state.pendingOrders).filter((o) => o.status === 'pending' && !o.depositTxHash);
  if (pending.length === 0) return;
  const assigned = new Set(Object.values(state.pendingOrders).filter((o) => o.depositTxHash).map((o) => o.depositTxHash));
  const addresses = [...new Set(pending.map((o) => o.address).filter(Boolean))];

  for (const address of addresses) {
    const txs = await ltcMonitor.getAddressIncomingTxs(address);
    for (const tx of txs) {
      if (assigned.has(tx.txHash) || storeState.isTxProcessed(tx.txHash)) continue;
      const match = pending.find((o) =>
        o.address === address && !o.depositTxHash &&
        Math.abs(o.expectedSat - tx.valueSat) <= TOL_SAT &&
        (!tx.timeMs || tx.timeMs >= (o.createdAt || 0) - TX_GRACE_MS)
      );
      if (!match) continue;
      assigned.add(tx.txHash);
      match.depositTxHash = tx.txHash; match.status = 'paid';
      storeState.updateOrderField(match.orderId, 'depositTxHash', tx.txHash);
      storeState.updateOrderField(match.orderId, 'status', 'paid');
      storeState.updateOrderField(match.orderId, 'notifiedDetected', false);
      console.log(`[Poller] 🔍 Auto-matched ${match.orderId} on ${address}: ${(tx.valueSat / 1e8).toFixed(8)} LTC (${tx.confirmations} conf)`);
      await progressOrder(storeState.getOrder(match.orderId), { confirmations: tx.confirmations, ltcAmount: tx.valueSat / 1e8 }, client);
    }
  }
}

async function deliverOrder(order, tx, client) {
  const fresh = storeState.getOrder(order.orderId);
  if (!fresh || fresh.status === 'done') return;
  try {
    const requested = fresh.deliverBgl || fresh.bglAmount;
    const capacity = storeState.getAvailableStock() + (fresh.heldAmount || 0);
    let bgl = requested;
    let capped = false;
    if (bgl > capacity) { bgl = Math.floor(capacity * 100) / 100; capped = true; }
    if (bgl <= 0) throw new Error('No stock available to deliver');
    const proportional = requested !== fresh.bglAmount;

    const lim = storeState.checkTipLimit(bgl);
    if (!lim.canTip) throw new Error(`Daily tip limit reached (${lim.used}/${lim.limit} BGL).`);

    storeState.updateOrderField(order.orderId, 'status', 'delivering');
    console.log(`[Poller] ✅ Delivering ${bgl} BGLs${proportional ? ' (proportional)' : ''}${capped ? ' (capped at stock)' : ''} to ${order.gamblitUsername} (${order.orderId})`);
    const tipResult = await enqueueTip(() => gamblit.tipUser(order.gamblitUsername, bgl));

    storeState.removeHold(fresh.heldAmount || 0);
    storeState.consumeStock(bgl);
    storeState.addTipUsed(bgl);
    storeState.completeOrder(order.orderId, tx.txHash);

    try {
      const user = await client.users.fetch(order.userId);
      await user.send(buildOrderCompleted({ orderId: order.orderId, bglAmount: bgl, gamblitUsername: order.gamblitUsername, txHash: tx.txHash }));
      // Vouch request
      const eurTotal = (bgl * storeState.get().bglPriceEur).toFixed(2);
      await user.send({ content: `Please leave a vouch at ${VOUCH_URL}`, allowedMentions: { parse: [] } });
      await user.send({ content: `\`\`\`\n+rep <@${VOUCH_TARGET}> ${bgl} BGLs for €${eurTotal} LTC via gamblit tipping through autostore\n\`\`\``, allowedMentions: { parse: [] } });
    } catch (_) {}
    await refreshStoreMessage(client).catch(() => {});

    const logData = { type: 'ORDER_COMPLETED', orderId: order.orderId, bglAmount: bgl, gamblitUsername: order.gamblitUsername, txHash: tx.txHash };
    if (proportional) logData.ordered = fresh.bglAmount;
    if (capped) logData.note = `CAPPED at stock — buyer paid for ${requested} BGLs; ${Math.floor((requested - bgl) * 100) / 100} owed (manual top-up/refund)`;
    else if (proportional) logData.note = 'proportional';
    await logToAdmin(client, logData, tipResult?.screenshot);
  } catch (e) {
    console.error(`[Poller] Delivery failed for ${order.orderId}:`, e.message);
    storeState.updateOrderField(order.orderId, 'status', 'failed');
    storeState.removeHold(storeState.getOrder(order.orderId)?.heldAmount || 0);
    try {
      const user = await client.users.fetch(order.userId);
      await user.send(buildOrderFailed({ orderId: order.orderId, reason: `Payment received but delivery failed: ${e.message}\nContact support with your order ID.` }));
    } catch (_) {}
    await logToAdmin(client, { type: 'DELIVERY_FAILED', orderId: order.orderId, gamblitUsername: order.gamblitUsername, error: e.message });
  }
}

async function cleanupExpiredOrders(client) {
  const state = storeState.get();
  let cleaned = 0;
  for (const [orderId, order] of Object.entries(state.pendingOrders)) {
    if (order.status === 'pending' && order.expiresAt && Date.now() > order.expiresAt) {
      storeState.cancelOrder(orderId);
      cleaned++;
    }
  }
  if (cleaned > 0) { console.log(`[Cleanup] Expired ${cleaned} unpaid order(s)`); await refreshStoreMessage(client).catch(() => {}); }
  return cleaned;
}

async function logToAdmin(client, data, screenshotPath) {
  const channelId = process.env.LOG_CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    const emojis = { ORDER_CREATED: '📋', PAYMENT_DETECTED: '🔍', ORDER_COMPLETED: '✅', DELIVERY_FAILED: '❌' };
    let content = `${emojis[data.type] || '📌'} **${data.type}**\n`;
    for (const [k, v] of Object.entries(data)) if (k !== 'type') content += `\`${k}\`: ${v}\n`;
    content += `-# <t:${Math.floor(Date.now() / 1000)}:F>`;
    const files = [];
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      files.push(new AttachmentBuilder(fs.readFileSync(screenshotPath), { name: 'tip.png' }));
    }
    await channel.send({ content, files });
  } catch (e) { console.error('[OrderProcessor] Admin log failed:', e.message); }
}

module.exports = {
  handleBuyButton, handleStockButton, handleBuyModalSubmit,
  handleCopyAddress, handleTxIdButton, handleTxModalSubmit, handleCancelOrder,
  startOrderPoller, stopOrderPoller, cleanupExpiredOrders,
};
