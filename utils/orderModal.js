// utils/orderModal.js
// Modal builder for the buy flow

const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

function buildBuyModal() {
  const modal = new ModalBuilder()
    .setCustomId('modal_buy_order')
    .setTitle('🛒 Place a BGL Order');

  // Gamblit username
  const usernameInput = new TextInputBuilder()
    .setCustomId('gamblit_username')
    .setLabel('Gamblit Username (Grow ID)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Your Gamblit username')
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(50);

  // BGL amount OR fiat amount — user fills one
  const bglAmountInput = new TextInputBuilder()
    .setCustomId('bgl_amount')
    .setLabel('BGL Amount (leave blank if paying in fiat)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 100')
    .setRequired(false)
    .setMaxLength(10);

  const fiatAmountInput = new TextInputBuilder()
    .setCustomId('fiat_amount')
    .setLabel('Fiat Amount in USD or EUR (e.g. 10 USD)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 10 USD  or  8 EUR')
    .setRequired(false)
    .setMaxLength(20);

  modal.addComponents(
    new ActionRowBuilder().addComponents(usernameInput),
    new ActionRowBuilder().addComponents(bglAmountInput),
    new ActionRowBuilder().addComponents(fiatAmountInput),
  );

  return modal;
}

// Parse fiat input like "10 USD", "8.5 EUR", "10usd"
function parseFiatInput(raw) {
  if (!raw) return null;
  const clean = raw.trim().toUpperCase();
  const match = clean.match(/^([\d.]+)\s*(USD|EUR)$/);
  if (!match) return null;
  return { amount: parseFloat(match[1]), currency: match[2].toLowerCase() };
}

module.exports = { buildBuyModal, parseFiatInput };

