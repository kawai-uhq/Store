// utils/orderProcessor.js
// Handles the full order lifecycle: modal → hold → payment → tip

const { MessageFlags } = require('discord.js');
const crypto = require('crypto');
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

  // Validate: at least one of bgl or fiat must be provided
  if (!bglRaw && !fiatRaw) {
    return interaction.editReply({
      ...buildOrderFailed({ reason: 'Please enter either a BGL amount or a fiat amount.' }),
    });
  }

  let bglAmount, ltcAmount, fiatAmount, currency;

  try {
    if (bglRaw) {
      bglAmount = parseInt(bglRaw);
      if (isNaN(bglAmount) || bglAmount < 1) {
        return interaction.editReply({
          ...buildOrderFailed({ reason: 'Invalid BGL amount. Please enter a whole number (e.g. 100).' }),
        });
      }
      const state = storeState.get();
      // Default to EUR pricing
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

    if (bglAmount < 1) {
      return interaction.editReply({
        ...buildOrderFailed({ reason: 'The fiat amount is too low (results in 0 BGLs).' }),
      });
    }

    // Check stock availability
    const available = storeState.getAvailableStock();
    if (bglAmount > available) {
      return interaction.editReply({
        ...buildOrderFailed({
          reason: `Not enough stock! You requested **${bglAmount} BGLs** but only **${available} BGLs** are available. Please try a smaller amount.`,
        }),
      });
    }

    // Check tip limit
    const tipCheck = storeState.checkTipLimit(bglAmount);
    if (!tipCheck.canTip) {
      const resetsIn = Math.ceil((tipCheck.resetsAt - Date.now()) / 3600000);
      return interaction.editReply({
        ...buildOrderFailed({
          reason: `Daily tip limit reached (500 BGLs/24h). Remaining: **${tipCheck.remaining} BGLs**. Resets in ~${resetsIn}h. Please try a smaller amount or come back later.`,
        }),
      });
    }

    // Create order
    const orderId = generateOrderId();
    const walletAddress = process.env.LTC_WALLET_ADDRESS;
    const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour

    storeState.addOrder(orderId, {
      orderId,
      bglAmount,
      ltcAmount: parseFloat(ltcAmount),
      fiatAmount,
      currency,
      gamblitUsername,
      walletAddress,
      userId: interaction.user.id,
      username: interaction.user.username,
      expiresAt,
    });

    // Put BGLs on hold
    storeState.addHold(bglAmount);

    // Refresh store to show updated hold
    await refreshStoreMessage(client).catch(() => {});

    // Send confirmation
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

    // Log to admin channel
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
    return interaction.reply({
      content: '❌ Order not found or already completed.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (order.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ This is not your order.',
      flags: MessageFlags.Ephemeral,
    });
  }

  storeState.cancelOrder(orderId);
  await refreshStoreMessage(client).catch(() => {});

  return interaction.reply({
    content: `✅ Order \`${orderId}\` cancelled successfully.`,
    flags: MessageFlags.Ephemeral,
  });
}

// Process confirmed LTC payment
async function processConfirmedPayment(txData, client) {
  const { txHash, ltcAmount, pending } = txData;

  // Find matching order
  const match = ltcMonitor.matchOrderByLtcAmount(ltcAmount);

  if (!match) {
    console.warn(`[OrderProcessor] No order match for LTC amount ${ltcAmount} (tx: ${txHash})`);
    await logToAdmin(client, {
      type: 'UNMATCHED_PAYMENT',
      txHash,
      ltcAmount,
    });
    return;
  }

  const { orderId, order } = match;

  if (pending) {
    // Payment detected but not confirmed — notify user
    try {
      const user = await client.users.fetch(order.userId);
      await user.send(buildPaymentDetected({
        orderId,
        ltcAmount,
        bglAmount: order.bglAmount,
        gamblitUsername: order.gamblitUsername,
        confirmations: txData.confirmations,
      }));
    } catch (e) {
      console.warn('[OrderProcessor] Could not DM user about pending payment');
    }
    return;
  }

  // Confirmed — process the order
  console.log(`[OrderProcessor] Processing order ${orderId}: ${order.bglAmount} BGLs → ${order.gamblitUsername}`);

  // Mark order as completed (removes from pending)
  storeState.completeOrder(orderId, txHash);

  try {
    // Check gamblit daily tip limit
    const tipCheck = storeState.checkTipLimit(order.bglAmount);
    if (!tipCheck.canTip) {
      throw new Error(`Daily tip limit exceeded (${tipCheck.remaining} remaining)`);
    }

    // Tip the user on gamblit
    // Split into batches of 500 if needed (shouldn't happen due to validation, but safety)
    let remaining = order.bglAmount;
    while (remaining > 0) {
      const batch = Math.min(remaining, 500);
      await gamblit.tipUser(order.gamblitUsername, batch);
      storeState.addTipUsed(batch);
      remaining -= batch;
      if (remaining > 0) {
        // Wait before next batch
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Deduct from stock
    storeState.deductStock(order.bglAmount);

    // Notify user
    try {
      const user = await client.users.fetch(order.userId);
      await user.send(buildOrderCompleted({
        orderId,
        bglAmount: order.bglAmount,
        gamblitUsername: order.gamblitUsername,
        txHash,
      }));
    } catch (e) {
      console.warn('[OrderProcessor] Could not DM user about completed order');
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

    console.log(`[OrderProcessor] ✅ Order ${orderId} completed — ${order.bglAmount} BGLs sent to ${order.gamblitUsername}`);

  } catch (e) {
    console.error('[OrderProcessor] Failed to tip user:', e.message);

    // Release the hold back (don't deduct stock since tip failed)
    storeState.removeHold(order.bglAmount);

    // Notify user of failure
    try {
      const user = await client.users.fetch(order.userId);
      await user.send(buildOrderFailed({
        orderId,
        reason: `Payment received but tip failed: ${e.message}. Please contact support with your order ID.`,
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

    const emojis = {
      ORDER_CREATED: '📋',
      ORDER_COMPLETED: '✅',
      TIP_FAILED: '❌',
      UNMATCHED_PAYMENT: '⚠️',
    };

    const emoji = emojis[data.type] || '📌';
    let content = `${emoji} **${data.type}**\n`;

    for (const [k, v] of Object.entries(data)) {
      if (k !== 'type') content += `\`${k}\`: ${v}\n`;
    }

    content += `-# <t:${Math.floor(Date.now() / 1000)}:F>`;

    await channel.send({ content });
  } catch (e) {
    console.error('[OrderProcessor] Failed to log to admin channel:', e.message);
  }
}

module.exports = {
  handleBuyButton,
  handleStockButton,
  handleBuyModalSubmit,
  handleCancelOrder,
  processConfirmedPayment,
};

