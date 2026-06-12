// utils/components.js
// Discord Components V2 builders for AutoStore UI

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SeparatorSpacingSize,
} = require('discord.js');

const storeState = require('./storeState');
const { getLtcUsdRate } = require('./ltcMonitor');

// Helper — Components V2 messages need the flag as a number
const CV2_FLAG = MessageFlags.IsComponentsV2;

// ─── MAIN STORE EMBED ─────────────────────────────────────────────────────────
async function buildStoreMessage() {
  const state = storeState.get();
  const available = storeState.getAvailableStock();
  const rates = await getLtcUsdRate().catch(() => ({ usd: '?', eur: '?' }));

  const statusEmoji = available > 0 ? '🟢' : '🔴';
  const statusText  = available > 0 ? 'OPEN' : 'OUT OF STOCK';
  const usdStr = typeof rates.usd === 'number' ? rates.usd.toFixed(2) : rates.usd;
  const eurStr = typeof rates.eur === 'number' ? rates.eur.toFixed(2) : rates.eur;

  const holdLine = state.onHoldBgls > 0
    ? `\n⏳ **On Hold:** ${state.onHoldBgls.toLocaleString()} BGLs`
    : '';

  const container = new ContainerBuilder()
    .setAccentColor(0x00c853)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🛒 Automatic BGL Store\nPurchase **BGLs** quickly and securely.`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Instructions:**\n` +
        `1. Press 🛒 **Buy** below\n` +
        `2. Enter your Gamblit username + BGL or fiat amount\n` +
        `3. Send the exact LTC amount shown to our wallet\n` +
        `4. BGLs arrive in your Gamblit account automatically`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${statusEmoji} **Status:** ${statusText}\n` +
        `💵 **Rate:** €${state.bglPriceEur.toFixed(2)} / $${state.bglPriceUsd.toFixed(2)} per BGL\n` +
        `📦 **Available Stock:** ${available % 1 === 0 ? available.toLocaleString() : available.toFixed(2)} BGLs` +
        holdLine
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 💎 LTC Rate: $${usdStr} / €${eurStr} — updates every 5 min`
      )
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('store_buy')
      .setLabel('Buy')
      .setEmoji('🛒')
      .setStyle(ButtonStyle.Success)
      .setDisabled(available <= 0),
    new ButtonBuilder()
      .setCustomId('store_stock')
      .setLabel('Stock Info')
      .setEmoji('📦')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    components: [container, row],
    flags: CV2_FLAG,
  };
}

// ─── ORDER CONFIRMATION ───────────────────────────────────────────────────────
function buildOrderConfirmation({ orderId, bglAmount, ltcAmount, walletAddress, currency, fiatAmount, expiresAt }) {
  const currSymbol = currency === 'usd' ? '$' : '€';

  const container = new ContainerBuilder()
    .setAccentColor(0xf9a825)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ⏳ Order Created — Awaiting Payment\n-# Order ID: \`${orderId}\``
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🎮 **BGLs to receive:** ${bglAmount.toLocaleString()}\n` +
        `💰 **Fiat total:** ${currSymbol}${parseFloat(fiatAmount).toFixed(2)}\n` +
        `💎 **LTC to send:** \`${ltcAmount}\` LTC`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Send EXACTLY this amount to:**\n\`\`\`\n${walletAddress}\n\`\`\`` +
        `\n⚠️ Send the **exact** LTC amount. Do not round up or down.\n` +
        `-# Order expires <t:${Math.floor(expiresAt / 1000)}:R>`
      )
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`order_submittx_${orderId}`)
      .setLabel('I Sent Payment — Submit TX ID')
      .setEmoji('📨')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`order_cancel_${orderId}`)
      .setLabel('Cancel Order')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );

  return {
    components: [container, row],
    flags: CV2_FLAG,
    ephemeral: true,
  };
}

// ─── ORDER COMPLETED ──────────────────────────────────────────────────────────
function buildOrderCompleted({ orderId, bglAmount, gamblitUsername, txHash }) {
  const container = new ContainerBuilder()
    .setAccentColor(0x00c853)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ✅ Order Completed!\nYour BGLs have been sent to your Gamblit account.`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🎮 **Gamblit Username:** ${gamblitUsername}\n` +
        `📦 **BGLs Sent:** ${bglAmount.toLocaleString()}\n` +
        `-# TX: \`${txHash.slice(0, 20)}...\`\n` +
        `-# Order ID: \`${orderId}\``
      )
    );

  return {
    components: [container],
    flags: CV2_FLAG,
    ephemeral: true,
  };
}

// ─── ORDER FAILED ─────────────────────────────────────────────────────────────
function buildOrderFailed({ reason, orderId }) {
  const container = new ContainerBuilder()
    .setAccentColor(0xd32f2f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ❌ Order Failed\n${reason || 'An unexpected error occurred.'}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `Please contact support if you believe this is an error.` +
        (orderId ? `\n-# Order ID: \`${orderId}\`` : '')
      )
    );

  return {
    components: [container],
    flags: CV2_FLAG,
    ephemeral: true,
  };
}

// ─── PAYMENT DETECTED (unconfirmed) ───────────────────────────────────────────
function buildPaymentDetected({ orderId, ltcAmount, bglAmount, gamblitUsername, confirmations }) {
  const container = new ContainerBuilder()
    .setAccentColor(0xfbc02d)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🔍 Payment Detected — Confirming...\n` +
        `LTC transaction found! Waiting for 1 confirmation before sending BGLs.`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `💎 **LTC Received:** ${ltcAmount} LTC\n` +
        `🎮 **Gamblit User:** ${gamblitUsername}\n` +
        `📦 **BGLs Pending:** ${bglAmount}\n` +
        `-# Confirmations: ${confirmations}/1`
      )
    );

  return {
    components: [container],
    flags: CV2_FLAG,
    ephemeral: true,
  };
}

// ─── STOCK INFO ────────────────────────────────────────────────────────────────
async function buildStockInfo() {
  const state = storeState.get();
  const available = storeState.getAvailableStock();
  const pendingOrders = Object.entries(state.pendingOrders);

  let orderLines = '';
  if (pendingOrders.length > 0) {
    orderLines = '\n\n**Active Orders:**\n' +
      pendingOrders.slice(0, 8).map(([id, o]) =>
        `\`${id}\` — ${o.bglAmount} BGLs — ${o.gamblitUsername}`
      ).join('\n');
    if (pendingOrders.length > 8) orderLines += `\n_...and ${pendingOrders.length - 8} more_`;
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x1565c0)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📦 Stock Information`)
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `📦 **Total Stock:** ${state.stockBgls.toLocaleString()} BGLs\n` +
        `⏳ **On Hold:** ${state.onHoldBgls.toLocaleString()} BGLs\n` +
        `✅ **Available:** ${available.toLocaleString()} BGLs\n` +
        `💵 **Price:** €${state.bglPriceEur.toFixed(2)} / $${state.bglPriceUsd.toFixed(2)} per BGL` +
        orderLines
      )
    );

  return {
    components: [container],
    flags: CV2_FLAG,
    ephemeral: true,
  };
}

module.exports = {
  buildStoreMessage,
  buildOrderConfirmation,
  buildOrderCompleted,
  buildOrderFailed,
  buildPaymentDetected,
  buildStockInfo,
};
