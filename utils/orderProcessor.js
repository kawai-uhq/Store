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
const { buildBuyModal, buildTxModal, parseFiatInput } = require('./orderModal');
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

// Handle modal submission — Pay What You Want
async function handleBuyModalSubmit(interaction, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const gamblitUsername = interaction.fields.getTextInputValue('gamblit_username').trim();
  const ltcRaw = interaction.fields.getTextInputValue('ltc_amount').trim();

  const ltcAmount = parseFloat(ltcRaw);
  if (isNaN(ltcAmount) || ltcAmount <= 0) {
    return interaction.editReply({
      ...buildOrderFailed({ reason: 'Invalid LTC amount. Enter a number like `0.05`.' }),
    });
  }

  try {
    const rates = await ltcMonitor.getLtcUsdRate();
    const state = storeState.get();
    const ltcValueUsd = ltcAmount * rates.usd;
    const ltcValueEur = ltcAmount * rates.eur;
    const bglAmount = Math.floor((ltcValueEur / state.bglPriceEur) * 100) / 100;

    if (bglAmount <= 0) {
      return interaction.editReply({
        ...buildOrderFailed({ reason: `That LTC amount is worth less than 1 BGL at current rates ($${rates.usd.toFixed(2)}/LTC).` }),
      });
    }

    const available = storeState.getAvailableStock();
    if (bglAmount > available) {
      return interaction.editReply({
        ...buildOrderFailed({
          reason: `Not enough stock! Your LTC would buy **${bglAmount} BGLs** but only **${available} BGLs** are available.`,
        }),
      });
    }

    const orderId = generateOrderId();
    const walletAddress = process.env.LTC_WALLET_ADDRESS;
    const expiresAt = Date.now() + 60 * 60 * 1000;

    storeState.addOrder(orderId, {
      orderId,
      bglAmount,
      ltcAmount,
      ltcValueUsd: ltcValueUsd.toFixed(2),
      ltcValueEur: ltcValueEur.toFixed(2),
      gamblitUsername,
      walletAddress,
      userId: interaction.user.id,
      username: interaction.user.username,
      expiresAt,
      confirmations: 0,
      payWhatYouWant: true,
    });

    await refreshStoreMessage(client).catch(() => {});

    const confirmPayload = buildOrderConfirmation({
      orderId,
      bglAmount,
      ltcAmount: ltcAmount.toFixed(6),
      walletAddress,
      currency: 'usd',
      fiatAmount: ltcValueUsd.toFixed(2),
      expiresAt,
      rateNote: `@$${rates.usd.toFixed(2)}/LTC — final BGL amount calculated from actual TX`,
    });

    await interaction.editReply(confirmPayload);

    await logToAdmin(client, {
      type: 'ORDER_CREATED',
      orderId,
      estimatedBgls: bglAmount,
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

// Handle "Submit TX ID" button
async function handleSubmitTxButton(interaction, orderId) {
  const order = storeState.getOrder(orderId);
  if (!order) {
    return interaction.reply({ content: '❌ Order not found or already completed.', flags: MessageFlags.Ephemeral });
  }
  if (order.userId !== interaction.user.id) {
    return interaction.reply({ content: '❌ This is not your order.', flags: MessageFlags.Ephemeral });
  }
  await interaction.showModal(buildTxModal(orderId));
}

// Handle TX ID modal submission
async function handleTxModalSubmit(interaction, orderId, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const txId = interaction.fields.getTextInputValue('tx_id').trim();
  const order = storeState.getOrder(orderId);

  if (!order) {
    return interaction.editReply({ content: '❌ Order not found or already completed.' });
  }
  if (order.userId !== interaction.user.id) {
    return interaction.editReply({ content: '❌ This is not your order.' });
  }

  // Look up the TX on BlockCypher
  await interaction.editReply({ content: '🔍 Looking up your transaction...' });

  const walletAddress = process.env.LTC_WALLET_ADDRESS;
  const txData = await ltcMonitor.lookupTx(txId, walletAddress);

  if (!txData.found) {
    return interaction.editReply({
      content: `❌ Transaction not found: \`${txData.error}\`
Make sure you copied the correct TX ID and that it's been broadcast to the network.`,
    });
  }

  // Check if it sent money to our wallet
  if (txData.ltcAmount <= 0) {
    return interaction.editReply({
      content: `❌ This transaction didn't send any LTC to our wallet address.
Make sure you sent to: \`${walletAddress}\``,
    });
  }

  // Check amount matches order (with tolerance)
  const diff = Math.abs(txData.ltcAmount - order.ltcAmount);
  const TOLERANCE = 0.0005; // 0.05% tolerance for TX ID submissions

  if (diff > TOLERANCE) {
    const shortfall = order.ltcAmount - txData.ltcAmount;
    if (shortfall > 0) {
      return interaction.editReply({
        content:
          `⚠️ **Underpayment detected**
` +
          `Your TX sent **${txData.ltcAmount.toFixed(6)} LTC** but this order requires **${order.ltcAmount.toFixed(6)} LTC**.
` +
          `Shortfall: \`${shortfall.toFixed(6)} LTC\`

` +
          `Please send the remaining amount to \`${walletAddress}\` and submit that TX ID too.`,
      });
    } else {
      // Overpaid — process anyway, note the extra
      console.log(`[OrderProcessor] TX submit overpaid by ${Math.abs(shortfall).toFixed(6)} LTC — processing`);
    }
  }

  // Check if already processed
  if (storeState.isTxProcessed(txId)) {
    return interaction.editReply({ content: '❌ This transaction has already been processed.' });
  }

  // Check confirmations
  if (txData.confirmations === 0) {
    // Store TX hash on order for monitoring
    storeState.updateOrderField(orderId, 'txHash', txId);
    storeState.updateOrderField(orderId, 'txSubmitted', true);
    return interaction.editReply({
      content:
        `🔍 **Transaction found — waiting for confirmations**
` +
        `Amount: **${txData.ltcAmount.toFixed(6)} LTC**
` +
        `Confirmations: **0/6**

` +
        `The bot will automatically process your order once 6 confirmations are reached. You'll get a DM when it's done.`,
    });
  }

  if (txData.confirmations < 6) {
    storeState.updateOrderField(orderId, 'txHash', txId);
    storeState.updateOrderField(orderId, 'txSubmitted', true);

    // Add hold if not already
    if (!order.holdAdded) {
      storeState.updateOrderField(orderId, 'holdAdded', true);
      storeState.addHold(order.bglAmount);
      await refreshStoreMessage(client).catch(() => {});
    }

    return interaction.editReply({
      content:
        `✅ **Transaction verified — waiting for 6 confirmations**
` +
        `Amount: **${txData.ltcAmount.toFixed(6)} LTC**
` +
        `Confirmations: **${txData.confirmations}/6**

` +
        `You'll receive a DM once your BGLs are sent.`,
    });
  }

  // 6+ confirmations — process immediately
  await interaction.editReply({
    content: `✅ **Transaction confirmed (${txData.confirmations} confirmations)!**
Processing your order now...`,
  });

  // Add hold if not already
  if (!order.holdAdded) {
    storeState.updateOrderField(orderId, 'holdAdded', true);
    storeState.addHold(order.bglAmount);
  }

  storeState.markTxSeen(txId, '_6conf');
  await processConfirmedPayment({ txHash: txId, ltcAmount: txData.ltcAmount, confirmations: txData.confirmations, pending: false }, client);
}

// Process LTC payment — called by ltcMonitor for every confirmation update
async function processConfirmedPayment(txData, client) {
  const { txHash, ltcAmount, confirmations, pending } = txData;

  const match = ltcMonitor.matchOrderByLtcAmount(ltcAmount);
  if (!match) {
    // Only log unmatched once per tx (not at both 1conf and 6conf)
    if (!storeState.isTxSeen(txHash, '_unmatched_logged')) {
      storeState.markTxSeen(txHash, '_unmatched_logged');
      console.warn(`[OrderProcessor] No order match for ${ltcAmount} LTC (tx: ${txHash})`);
      await logToAdmin(client, { type: 'UNMATCHED_PAYMENT', txHash, ltcAmount });
    }
    return;
  }

  const { orderId, order, overpaid = 0, underpaid = 0 } = match;

  // ── Handle underpayment — notify user, don't process ─────────────────────
  if (underpaid > 0.00005 && confirmations >= 6) {
    if (!storeState.isTxSeen(txHash, '_underpay_notified')) {
      storeState.markTxSeen(txHash, '_underpay_notified');
      const ltcRates = await ltcMonitor.getLtcUsdRate().catch(() => ({ usd: 80, eur: 74 }));
      const shortUsd = (underpaid * ltcRates.usd).toFixed(2);
      try {
        const user = await client.users.fetch(order.userId);
        await user.send({
          content:
            `⚠️ **Underpayment Detected** — Order \`${orderId}\`
` +
            `You sent **${ltcAmount} LTC** but the order required **${order.ltcAmount} LTC**.
` +
            `Shortfall: \`${underpaid.toFixed(6)} LTC\` (~$${shortUsd})

` +
            `Please send the remaining **\`${underpaid.toFixed(6)}\` LTC** to \`${order.walletAddress}\` to complete your order.
` +
            `-# Order ID: \`${orderId}\``,
        });
      } catch (_) {}
      await logToAdmin(client, { type: 'UNDERPAYMENT', orderId, sent: ltcAmount, required: order.ltcAmount, shortfall: underpaid });
    }
    return; // Don't process tip until full payment received
  }

  // ── Handle overpayment — process tip, notify about extra ─────────────────
  if (overpaid > 0.00005 && confirmations >= 6) {
    const ltcRates = await ltcMonitor.getLtcUsdRate().catch(() => ({ usd: 80, eur: 74 }));
    const extraUsd = (overpaid * ltcRates.usd).toFixed(2);
    console.log(`[OrderProcessor] Overpayment: +${overpaid.toFixed(6)} LTC (~$${extraUsd}) — processing normally`);
    // Will notify user after tip completes
  }

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

    // Take screenshot — tipUser already saved one at /tmp/gamblit_5_result_*.png
    // Find the most recent result screenshot
    let screenshotPath = null;
    try {
      const files = fs.readdirSync('/tmp').filter(f => f.startsWith('gamblit_5_result_')).sort().reverse();
      if (files.length > 0) screenshotPath = `/tmp/${files[0]}`;
      if (!screenshotPath) {
        // Take a fresh screenshot of the current page state
        screenshotPath = `/tmp/tip_result_${orderId}_${Date.now()}.png`;
        await gamblit._getPageForScreenshot(process.env.GAMBLIT_URL || 'https://gamblit.net')
          .then(p => p.screenshot({ path: screenshotPath }))
          .catch(() => { screenshotPath = null; });
      }
    } catch (ssErr) {
      console.warn('[OrderProcessor] Screenshot failed:', ssErr.message);
      screenshotPath = null;
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

      if (screenshotPath && fs.existsSync(screenshotPath)) {
        dmPayload.files = [new AttachmentBuilder(fs.readFileSync(screenshotPath), { name: 'tip_confirmation.png' })];
        console.log('[OrderProcessor] Attaching screenshot:', screenshotPath);
      } else {
        console.warn('[OrderProcessor] No screenshot found to attach');
      }

      // Add overpayment notice if applicable
      if (overpaid > 0.00005) {
        const ltcRates = await ltcMonitor.getLtcUsdRate().catch(() => ({ usd: 80, eur: 74 }));
        const extraUsd = (overpaid * ltcRates.usd).toFixed(2);
        dmPayload.content = (dmPayload.content || '') +
          `

💰 **Note:** You overpaid by \`${overpaid.toFixed(6)}\` LTC (~$${extraUsd}). The extra amount stays in our wallet — no refunds for overpayments.`;
      }
      await user.send(dmPayload);
      console.log('[OrderProcessor] DM sent to user');
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
  handleSubmitTxButton,
  handleTxModalSubmit,
  processConfirmedPayment,
};
