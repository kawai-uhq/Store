// utils/orderProcessor.js
// Forwarding-address order lifecycle:
//   Buy modal -> create unique BlockCypher forwarding address (sweeps to main wallet)
//   -> poll that address for the deposit -> notify on detection
//   -> at DELIVERY_CONFIRMATIONS, compute BGLs from the ACTUAL received LTC and tip.
// Payments are matched by ADDRESS, so identical amounts never collide.

const { MessageFlags } = require('discord.js');
const crypto = require('crypto');
const fs = require('fs');

const storeState = require('./storeState');
const ltcMonitor = require('./ltcMonitor');
const gamblit = require('./gamblit');
const forwarding = require('./forwarding');
const {
  buildOrderConfirmation,
  buildOrderCompleted,
  buildOrderFailed,
  buildPaymentDetected,
  buildStockInfo,
} = require('./components');
const { buildBuyModal } = require('./orderModal');
const { refreshStoreMessage } = require('../commands/admin');

const DELIVERY_CONFIRMATIONS = parseInt(process.env.DELIVERY_CONFIRMATIONS) || 6;
const ORDER_TTL_MS = 60 * 60 * 1000; // 1 hour to pay

function generateOrderId() {
  return 'ORD-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ─── Tip queue (one tip at a time, 16s gap) ───────────────────────────────────
let lastTipTime = 0;
let tipQueueRunning = false;
const tipQueue = [];

function enqueueTip(fn) {
  return new Promise((resolve, reject) => {
    tipQueue.push({ fn, resolve, reject });
    processTipQueue();
  });
}

async function processTipQueue() {
  if (tipQueueRunning) return;
  tipQueueRunning = true;
  while (tipQueue.length > 0) {
    const { fn, resolve, reject } = tipQueue.shift();
    try {
      const elapsed = Date.now() - lastTipTime;
      const COOLDOWN = 16000;
      if (lastTipTime > 0 && elapsed < COOLDOWN) {
        await new Promise((r) => setTimeout(r, COOLDOWN - elapsed));
      }
      lastTipTime = Date.now();
      resolve(await fn());
    } catch (e) {
      reject(e);
    }
  }
  tipQueueRunning = false;
}

// ─── Buy button + modal ───────────────────────────────────────────────────────
async function handleBuyButton(interaction) {
  await interaction.showModal(buildBuyModal());
}

async function handleStockButton(interaction) {
  await interaction.reply(await buildStockInfo());
}

async function handleBuyModalSubmit(interaction, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const gamblitUsername = interaction.fields.getTextInputValue('gamblit_username').trim();
  const ltcRaw = interaction.fields.getTextInputValue('ltc_amount').trim();
  const ltcEstimate = parseFloat(ltcRaw);

  if (isNaN(ltcEstimate) || ltcEstimate <= 0) {
    return interaction.editReply(buildOrderFailed({ reason: 'Invalid LTC amount. Enter a number like `0.05`.' }));
  }

  try {
    const rates = await ltcMonitor.getLtcUsdRate();
    const state = storeState.get();
    const estEur = ltcEstimate * rates.eur;
    const estBgl = Math.floor((estEur / state.bglPriceEur) * 100) / 100;

    if (estBgl <= 0) {
      return interaction.editReply(buildOrderFailed({
        reason: `That LTC amount is worth less than 1 BGL at the current rate ($${rates.usd.toFixed(2)}/LTC).`,
      }));
    }

    const available = storeState.getAvailableStock();
    if (estBgl > available) {
      return interaction.editReply(buildOrderFailed({
        reason: `Not enough stock — your LTC would buy ~**${estBgl} BGLs** but only **${available} BGLs** are available.`,
      }));
    }

    // Create the unique forwarding address (sweeps to your main wallet).
    const destination = process.env.LTC_WALLET_ADDRESS;
    let fwd;
    try {
      fwd = await forwarding.createForwardingAddress(destination);
    } catch (e) {
      console.error('[OrderProcessor] Forwarding create failed:', e.response?.data || e.message);
      return interaction.editReply(buildOrderFailed({
        reason: 'Could not generate a payment address right now. Please try again in a moment.',
      }));
    }

    const orderId = generateOrderId();
    const expiresAt = Date.now() + ORDER_TTL_MS;

    storeState.addOrder(orderId, {
      orderId,
      gamblitUsername,
      userId: interaction.user.id,
      username: interaction.user.username,
      depositAddress: fwd.inputAddress,
      forwardId: fwd.id,
      ltcEstimate,
      estBgl,
      heldAmount: estBgl,
      status: 'pending',           // pending -> paid -> done | failed
      notifiedDetected: false,
      expiresAt,
    });
    storeState.addHold(estBgl);
    await refreshStoreMessage(client).catch(() => {});

    await interaction.editReply(buildOrderConfirmation({
      orderId,
      estBgl,
      depositAddress: fwd.inputAddress,
      ltcEstimate: ltcEstimate.toFixed(6),
      fiatUsd: (ltcEstimate * rates.usd).toFixed(2),
      expiresAt,
      confirmations: DELIVERY_CONFIRMATIONS,
    }));

    await logToAdmin(client, {
      type: 'ORDER_CREATED', orderId, estBgl,
      depositAddress: fwd.inputAddress, gamblitUsername,
      userTag: interaction.user.tag,
    });
  } catch (e) {
    console.error('[OrderProcessor] Modal submit error:', e.message);
    return interaction.editReply(buildOrderFailed({ reason: 'An internal error occurred. Please try again.' }));
  }
}

async function handleCancelOrder(interaction, orderId, client) {
  const order = storeState.getOrder(orderId);
  if (!order) return interaction.reply({ content: '❌ Order not found or already completed.', flags: MessageFlags.Ephemeral });
  if (order.userId !== interaction.user.id) return interaction.reply({ content: '❌ This is not your order.', flags: MessageFlags.Ephemeral });
  if (order.status !== 'pending') return interaction.reply({ content: '❌ Payment already detected — this order can no longer be cancelled.', flags: MessageFlags.Ephemeral });

  if (order.forwardId) await forwarding.deleteForwardingAddress(order.forwardId);
  storeState.cancelOrder(orderId);
  await refreshStoreMessage(client).catch(() => {});
  return interaction.reply({ content: `✅ Order \`${orderId}\` cancelled.`, flags: MessageFlags.Ephemeral });
}

// ─── Polling loop ─────────────────────────────────────────────────────────────
const delivering = new Set();
let pollTimer = null;

function startOrderPoller(client, intervalMs = 60_000) {
  if (pollTimer) clearInterval(pollTimer);
  storeState.cleanSeenHashes();
  console.log(`[Poller] Watching forwarding addresses (deliver at ${DELIVERY_CONFIRMATIONS} confs)`);
  const tick = () => pollOnce(client).catch((e) => console.error('[Poller] tick error:', e.message));
  tick();
  pollTimer = setInterval(tick, intervalMs);
}

function stopOrderPoller() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function pollOnce(client) {
  const state = storeState.get();
  const orders = Object.values(state.pendingOrders).filter(
    (o) => o.depositAddress && (o.status === 'pending' || o.status === 'paid')
  );

  for (const order of orders) {
    const deposit = await ltcMonitor.getAddressDeposit(order.depositAddress);
    if (!deposit) continue; // nothing received yet

    // First time we see funds — notify + mark paid
    if (!order.notifiedDetected) {
      storeState.updateOrderField(order.orderId, 'notifiedDetected', true);
      storeState.updateOrderField(order.orderId, 'status', 'paid');
      storeState.updateOrderField(order.orderId, 'depositTxHash', deposit.txHash);
      console.log(`[Poller] 🔍 Payment seen for ${order.orderId}: ${deposit.ltcAmount} LTC (${deposit.confirmations} conf)`);
      try {
        const user = await client.users.fetch(order.userId);
        await user.send(buildPaymentDetected({
          orderId: order.orderId,
          ltcAmount: deposit.ltcAmount,
          gamblitUsername: order.gamblitUsername,
          confirmations: deposit.confirmations,
          target: DELIVERY_CONFIRMATIONS,
        }));
      } catch (_) {}
      await logToAdmin(client, { type: 'PAYMENT_DETECTED', orderId: order.orderId, ltc: deposit.ltcAmount, confirmations: deposit.confirmations });
    }

    // Enough confirmations → deliver
    if (deposit.confirmations >= DELIVERY_CONFIRMATIONS && !delivering.has(order.orderId)) {
      delivering.add(order.orderId);
      deliverOrder(order, deposit, client).finally(() => delivering.delete(order.orderId));
    }
  }
}

async function deliverOrder(order, deposit, client) {
  // Re-read order in case state changed
  const fresh = storeState.getOrder(order.orderId);
  if (!fresh || fresh.status === 'done') return;

  try {
    const rates = await ltcMonitor.getLtcUsdRate();
    const state = storeState.get();
    const receivedEur = deposit.ltcAmount * rates.eur;
    const actualBgl = Math.floor((receivedEur / state.bglPriceEur) * 100) / 100;

    if (actualBgl <= 0) throw new Error('Received amount is below 1 BGL value');

    // Daily tip cap
    const lim = storeState.checkTipLimit(actualBgl);
    if (!lim.canTip) throw new Error(`Daily tip limit reached (${lim.used}/${lim.limit} BGL). Try again after reset.`);

    // Stock check: this order's held estimate counts toward its own capacity
    const capacity = storeState.getAvailableStock() + (fresh.heldAmount || 0);
    if (actualBgl > capacity) throw new Error(`Insufficient stock for ${actualBgl} BGLs (capacity ${capacity}).`);

    storeState.updateOrderField(order.orderId, 'status', 'delivering');
    console.log(`[Poller] ✅ Delivering ${actualBgl} BGLs to ${order.gamblitUsername} (order ${order.orderId})`);

    await enqueueTip(() => gamblit.tipUser(order.gamblitUsername, actualBgl));

    // Success — finalize
    storeState.removeHold(fresh.heldAmount || 0);
    storeState.consumeStock(actualBgl);
    storeState.addTipUsed(actualBgl);
    storeState.completeOrder(order.orderId, deposit.txHash);
    if (order.forwardId) forwarding.deleteForwardingAddress(order.forwardId).catch(() => {});

    try {
      const user = await client.users.fetch(order.userId);
      await user.send(buildOrderCompleted({
        orderId: order.orderId,
        bglAmount: actualBgl,
        gamblitUsername: order.gamblitUsername,
        txHash: deposit.txHash,
      }));
    } catch (_) {}

    await refreshStoreMessage(client).catch(() => {});
    await logToAdmin(client, {
      type: 'ORDER_COMPLETED', orderId: order.orderId,
      bglAmount: actualBgl, ltc: deposit.ltcAmount,
      gamblitUsername: order.gamblitUsername, txHash: deposit.txHash,
    });
    console.log(`[Poller] ✅ ${actualBgl} BGLs → ${order.gamblitUsername}`);
  } catch (e) {
    console.error(`[Poller] Delivery failed for ${order.orderId}:`, e.message);
    storeState.updateOrderField(order.orderId, 'status', 'failed');
    // NOTE: funds already received & swept — handle manually. Hold is released.
    storeState.removeHold(storeState.getOrder(order.orderId)?.heldAmount || 0);

    try {
      const user = await client.users.fetch(order.userId);
      await user.send(buildOrderFailed({
        orderId: order.orderId,
        reason: `Payment received but delivery failed: ${e.message}\nPlease contact support with your order ID.`,
      }));
    } catch (_) {}
    await logToAdmin(client, { type: 'DELIVERY_FAILED', orderId: order.orderId, gamblitUsername: order.gamblitUsername, error: e.message });
  }
}

// Expire unpaid orders + recycle their forwarding addresses.
async function cleanupExpiredOrders(client) {
  const state = storeState.get();
  let cleaned = 0;
  for (const [orderId, order] of Object.entries(state.pendingOrders)) {
    if (order.status === 'pending' && order.expiresAt && Date.now() > order.expiresAt) {
      if (order.forwardId) await forwarding.deleteForwardingAddress(order.forwardId);
      storeState.cancelOrder(orderId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Cleanup] Expired ${cleaned} unpaid order(s)`);
    await refreshStoreMessage(client).catch(() => {});
  }
  return cleaned;
}

async function logToAdmin(client, data) {
  const channelId = process.env.LOG_CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    const emojis = { ORDER_CREATED: '📋', PAYMENT_DETECTED: '🔍', ORDER_COMPLETED: '✅', DELIVERY_FAILED: '❌' };
    let content = `${emojis[data.type] || '📌'} **${data.type}**\n`;
    for (const [k, v] of Object.entries(data)) if (k !== 'type') content += `\`${k}\`: ${v}\n`;
    content += `-# <t:${Math.floor(Date.now() / 1000)}:F>`;
    await channel.send({ content });
  } catch (e) {
    console.error('[OrderProcessor] Admin log failed:', e.message);
  }
}

module.exports = {
  handleBuyButton,
  handleStockButton,
  handleBuyModalSubmit,
  handleCancelOrder,
  startOrderPoller,
  stopOrderPoller,
  cleanupExpiredOrders,
};
