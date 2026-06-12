// commands/admin.js
// Admin slash commands for the AutoStore

const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const storeState = require('../utils/storeState');
const { buildStoreMessage } = require('../utils/components');

const ADMIN_COMMANDS = [
  new SlashCommandBuilder()
    .setName('sendembed')
    .setDescription('Send the store embed to a channel (or current channel if none specified)')
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Channel to send the store embed to (defaults to current channel)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('setprice')
    .setDescription('Set the BGL price')
    .addNumberOption(o => o.setName('eur').setDescription('Price in EUR per BGL').setRequired(true).setMinValue(0.01))
    .addNumberOption(o => o.setName('usd').setDescription('Price in USD per BGL').setRequired(true).setMinValue(0.01)),

  new SlashCommandBuilder()
    .setName('setstock')
    .setDescription('Set the available BGL stock')
    .addIntegerOption(o => o.setName('amount').setDescription('Number of BGLs in stock').setRequired(true).setMinValue(0)),

  new SlashCommandBuilder()
    .setName('addstock')
    .setDescription('Add BGLs to the current stock')
    .addIntegerOption(o => o.setName('amount').setDescription('Number of BGLs to add').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('orders')
    .setDescription('View pending orders'),

  new SlashCommandBuilder()
    .setName('cancelorder')
    .setDescription('Manually cancel a pending order')
    .addStringOption(o => o.setName('orderid').setDescription('Order ID to cancel').setRequired(true)),

  new SlashCommandBuilder()
    .setName('refreshstore')
    .setDescription('Re-edit the existing store embed in place'),

  new SlashCommandBuilder()
    .setName('storestats')
    .setDescription('View store statistics'),
];

function isAdmin(interaction) {
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (!adminRoleId) return interaction.member?.permissions?.has('Administrator');
  return interaction.member?.roles?.cache?.has(adminRoleId) || interaction.member?.permissions?.has('Administrator');
}

async function handleAdminCommand(interaction, client) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      content: '❌ You do not have permission to use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const cmd = interaction.commandName;

  // ── /sendembed ────────────────────────────────────────────────────────────
  if (cmd === 'sendembed') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Use the specified channel, or fall back to the current channel
    const target = interaction.options.getChannel('channel') ?? interaction.channel;

    try {
      const payload = await buildStoreMessage();
      const msg = await target.send(payload);

      // Update the tracked message ID so refreshstore edits this one going forward
      storeState.setStoreMessageId(msg.id);

      // Also update STORE_CHANNEL_ID in memory so auto-refresh hits the right channel
      process.env.STORE_CHANNEL_ID = target.id;

      return interaction.editReply({
        content: `✅ Store embed sent to <#${target.id}> (message ID: \`${msg.id}\`)\nThis is now the tracked embed — \`/refreshstore\` will update it.`,
      });
    } catch (e) {
      return interaction.editReply({
        content: `❌ Failed to send embed to <#${target.id}>: \`${e.message}\`\nMake sure I have **Send Messages** and **View Channel** permissions there.`,
      });
    }
  }

  // ── /setprice ─────────────────────────────────────────────────────────────
  if (cmd === 'setprice') {
    const eur = interaction.options.getNumber('eur');
    const usd = interaction.options.getNumber('usd');
    storeState.setPrice(eur, usd);
    await refreshStoreMessage(client);
    return interaction.reply({
      content: `✅ Price updated: **€${eur.toFixed(2)}** / **$${usd.toFixed(2)}** per BGL`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /setstock ─────────────────────────────────────────────────────────────
  if (cmd === 'setstock') {
    const amount = interaction.options.getInteger('amount');
    storeState.setStock(amount);
    await refreshStoreMessage(client);
    return interaction.reply({
      content: `✅ Stock set to **${amount.toLocaleString()} BGLs**`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /addstock ─────────────────────────────────────────────────────────────
  if (cmd === 'addstock') {
    const amount = interaction.options.getInteger('amount');
    const current = storeState.get().stockBgls;
    storeState.setStock(current + amount);
    await refreshStoreMessage(client);
    return interaction.reply({
      content: `✅ Added **${amount.toLocaleString()} BGLs**. New total: **${(current + amount).toLocaleString()} BGLs**`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /orders ───────────────────────────────────────────────────────────────
  if (cmd === 'orders') {
    const state = storeState.get();
    const pending = Object.entries(state.pendingOrders);
    if (pending.length === 0) {
      return interaction.reply({ content: '📭 No pending orders.', flags: MessageFlags.Ephemeral });
    }
    const lines = pending.map(([id, o]) => {
      const age = Math.floor((Date.now() - o.createdAt) / 60000);
      return `\`${id}\` | ${o.bglAmount} BGLs | ${o.gamblitUsername} | ${o.ltcAmount} LTC | ${age}m ago`;
    });
    return interaction.reply({
      content: `**Pending Orders (${pending.length}):**\n\`\`\`\n${lines.join('\n')}\n\`\`\``,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /cancelorder ──────────────────────────────────────────────────────────
  if (cmd === 'cancelorder') {
    const orderId = interaction.options.getString('orderid');
    const order = storeState.getOrder(orderId);
    if (!order) {
      return interaction.reply({ content: `❌ Order \`${orderId}\` not found.`, flags: MessageFlags.Ephemeral });
    }
    storeState.cancelOrder(orderId);
    await refreshStoreMessage(client);
    return interaction.reply({
      content: `✅ Order \`${orderId}\` cancelled. Released **${order.bglAmount} BGLs** from hold.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /refreshstore ─────────────────────────────────────────────────────────
  if (cmd === 'refreshstore') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await refreshStoreMessage(client);
    return interaction.editReply({ content: '✅ Store embed refreshed.' });
  }

  // ── /storestats ───────────────────────────────────────────────────────────
  if (cmd === 'storestats') {
    const state = storeState.get();
    const completed = Object.keys(state.orders).length;
    const pending = Object.keys(state.pendingOrders).length;
    const trackedMsgId = state.storeMessageId ?? 'none';
    const trackedChannel = process.env.STORE_CHANNEL_ID ?? 'not set';
    return interaction.reply({
      content:
        `📊 **Store Statistics**\n` +
        `Stock: ${state.stockBgls.toLocaleString()} BGLs total\n` +
        `On Hold: ${state.onHoldBgls.toLocaleString()} BGLs\n` +
        `Available: ${storeState.getAvailableStock().toLocaleString()} BGLs\n` +
        `Price: €${state.bglPriceEur.toFixed(2)} / $${state.bglPriceUsd.toFixed(2)} per BGL\n` +
        `Pending Orders: ${pending}\n` +
        `Completed Orders: ${completed}\n` +
        `Daily Tip Used: ${state.dailyTipUsed}/500 BGLs\n` +
        `Tracked Embed: \`${trackedMsgId}\` in <#${trackedChannel}>`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ─── Re-edit the tracked store message ────────────────────────────────────────
async function refreshStoreMessage(client) {
  const channelId = process.env.STORE_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Store] STORE_CHANNEL_ID not set — use /sendembed to post the embed first');
    return;
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (e) {
    console.error(`[Store] Cannot fetch channel ${channelId}: ${e.message}`);
    return;
  }
  if (!channel) {
    console.error(`[Store] Channel ${channelId} not found`);
    return;
  }

  const payload = await buildStoreMessage();
  const state = storeState.get();

  if (state.storeMessageId) {
    try {
      const msg = await channel.messages.fetch(state.storeMessageId);
      await msg.edit(payload);
      return; // success — embed updated silently
    } catch (e) {
      console.warn(`[Store] Tracked message gone (${e.message}) — use /sendembed to repost`);
      storeState.setStoreMessageId(null);
    }
  } else {
    // No tracked message yet — send a new one automatically
    try {
      const msg = await channel.send(payload);
      storeState.setStoreMessageId(msg.id);
      console.log(`[Store] Embed auto-posted — message ID: ${msg.id}`);
    } catch (e) {
      console.error(`[Store] Failed to send embed: ${e.message}`);
      console.error('  -> Use /sendembed in Discord to post it manually');
    }
  }
}

module.exports = {
  ADMIN_COMMANDS,
  handleAdminCommand,
  refreshStoreMessage,
  isAdmin,
};
