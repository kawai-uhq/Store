// utils/orderProcessor.js
// Full order lifecycle with:
// - 1 confirmation → hold shown in embed
// - 6 confirmations → tip processed
// - 15s tip cooldown
// - Screenshot sent to buyer DM after tip

const { MessageFlags, AttachmentBuilder } = require('discord.js');
const crypto = require('crypto');
const fs = require('fs');
const storeState = require('./storeState');
const ltcMonitor = require('./ltcMonitor');
const gamblit = require('./gamblit');
const {
  buildOrderConfirmation,
  buildOrderCompleted,
  buildOrderFailed,
  buildPaymentDetected,
  buildStockInfo,
} = require('./components');
const { buildBuyModal, parseFiatInput } = require('./orderModal');
const { refreshStoreMessage } = require('../commands/admin');

function generateOrderId() {
  return 'ORD-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Tip queue — ensures tips are processed one at a time with 16s gap
let lastTipTime = 0;
let tipQueueRunning = false;
const tipQueue = [];

async function enqueueTip(fn) {
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
      // Wait for cooldown before each tip
      const now = Date.now();
      const elapsed = now - lastTipTime;
      const COOLDOWN_MS = 16000;
      if (lastTipTime > 0 && elapsed < COOLDOWN_MS) {
        const wait = COOLDOWN_MS - elapsed;
        console.log(`[TipQueue] Waiting ${(wait/1000).toFixed(1)}s cooldown before next tip...`);
        await new Promise(r => setTimeout(r, wait));
      }
      lastTipTime = Date.now();
      const result = await fn();
      resolve(result);
    } catch (e) {
      reject(e);
    }
  }

  tipQueueRunning = false;
}

// Handle the "Buy" button click → show modal
async function handleBuyButton(interaction) {
  await interaction.showModal(buildBuyModal());
}

// Handle the "Stock" button click
async function handleStockButton(interaction) {
  const payload = await buildStockInfo();
  await interaction.reply(payload);
}

