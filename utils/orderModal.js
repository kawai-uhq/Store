// utils/orderModal.js — Buy modal (username + USD) and TX-ID submission modal.

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

  const usdInput = new TextInputBuilder()
    .setCustomId('usd_amount')
    .setLabel('Amount in USD you will send')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 5')
    .setRequired(true)
    .setMaxLength(12);

  modal.addComponents(
    new ActionRowBuilder().addComponents(usernameInput),
    new ActionRowBuilder().addComponents(usdInput)
  );
  return modal;
}

function buildTxModal(orderId) {
  const modal = new ModalBuilder().setCustomId(`modal_txid_${orderId}`).setTitle('🔎 Check Your Payment');

  const txInput = new TextInputBuilder()
    .setCustomId('tx_hash')
    .setLabel('Litecoin Transaction ID (hash)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('The 64-character TX hash from your wallet')
    .setRequired(true)
    .setMinLength(60)
    .setMaxLength(80);

  modal.addComponents(new ActionRowBuilder().addComponents(txInput));
  return modal;
}

module.exports = { buildBuyModal, buildTxModal };
