// index.js — AutoStore Bot — Main Entry Point (unique-amount model)

require('dotenv').config();

const { Client, GatewayIntentBits, Events } = require('discord.js');
const cron = require('node-cron');
const { refreshStoreMessage, handleAdminCommand, ADMIN_COMMANDS } = require('./commands/admin');
const {
  handleBuyButton, handleStockButton, handleBuyModalSubmit,
  handleCopyAddress, handleTxIdButton, handleTxModalSubmit, handleCancelOrder,
  startOrderPoller, stopOrderPoller, cleanupExpiredOrders,
} = require('./utils/orderProcessor');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`\n✅ AutoStore Bot ready as ${c.user.tag}`);

  const required = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    CLIENT_ID: process.env.CLIENT_ID,
    STORE_CHANNEL_ID: process.env.STORE_CHANNEL_ID,
    LTC_WALLET_ADDRESS: process.env.LTC_WALLET_ADDRESS,
    BLOCKCYPHER_TOKEN: process.env.BLOCKCYPHER_TOKEN,
    GAMBLIT_TOKEN: process.env.GAMBLIT_TOKEN,
  };
  for (const [key, val] of Object.entries(required)) {
    console.log(`   ${val ? '✅' : '❌'} ${key}: ${val ? String(val).slice(0, 12) + '...' : 'NOT SET'}`);
  }

  try { await require('./utils/gamblit').verifyToken(); }
  catch (e) { console.error('[Startup] Gamblit token check failed:', e.message); }

  if (process.env.STORE_CHANNEL_ID) {
    try {
      const ch = await client.channels.fetch(process.env.STORE_CHANNEL_ID);
      if (ch) { await refreshStoreMessage(client); console.log(`✅ Store embed posted in #${ch.name}`); }
    } catch (e) { console.error(`❌ Failed to post store embed: ${e.message}`); }
  } else {
    console.error('❌ STORE_CHANNEL_ID not set');
  }

  if (process.env.LTC_WALLET_ADDRESS && process.env.BLOCKCYPHER_TOKEN) startOrderPoller(client);
  else console.warn('⚠️  LTC_WALLET_ADDRESS or BLOCKCYPHER_TOKEN missing — payment polling disabled');

  cron.schedule('*/15 * * * *', () => { cleanupExpiredOrders(client).catch(() => {}); });
  cron.schedule('*/5 * * * *', () => { refreshStoreMessage(client).catch((e) => console.error('[Cron] Embed refresh:', e.message)); });

  const gamblit = require('./utils/gamblit');
  const storeState = require('./utils/storeState');
  async function syncBalance() {
    try {
      const bal = await gamblit.getBalanceBgl();
      if (bal && bal.bgl !== null) {
        storeState.setStock(bal.bgl);
        console.log(`[BalanceSync] Stock = ${bal.bgl} BGLs (${bal.dl} DL)`);
        await refreshStoreMessage(client).catch(() => {});
      }
    } catch (e) { console.error('[BalanceSync] Failed:', e.message); }
  }
  setTimeout(syncBalance, 15000);
  cron.schedule('*/10 * * * *', syncBalance);

  console.log('\n🚀 All systems operational\n');
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (ADMIN_COMMANDS.map((c) => c.name).includes(interaction.commandName)) await handleAdminCommand(interaction, client);
      return;
    }
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'store_buy') return handleBuyButton(interaction);
      if (id === 'store_stock') return handleStockButton(interaction);
      if (id.startsWith('order_copy_')) return handleCopyAddress(interaction, id.replace('order_copy_', ''));
      if (id.startsWith('order_txid_')) return handleTxIdButton(interaction, id.replace('order_txid_', ''));
      if (id.startsWith('order_cancel_')) return handleCancelOrder(interaction, id.replace('order_cancel_', ''), client);
      return;
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_buy_order') await handleBuyModalSubmit(interaction, client);
      else if (interaction.customId.startsWith('modal_txid_')) await handleTxModalSubmit(interaction, client);
      return;
    }
  } catch (e) {
    console.error('[Bot] Interaction error:', e);
    try {
      const method = interaction.replied || interaction.deferred ? 'followUp' : 'reply';
      await interaction[method]({ content: '❌ An unexpected error occurred.', flags: 64 });
    } catch (_) {}
  }
});

client.on(Events.Error, (e) => console.error('[Discord Error]', e));
process.on('unhandledRejection', (e) => console.error('[Unhandled Rejection]', e));
process.on('uncaughtException', (e) => console.error('[Uncaught Exception]', e));
process.on('SIGINT', () => { console.log('\n[Shutdown] Closing...'); stopOrderPoller(); client.destroy(); process.exit(0); });

client.login(process.env.DISCORD_TOKEN);
