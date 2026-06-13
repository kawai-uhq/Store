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

const CV2_FLAG = MessageFlags.IsComponentsV2;
const sep = () => new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true);

// ─── MAIN STORE EMBED ─────────────────────────────────────────────────────────
async function buildStoreMessage() {
  const state = storeState.get();
  const available = storeState.getAvailableStock();
  const rates = await getLtcUsdRate().catch(() => ({ usd: '?', eur: '?' }));

  const statusEmoji = available > 0 ? '🟢' : '🔴';
  const statusText = available > 0 ? 'OPEN' : 'OUT OF STOCK';
  const usdStr = typeof rates.usd === 'number' ? rates.usd.toFixed(2) : rates.usd;
  const eurStr = typeof rates.eur === 'number' ? rates.eur.toFixed(2) : rates.eur;
  const holdLine = state.onHoldBgls > 0 ? `\n⏳ **On Hold:** ${state.onHoldBgls.toLocaleString()} BGLs` : '';

  const container = new ContainerBuilder()
    .setAccentColor(0x00c853)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🛒 Automatic BGL Store\nPurchase **BGLs** quickly and securely.`))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**How it works:**\n` +
      `1. Press 🛒 **Buy** below\n` +
      `2. Enter your Gamblit username + how much LTC you'll send\n` +
      `3. You get a **unique payment address** for your order\n` +
      `4. Send LTC to that address — BGLs arrive automatically after confirmation. No TX ID needed!`
    ))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `${statusEmoji} **Status:** ${statusText}\n` +
      `💵 **Rate:** €${state.bglPriceEur.toFixed(2)} / $${state.bglPriceUsd.toFixed(2)} per BGL\n` +
      `📦 **Available Stock:** ${available % 1 === 0 ? available.toLocaleString() : available.toFixed(2)} BGLs` + holdLine
    ))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 💎 LTC Rate: $${usdStr} / €${eurStr} — updates every 5 min`));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('store_buy').setLabel('Buy').setEmoji('🛒').setStyle(ButtonStyle.Success).setDisabled(available <= 0),
    new ButtonBuilder().setCustomId('store_stock').setLabel('Stock Info').setEmoji('📦').setStyle(ButtonStyle.Secondary)
  );

  return { components: [container, row], flags: CV2_FLAG };
}

// ─── ORDER CONFIRMATION (shows the unique deposit address) ────────────────────
function buildOrderConfirmation({ orderId, estBgl, depositAddress, ltcEstimate, fiatUsd, expiresAt, confirmations }) {
  const container = new ContainerBuilder()
    .setAccentColor(0xf9a825)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ⏳ Order Created — Send Your Payment\n-# Order ID: \`${orderId}\``))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `🎮 **Estimated BGLs:** ~${estBgl}\n` +
      `💎 **LTC (your estimate):** \`${ltcEstimate}\` LTC (~$${fiatUsd})\n` +
      `-# Final BGLs are calculated from the exact LTC actually received.`
    ))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**Send LTC to your unique address:**\n\`\`\`\n${depositAddress}\n\`\`\`` +
      `\n✅ This address is just for this order — send **any amount** and you'll receive the BGL equivalent.\n` +
      `⚙️ BGLs are delivered automatically after **${confirmations} confirmations**. You'll get a DM at each step.\n` +
      `-# Order expires <t:${Math.floor(expiresAt / 1000)}:R>`
    ));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`order_cancel_${orderId}`).setLabel('Cancel Order').setEmoji('❌').setStyle(ButtonStyle.Danger)
  );

  return { components: [container, row], flags: CV2_FLAG };
}

// ─── PAYMENT DETECTED ─────────────────────────────────────────────────────────
function buildPaymentDetected({ orderId, ltcAmount, gamblitUsername, confirmations, target }) {
  const container = new ContainerBuilder()
    .setAccentColor(0xfbc02d)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🔍 Payment Detected — Confirming...\nYour LTC payment was found. BGLs send automatically once confirmed.`))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `💎 **LTC Received:** ${ltcAmount} LTC\n` +
      `🎮 **Gamblit User:** ${gamblitUsername}\n` +
      `-# Confirmations: ${confirmations}/${target ?? 6}\n` +
      `-# Order ID: \`${orderId}\``
    ));
  return { components: [container], flags: CV2_FLAG };
}

// ─── ORDER COMPLETED ──────────────────────────────────────────────────────────
function buildOrderCompleted({ orderId, bglAmount, gamblitUsername, txHash }) {
  const container = new ContainerBuilder()
    .setAccentColor(0x00c853)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ✅ Order Completed!\nYour BGLs have been sent to your Gamblit account.`))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `🎮 **Gamblit Username:** ${gamblitUsername}\n` +
      `📦 **BGLs Sent:** ${bglAmount.toLocaleString()}\n` +
      (txHash ? `-# TX: \`${txHash.slice(0, 20)}...\`\n` : '') +
      `-# Order ID: \`${orderId}\``
    ));
  return { components: [container], flags: CV2_FLAG };
}

// ─── ORDER FAILED ─────────────────────────────────────────────────────────────
function buildOrderFailed({ reason, orderId }) {
  const container = new ContainerBuilder()
    .setAccentColor(0xd32f2f)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ❌ Order Failed\n${reason || 'An unexpected error occurred.'}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`Please contact support if you believe this is an error.` + (orderId ? `\n-# Order ID: \`${orderId}\`` : '')));
  return { components: [container], flags: CV2_FLAG };
}

// ─── STOCK INFO ───────────────────────────────────────────────────────────────
async function buildStockInfo() {
  const state = storeState.get();
  const available = storeState.getAvailableStock();
  const pending = Object.entries(state.pendingOrders);

  let orderLines = '';
  if (pending.length > 0) {
    orderLines = '\n\n**Active Orders:**\n' +
      pending.slice(0, 8).map(([id, o]) => `\`${id}\` — ~${o.estBgl} BGLs — ${o.status}`).join('\n');
    if (pending.length > 8) orderLines += `\n_...and ${pending.length - 8} more_`;
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x1565c0)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📦 Stock Information`))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `📦 **Total Stock:** ${state.stockBgls.toLocaleString()} BGLs\n` +
      `⏳ **On Hold:** ${state.onHoldBgls.toLocaleString()} BGLs\n` +
      `✅ **Available:** ${available.toLocaleString()} BGLs\n` +
      `💵 **Price:** €${state.bglPriceEur.toFixed(2)} / $${state.bglPriceUsd.toFixed(2)} per BGL` + orderLines
    ));
  return { components: [container], flags: CV2_FLAG };
}

module.exports = {
  buildStoreMessage,
  buildOrderConfirmation,
  buildOrderCompleted,
  buildOrderFailed,
  buildPaymentDetected,
  buildStockInfo,
};
