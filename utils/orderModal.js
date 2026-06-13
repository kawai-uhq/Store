// utils/orderModal.js
// Buy modal for the forwarding-address flow. (TX-ID modal removed — payments are
// now detected automatically on each order's unique address.)

const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

function buildBuyModal() {
  const modal = new ModalBuilder().setCustomId('modal_buy_order').setTitle('🛒 Place a BGL Order');

  const usernameInput = new TextInputBuilder()
    .setCustomId('gamblit_username')
    .setLabel('Gamblit Username (Grow ID)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Your Gamblit username')
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(50);

  const ltcAmountInput = new TextInputBuilder()
    .setCustomId('ltc_amount')
    .setLabel('Estimated LTC you will send')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 0.05 — used only for the quote, send any amount')
    .setRequired(true)
    .setMaxLength(20);

  modal.addComponents(
    new ActionRowBuilder().addComponents(usernameInput),
    new ActionRowBuilder().addComponents(ltcAmountInput)
  );
  return modal;
}

module.exports = { buildBuyModal };