// Handle modal submission
async function handleBuyModalSubmit(interaction, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const gamblitUsername = interaction.fields.getTextInputValue('gamblit_username').trim();
  const bglRaw = interaction.fields.getTextInputValue('bgl_amount').trim();
  const fiatRaw = interaction.fields.getTextInputValue('fiat_amount').trim();

  if (!bglRaw && !fiatRaw) {
    return interaction.editReply({
      ...buildOrderFailed({ reason: 'Please enter either a BGL amount or a fiat amount.' }),
    });
  }

  let bglAmount, ltcAmount, fiatAmount, currency;

  try {
    if (bglRaw) {
      bglAmount = parseFloat(bglRaw);
      if (isNaN(bglAmount) || bglAmount <= 0) {
        return interaction.editReply({
          ...buildOrderFailed({ reason: 'Invalid BGL amount.' }),
        });
      }
      const state = storeState.get();
      currency = 'eur';
      fiatAmount = (bglAmount * state.bglPriceEur).toFixed(2);
      ltcAmount = await ltcMonitor.bglToLtc(bglAmount, 'eur');
    } else {
      const parsed = parseFiatInput(fiatRaw);
      if (!parsed) {
        return interaction.editReply({
          ...buildOrderFailed({ reason: 'Invalid fiat amount. Format: `10 USD` or `8 EUR`' }),
        });
      }
      currency = parsed.currency;
      fiatAmount = parsed.amount.toFixed(2);
      const result = await ltcMonitor.fiatToBglAndLtc(parsed.amount, parsed.currency);
      bglAmount = result.bglAmount;
      ltcAmount = result.ltcAmount;
    }

    if (bglAmount <= 0) {
      return interaction.editReply({
        ...buildOrderFailed({ reason: 'The amount is too low.' }),
      });
    }

    const available = storeState.getAvailableStock();
    if (bglAmount > available) {
      return interaction.editReply({
        ...buildOrderFailed({
          reason: `Not enough stock! You requested **${bglAmount} BGLs** but only **${available} BGLs** are available.`,
        }),
      });
    }

    const orderId = generateOrderId();
    const walletAddress = process.env.LTC_WALLET_ADDRESS;
    const expiresAt = Date.now() + 60 * 60 * 1000;

    // Make LTC amount unique per order by adding a tiny offset (0.00001 per pending order)
    // This prevents two orders for the same BGL amount from being indistinguishable
    const pendingCount = Object.keys(storeState.get().pendingOrders).length;
    const uniqueLtcAmount = parseFloat((parseFloat(ltcAmount) + pendingCount * 0.00001).toFixed(6));
    console.log(`[OrderProcessor] LTC amount: ${ltcAmount} → ${uniqueLtcAmount} (offset for uniqueness)`);

    storeState.addOrder(orderId, {
      orderId,
      bglAmount,
      ltcAmount: uniqueLtcAmount,
      fiatAmount,
      currency,
      gamblitUsername,
      walletAddress,
      userId: interaction.user.id,
      username: interaction.user.username,
      expiresAt,
      confirmations: 0,
    });

    // Update ltcAmount shown to user
    ltcAmount = uniqueLtcAmount.toFixed(6);

    // Don't add hold yet — wait for 1 confirmation
    await refreshStoreMessage(client).catch(() => {});

    const confirmPayload = buildOrderConfirmation({
      orderId,
      bglAmount,
      ltcAmount,
      walletAddress,
      currency,
      fiatAmount,
      expiresAt,
    });

    await interaction.editReply(confirmPayload);

    await logToAdmin(client, {
      type: 'ORDER_CREATED',
      orderId,
      bglAmount,
      ltcAmount,
      gamblitUsername,
      userId: interaction.user.id,
      userTag: interaction.user.tag,
    });

  } catch (e) {
    console.error('[OrderProcessor] Modal submit error:', e.message);
    return interaction.editReply({
      ...buildOrderFailed({ reason: 'An internal error occurred. Please try again.' }),
    });
  }
}

// Handle cancel order button
async function handleCancelOrder(interaction, orderId, client) {
  const order = storeState.getOrder(orderId);
  if (!order) {
    return interaction.reply({ content: '❌ Order not found or already completed.', flags: MessageFlags.Ephemeral });
  }
  if (order.userId !== interaction.user.id) {
    return interaction.reply({ content: '❌ This is not your order.', flags: MessageFlags.Ephemeral });
  }
  storeState.cancelOrder(orderId);
  await refreshStoreMessage(client).catch(() => {});
  return interaction.reply({ content: `✅ Order \`${orderId}\` cancelled.`, flags: MessageFlags.Ephemeral });
}

