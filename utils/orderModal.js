// utils/orderModal.js
// Modal builder for the buy flow

const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

function buildBuyModal() {
  const modal = new ModalBuilder()
    .setCustomId('modal_buy_order')
    .setTitle('🛒 Place a BGL Order');

  const usernameInput = new TextInputBuilder()
    .setCustomId('gamblit_username')
    .setLabel('Gamblit Username (Grow ID)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Your Gamblit username')
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(50);

  // Just ask how much LTC they plan to send
  const ltcAmountInput = new TextInputBuilder()
    .setCustomId('ltc_amount')
    .setLabel('How much LTC are you sending?')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 0.05 (you will receive equivalent BGLs)')
    .setRequired(true)
    .setMaxLength(20);

  modal.addComponents(
    new ActionRowBuilder().addComponents(usernameInput),
    new ActionRowBuilder().addComponents(ltcAmountInput),
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

function buildTxModal(orderId) {
  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

  const modal = new ModalBuilder()
    .setCustomId(`modal_tx_${orderId}`)
    .setTitle('📨 Submit Transaction ID');

  const txInput = new TextInputBuilder()
    .setCustomId('tx_id')
    .setLabel('Litecoin Transaction ID (TX Hash)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. a1b2c3d4e5f6...')
    .setRequired(true)
    .setMinLength(60)
    .setMaxLength(70);

  modal.addComponents(new ActionRowBuilder().addComponents(txInput));
  return modal;
}

module.exports = { buildBuyModal, buildTxModal, parseFiatInput };
