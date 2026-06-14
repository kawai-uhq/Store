// utils/components.js — Components V2 UI builders (unique-amount model)

const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SectionBuilder,
  ThumbnailBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  MessageFlags, SeparatorSpacingSize,
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
  const holdLine = state.onHoldBgls > 0 ? `\n⏳ **On Hold:** ${state.onHoldBgls.toLocaleString()} BGLs` : '';

  const container = new ContainerBuilder()
    .setAccentColor(0x00c853)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🛒 Automatic BGL Store\nBuy **BGLs** with Litecoin — instant, automatic delivery.`))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**How it works:**\n` +
      `1. Press 🛒 **Buy**\n` +
      `2. Enter your Gamblit username + amount in **USD**\n` +
      `3. You'll get a **payment address + QR** with the exact LTC amount\n` +
      `4. Pay it — BGLs arrive automatically after confirmation`
    ))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `${statusEmoji} **Status:** ${statusText}\n` +
      `💵 **Rate:** €${state.bglPriceEur.toFixed(2)} / $${state.bglPriceUsd.toFixed(2)} per BGL\n` +
      `📦 **Available Stock:** ${available % 1 === 0 ? available.toLocaleString() : available.toFixed(2)} BGLs` + holdLine
    ))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 💎 LTC: $${usdStr} — updates every 15 min`));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('store_buy').setLabel('Buy').setEmoji('🛒').setStyle(ButtonStyle.Success).setDisabled(available <= 0),
    new ButtonBuilder().setCustomId('store_stock').setLabel('Stock Info').setEmoji('📦').setStyle(ButtonStyle.Secondary)
  );
  return { components: [container, row], flags: CV2_FLAG };
}

// ─── ORDER CONFIRMATION (address + copy + QR) ─────────────────────────────────
// Caller must attach the QR as files:[{ attachment: buffer, name: 'qr.png' }]
function buildOrderConfirmation({ orderId, bglAmount, usdAmount, ltcAmount, address, expiresAt, confirmations }) {
  const container = new ContainerBuilder()
    .setAccentColor(0xf9a825)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ⏳ Order Created — Send Your Payment\n-# Order ID: \`${orderId}\``))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `🎮 **BGLs:** ${bglAmount}\n` +
      `💵 **USD:** $${usdAmount}\n` +
      `💎 **Send EXACTLY:** \`${ltcAmount}\` LTC`
    ))
    .addSeparatorComponents(sep())
    // Address on the left, QR on the right (Section + Thumbnail accessory)
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `**Pay to this address:**\n\`\`\`\n${address}\n\`\`\`` +
          `\n⚠️ Send the **exact** amount (scan the QR to auto-fill). Sending **less** can't be auto-completed (manual refund); sending **more** is accepted but the extra isn't refunded.`
        ))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL('attachment://qr.png').setDescription('Payment QR'))
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `⚙️ Delivers automatically after **${confirmations} confirmations**. You'll get a DM at each step.\n` +
      `✅ Already paid? Tap **I've Paid** and paste your TX ID for an instant check.\n` +
      `-# Order expires <t:${Math.floor(expiresAt / 1000)}:R>`
    ));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`order_copy_${orderId}`).setLabel('Copy Address & Amount').setEmoji('📋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`order_txid_${orderId}`).setLabel("I've Paid").setEmoji('🔎').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`order_cancel_${orderId}`).setLabel('Cancel').setEmoji('❌').setStyle(ButtonStyle.Danger)
  );
  return { components: [container, row], flags: CV2_FLAG };
}

// ─── COPY (plain text for one-tap copy) ───────────────────────────────────────
function buildCopyReply({ address, ltcAmount }) {
  return {
    content: `**Address:**\n\`\`\`\n${address}\n\`\`\`\n**Exact amount (LTC):**\n\`\`\`\n${ltcAmount}\n\`\`\``,
    flags: MessageFlags.Ephemeral,
  };
}

// ─── PAYMENT DETECTED ─────────────────────────────────────────────────────────
function buildPaymentDetected({ orderId, ltcAmount, gamblitUsername, confirmations, target }) {
  const container = new ContainerBuilder()
    .setAccentColor(0xfbc02d)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🔍 Payment Detected — Confirming...\nFound your payment. BGLs send automatically once confirmed.`))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `💎 **Received:** ${ltcAmount} LTC\n🎮 **Gamblit User:** ${gamblitUsername}\n` +
      `-# Confirmations: ${confirmations}/${target ?? 6}\n-# Order ID: \`${orderId}\``
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
      `🎮 **Gamblit:** ${gamblitUsername}\n📦 **BGLs Sent:** ${bglAmount.toLocaleString()}\n` +
      (txHash ? `-# TX: \`${txHash.slice(0, 24)}...\`\n` : '') + `-# Order ID: \`${orderId}\``
    ));
  return { components: [container], flags: CV2_FLAG };
}

// ─── ORDER FAILED ─────────────────────────────────────────────────────────────
function buildOrderFailed({ reason, orderId }) {
  const container = new ContainerBuilder()
    .setAccentColor(0xd32f2f)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ❌ Order Failed\n${reason || 'An unexpected error occurred.'}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`Contact support if you believe this is an error.` + (orderId ? `\n-# Order ID: \`${orderId}\`` : '')));
  return { components: [container], flags: CV2_FLAG };
}

// ─── STOCK INFO ───────────────────────────────────────────────────────────────
async function buildStockInfo() {
  const state = storeState.get();
  const available = storeState.getAvailableStock();
  const pending = Object.entries(state.pendingOrders);
  let orderLines = '';
  if (pending.length > 0) {
    orderLines = '\n\n**Active Orders:**\n' + pending.slice(0, 8).map(([id, o]) => `\`${id}\` — ${o.bglAmount} BGLs — ${o.status}`).join('\n');
    if (pending.length > 8) orderLines += `\n_...and ${pending.length - 8} more_`;
  }
  const container = new ContainerBuilder()
    .setAccentColor(0x1565c0)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📦 Stock Information`))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `📦 **Total Stock:** ${state.stockBgls.toLocaleString()} BGLs\n⏳ **On Hold:** ${state.onHoldBgls.toLocaleString()} BGLs\n` +
      `✅ **Available:** ${available.toLocaleString()} BGLs\n💵 **Price:** €${state.bglPriceEur.toFixed(2)} / $${state.bglPriceUsd.toFixed(2)} per BGL` + orderLines
    ));
  return { components: [container], flags: CV2_FLAG };
}

module.exports = {
  buildStoreMessage, buildOrderConfirmation, buildCopyReply,
  buildOrderCompleted, buildOrderFailed, buildPaymentDetected, buildStockInfo,
};