// Process LTC payment — called by ltcMonitor for every confirmation update
async function processConfirmedPayment(txData, client) {
  const { txHash, ltcAmount, confirmations, pending } = txData;

  const match = ltcMonitor.matchOrderByLtcAmount(ltcAmount);
  if (!match) {
    console.warn(`[OrderProcessor] No order match for ${ltcAmount} LTC (tx: ${txHash})`);
    await logToAdmin(client, { type: 'UNMATCHED_PAYMENT', txHash, ltcAmount });
    return;
  }

  const { orderId, order } = match;

  // ── 1 confirmation: put on hold, update embed, notify user ───────────────
  if (confirmations >= 1 && confirmations < 6) {
    if (!order.holdAdded) {
      console.log(`[OrderProcessor] 1 confirmation — putting ${order.bglAmount} BGLs on hold for ${orderId}`);
      storeState.updateOrderField(orderId, 'holdAdded', true);
      storeState.addHold(order.bglAmount);
      await refreshStoreMessage(client).catch(() => {});

      try {
        const user = await client.users.fetch(order.userId);
        await user.send(buildPaymentDetected({
          orderId, ltcAmount,
          bglAmount: order.bglAmount,
          gamblitUsername: order.gamblitUsername,
          confirmations,
        }));
      } catch (_) {}

      await logToAdmin(client, {
        type: 'PAYMENT_1_CONF', orderId,
        bglAmount: order.bglAmount, confirmations, txHash,
      });
    }
    return; // Wait for 6 confirmations
  }

  // ── 6 confirmations: process tip ─────────────────────────────────────────
  // Add hold if it wasn't added at 1 conf (e.g. bot restarted)
  if (!order.holdAdded) {
    storeState.updateOrderField(orderId, 'holdAdded', true);
    storeState.addHold(order.bglAmount);
    await refreshStoreMessage(client).catch(() => {});
  }

  console.log(`[OrderProcessor] 6 confirmations ✅ — queuing tip for ${orderId}`);
  storeState.completeOrder(orderId, txHash);

  try {
    // Queue the tip — enforces 16s gap between tips automatically
    await enqueueTip(async () => {
      console.log(`[TipQueue] Processing tip for ${orderId}: ${order.bglAmount} BGLs → ${order.gamblitUsername}`);
      await gamblit.tipUser(order.gamblitUsername, order.bglAmount);
    });
    storeState.addTipUsed(order.bglAmount);
    storeState.deductStock(order.bglAmount);

    // Take screenshot of result and send to user DM
    const screenshotPath = `/tmp/tip_result_${orderId}_${Date.now()}.png`;
    try {
      const page = await gamblit._getPageForScreenshot(process.env.GAMBLIT_URL || 'https://gamblit.net');
      await page.screenshot({ path: screenshotPath });
    } catch (ssErr) {
      console.warn('[OrderProcessor] Screenshot failed:', ssErr.message);
    }

    // Notify user with screenshot
    try {
      const user = await client.users.fetch(order.userId);
      const dmPayload = buildOrderCompleted({
        orderId,
        bglAmount: order.bglAmount,
        gamblitUsername: order.gamblitUsername,
        txHash,
      });

      // Attach screenshot if it exists
      if (fs.existsSync(screenshotPath)) {
        dmPayload.files = [new AttachmentBuilder(fs.readFileSync(screenshotPath), { name: 'tip_confirmation.png' })];
      }

      await user.send(dmPayload);
    } catch (dmErr) {
      console.warn('[OrderProcessor] Could not DM user:', dmErr.message);
    }

    await refreshStoreMessage(client).catch(() => {});

    await logToAdmin(client, {
      type: 'ORDER_COMPLETED',
      orderId,
      bglAmount: order.bglAmount,
      gamblitUsername: order.gamblitUsername,
      txHash,
      ltcAmount,
    });

    console.log(`[OrderProcessor] ✅ ${order.bglAmount} BGLs → ${order.gamblitUsername}`);

    // Cleanup screenshot
    try { fs.unlinkSync(screenshotPath); } catch (_) {}

  } catch (e) {
    console.error('[OrderProcessor] Tip failed:', e.message);
    storeState.removeHold(order.bglAmount);

    try {
      const user = await client.users.fetch(order.userId);
      await user.send(buildOrderFailed({
        orderId,
        reason: `Payment received but tip failed: ${e.message}. Please contact support with order ID \`${orderId}\`.`,
      }));
    } catch (_) {}

    await logToAdmin(client, {
      type: 'TIP_FAILED',
      orderId,
      bglAmount: order.bglAmount,
      gamblitUsername: order.gamblitUsername,
      txHash,
      error: e.message,
    });
  }
}

async function logToAdmin(client, data) {
  const channelId = process.env.LOG_CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    const emojis = { ORDER_CREATED: '📋', ORDER_COMPLETED: '✅', TIP_FAILED: '❌', UNMATCHED_PAYMENT: '⚠️', PAYMENT_1_CONF: '🔍' };
    let content = `${emojis[data.type] || '📌'} **${data.type}**\n`;
    for (const [k, v] of Object.entries(data)) {
      if (k !== 'type') content += `\`${k}\`: ${v}\n`;
    }
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
  processConfirmedPayment,
};
