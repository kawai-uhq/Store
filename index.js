// index.js
// AutoStore Bot — Main Entry Point

require('dotenv').config();

const { Client, GatewayIntentBits, Events } = require('discord.js');
const cron = require('node-cron');
const storeState = require('./utils/storeState');
const ltcMonitor = require('./utils/ltcMonitor');
const { refreshStoreMessage, handleAdminCommand, ADMIN_COMMANDS } = require('./commands/admin');
const {
  handleBuyButton,
  handleStockButton,
  handleBuyModalSubmit,
  handleCancelOrder,
  processConfirmedPayment,
} = require('./utils/orderProcessor');

// ─── CLIENT SETUP ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
});

// ─── READY ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  console.log(`\n✅ AutoStore Bot ready as ${c.user.tag}`);

  // ── Validate required env vars ──────────────────────────────────────────
  const required = {
    DISCORD_TOKEN:      process.env.DISCORD_TOKEN,
    CLIENT_ID:          process.env.CLIENT_ID,
    STORE_CHANNEL_ID:   process.env.STORE_CHANNEL_ID,
    LTC_WALLET_ADDRESS: process.env.LTC_WALLET_ADDRESS,
    GAMBLIT_TOKEN:      process.env.GAMBLIT_TOKEN,
  };
  for (const [key, val] of Object.entries(required)) {
    console.log(`   ${val ? '✅' : '❌'} ${key}: ${val ? val.slice(0, 12) + '...' : 'NOT SET'}`);
  }
  console.log(`   📦 STORE_CHANNEL_ID: ${process.env.STORE_CHANNEL_ID}`);
  console.log(`   📋 LOG_CHANNEL_ID:   ${process.env.LOG_CHANNEL_ID || '(not set)'}`);
  console.log(`   💎 LTC_WALLET:       ${process.env.LTC_WALLET_ADDRESS}`);

  // ── Verify Gamblit token ────────────────────────────────────────────────
  try {
    const gamblit = require('./utils/gamblit');
    await gamblit.verifyToken();
  } catch (e) {
    console.error('[Startup] Gamblit token check failed:', e.message);
  }

  // ── Post store embed ────────────────────────────────────────────────────
  const storeChannelId = process.env.STORE_CHANNEL_ID;
  if (!storeChannelId) {
    console.error('❌ STORE_CHANNEL_ID is not set — store embed will NOT be posted');
  } else {
    try {
      const ch = await client.channels.fetch(storeChannelId);
      if (!ch) {
        console.error(`❌ Could not find channel ${storeChannelId} — is the bot in the server with access?`);
      } else {
        console.log(`✅ Found store channel: #${ch.name}`);
        await refreshStoreMessage(client);
        console.log('✅ Store embed posted/updated');
      }
    } catch (e) {
      console.error(`❌ Failed to post store embed: ${e.message}`);
      console.error('   → Check STORE_CHANNEL_ID is correct and bot has Send Messages permission');
    }
  }

  // ── Start LTC monitor ───────────────────────────────────────────────────
  const walletAddress = process.env.LTC_WALLET_ADDRESS;
  if (!walletAddress) {
    console.warn('⚠️  LTC_WALLET_ADDRESS not set — payment monitoring disabled');
  } else {
    ltcMonitor.startMonitor(walletAddress, async (txData) => {
      if (txData.pending) {
        console.log(`[LTCMonitor] 🔍 Unconfirmed tx: ${txData.ltcAmount} LTC — waiting for confirmation`);
      } else {
        console.log(`[LTCMonitor] ✅ Confirmed tx: ${txData.ltcAmount} LTC (${txData.confirmations} confirmations)`);
      }
      await processConfirmedPayment(txData, client);
    });
    console.log('✅ LTC monitor started (polling every 30s, ignoring pre-startup txs)');
  }

  // ── Cron jobs ───────────────────────────────────────────────────────────
  // Clean stale orders every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    const cleaned = storeState.cleanStaleOrders();
    if (cleaned > 0) {
      console.log(`[Cron] Cleaned ${cleaned} stale order(s)`);
      refreshStoreMessage(client).catch(() => {});
    }
  });

  // Refresh store embed every 5 minutes (live LTC rate)
  cron.schedule('*/5 * * * *', () => {
    refreshStoreMessage(client).catch(e => {
      console.error('[Cron] Embed refresh failed:', e.message);
    });
  });

  console.log('\n🚀 All systems operational\n');
});

// ─── INTERACTION HANDLER ──────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ── Slash commands ──────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const adminCmdNames = ADMIN_COMMANDS.map(c => c.name);
      if (adminCmdNames.includes(interaction.commandName)) {
        await handleAdminCommand(interaction, client);
      }
      return;
    }

    // ── Button interactions ─────────────────────────────────────────────────
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === 'store_buy') {
        await handleBuyButton(interaction);
        return;
      }
      if (id === 'store_stock') {
        await handleStockButton(interaction);
        return;
      }
      if (id.startsWith('order_cancel_')) {
        await handleCancelOrder(interaction, id.replace('order_cancel_', ''), client);
        return;
      }
      if (id.startsWith('order_status_')) {
        const orderId = id.replace('order_status_', '');
        const order = storeState.getOrder(orderId);
        await interaction.reply({
          content: order
            ? `⏳ Order \`${orderId}\` is still pending.\nSend **${order.ltcAmount} LTC** to \`${order.walletAddress}\``
            : `❌ Order \`${orderId}\` not found or already completed.`,
          flags: 64,
        });
        return;
      }
      return;
    }

    // ── Modal submissions ───────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_buy_order') {
        await handleBuyModalSubmit(interaction, client);
      }
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

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────
client.on(Events.Error, (e) => console.error('[Discord Error]', e));
process.on('unhandledRejection', (e) => console.error('[Unhandled Rejection]', e));
process.on('uncaughtException', (e) => console.error('[Uncaught Exception]', e));

process.on('SIGINT', async () => {
  console.log('\n[Shutdown] Closing gracefully...');
  ltcMonitor.stopMonitor();
  client.destroy();
  process.exit(0);
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
