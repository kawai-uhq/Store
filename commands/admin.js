// commands/admin.js — Admin slash commands for the AutoStore

const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const storeState = require('../utils/storeState');
const { buildStoreMessage } = require('../utils/components');

const ADMIN_COMMANDS = [
  new SlashCommandBuilder().setName('sendembed').setDescription('Send the store embed to a channel (or current channel)')
    .addChannelOption((o) => o.setName('channel').setDescription('Target channel').addChannelTypes(ChannelType.GuildText).setRequired(false)),
  new SlashCommandBuilder().setName('setprice').setDescription('Set the BGL price')
    .addNumberOption((o) => o.setName('eur').setDescription('Price in EUR per BGL').setRequired(true).setMinValue(0.01))
    .addNumberOption((o) => o.setName('usd').setDescription('Price in USD per BGL').setRequired(true).setMinValue(0.01)),
  new SlashCommandBuilder().setName('setstock').setDescription('Set the available BGL stock')
    .addIntegerOption((o) => o.setName('amount').setDescription('Number of BGLs').setRequired(true).setMinValue(0)),
  new SlashCommandBuilder().setName('addstock').setDescription('Add BGLs to current stock')
    .addIntegerOption((o) => o.setName('amount').setDescription('BGLs to add').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('orders').setDescription('View pending orders'),
  new SlashCommandBuilder().setName('cancelorder').setDescription('Manually cancel a pending order')
    .addStringOption((o) => o.setName('orderid').setDescription('Order ID').setRequired(true)),
  new SlashCommandBuilder().setName('refreshstore').setDescription('Re-edit the store embed in place'),
  new SlashCommandBuilder().setName('storestats').setDescription('View store statistics'),
  new SlashCommandBuilder().setName('shop').setDescription('Open or close the shop')
    .addStringOption((o) => o.setName('state').setDescription('open or closed').setRequired(true)
      .addChoices({ name: 'open', value: 'open' }, { name: 'closed', value: 'closed' })),
  new SlashCommandBuilder().setName('screenshot').setDescription('Screenshot what Puppeteer sees on Gamblit')
    .addStringOption((o) => o.setName('url').setDescription('URL (default gamblit.net)').setRequired(false)),
  new SlashCommandBuilder().setName('balance').setDescription('Fetch Gamblit balance and sync stock'),
  new SlashCommandBuilder().setName('testtip').setDescription('Send a test tip in RAW units (no BGL conversion)')
    .addStringOption((o) => o.setName('username').setDescription('Gamblit username to tip').setRequired(true))
    .addNumberOption((o) => o.setName('amount').setDescription('Raw amount to type into the tip field (e.g. WL)').setRequired(true).setMinValue(0.0001)),
];

function isAdmin(interaction) {
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (!adminRoleId) return interaction.member?.permissions?.has('Administrator');
  return interaction.member?.roles?.cache?.has(adminRoleId) || interaction.member?.permissions?.has('Administrator');
}

async function handleAdminCommand(interaction, client) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: '❌ You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
  }
  const cmd = interaction.commandName;

  if (cmd === 'sendembed') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = interaction.options.getChannel('channel') ?? interaction.channel;
    try {
      const msg = await target.send(await buildStoreMessage());
      storeState.setStoreMessageId(msg.id);
      process.env.STORE_CHANNEL_ID = target.id;
      return interaction.editReply({ content: `✅ Store embed sent to <#${target.id}> (message \`${msg.id}\`). \`/refreshstore\` will update it.` });
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to send embed: \`${e.message}\`` });
    }
  }

  if (cmd === 'setprice') {
    const eur = interaction.options.getNumber('eur');
    const usd = interaction.options.getNumber('usd');
    storeState.setPrice(eur, usd);
    await refreshStoreMessage(client);
    return interaction.reply({ content: `✅ Price: **€${eur.toFixed(2)}** / **$${usd.toFixed(2)}** per BGL`, flags: MessageFlags.Ephemeral });
  }

  if (cmd === 'setstock') {
    const amount = interaction.options.getInteger('amount');
    storeState.setStock(amount);
    await refreshStoreMessage(client);
    return interaction.reply({ content: `✅ Stock set to **${amount.toLocaleString()} BGLs**`, flags: MessageFlags.Ephemeral });
  }

  if (cmd === 'addstock') {
    const amount = interaction.options.getInteger('amount');
    const current = storeState.get().stockBgls;
    storeState.setStock(current + amount);
    await refreshStoreMessage(client);
    return interaction.reply({ content: `✅ Added **${amount.toLocaleString()} BGLs**. Total: **${(current + amount).toLocaleString()}**`, flags: MessageFlags.Ephemeral });
  }

  if (cmd === 'orders') {
    const pending = Object.entries(storeState.get().pendingOrders);
    if (pending.length === 0) return interaction.reply({ content: '📭 No pending orders.', flags: MessageFlags.Ephemeral });
    const lines = pending.map(([id, o]) => {
      const age = Math.floor((Date.now() - o.createdAt) / 60000);
      return `\`${id}\` | ~${o.estBgl} BGLs | ${o.gamblitUsername} | ${o.status} | ${age}m ago`;
    });
    return interaction.reply({ content: `**Pending Orders (${pending.length}):**\n\`\`\`\n${lines.join('\n')}\n\`\`\``, flags: MessageFlags.Ephemeral });
  }

  if (cmd === 'cancelorder') {
    const orderId = interaction.options.getString('orderid');
    const order = storeState.getOrder(orderId);
    if (!order) return interaction.reply({ content: `❌ Order \`${orderId}\` not found.`, flags: MessageFlags.Ephemeral });
    storeState.cancelOrder(orderId);
    await refreshStoreMessage(client);
    return interaction.reply({ content: `✅ Order \`${orderId}\` cancelled. Released **${order.heldAmount || 0} BGLs** from hold.`, flags: MessageFlags.Ephemeral });
  }

  if (cmd === 'refreshstore') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await refreshStoreMessage(client);
    return interaction.editReply({ content: '✅ Store embed refreshed.' });
  }

  if (cmd === 'screenshot') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const url = interaction.options.getString('url') || process.env.GAMBLIT_URL || 'https://gamblit.net';
    try {
      const gamblit = require('../utils/gamblit');
      const page = await gamblit._getPageForScreenshot(url);
      const p = `/tmp/screenshot_${Date.now()}.png`;
      await page.screenshot({ path: p, fullPage: false });
      const fs = require('fs');
      const { AttachmentBuilder } = require('discord.js');
      return interaction.editReply({ content: `📸 \`${url}\``, files: [new AttachmentBuilder(fs.readFileSync(p), { name: 'screenshot.png' })] });
    } catch (e) {
      return interaction.editReply({ content: `❌ Screenshot failed: ${e.message}` });
    }
  }

  if (cmd === 'balance') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const gamblit = require('../utils/gamblit');
      const bal = await gamblit.getBalanceBgl();
      if (!bal) return interaction.editReply({ content: '❌ Could not fetch balance — check logs' });
      storeState.setStock(bal.bgl);
      await refreshStoreMessage(client);
      return interaction.editReply({ content: `💰 **Gamblit Balance**\nWL: **${bal.wl?.toLocaleString() ?? 'N/A'}**\nDL: **${bal.dl?.toFixed(2) ?? 'N/A'}**\nBGL: **${bal.bgl}**\n✅ Stock synced` });
    } catch (e) {
      return interaction.editReply({ content: `❌ Balance fetch failed: ${e.message}` });
    }
  }

  if (cmd === 'testtip') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const username = interaction.options.getString('username').trim();
    const amount = interaction.options.getNumber('amount');
    try {
      const gamblit = require('../utils/gamblit');
      const res = await gamblit.tipRaw(username, amount);
      const fs = require('fs');
      const { AttachmentBuilder } = require('discord.js');
      const files = res?.screenshot && fs.existsSync(res.screenshot)
        ? [new AttachmentBuilder(fs.readFileSync(res.screenshot), { name: 'tip_result.png' })]
        : [];
      return interaction.editReply({ content: `🧪✅ Sent test tip of **${amount}** (raw) → **${username}**. Check the screenshot + your balance to confirm the unit.`, files });
    } catch (e) {
      return interaction.editReply({ content: `🧪❌ Test tip failed: ${e.message}` });
    }
  }

  if (cmd === 'shop') {
    const st = interaction.options.getString('state');
    storeState.setShopOpen(st === 'open');
    await refreshStoreMessage(client);
    return interaction.reply({
      content: st === 'open' ? '🟢 Shop is now **OPEN** — buyers can purchase.' : '🔴 Shop is now **CLOSED** — the Buy button is disabled and purchases are blocked.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (cmd === 'storestats') {
    const state = storeState.get();
    return interaction.reply({
      content:
        `📊 **Store Statistics**\n` +
        `Shop: ${storeState.isShopOpen() ? '🟢 OPEN' : '🔴 CLOSED'}\n` +
        `Stock: ${state.stockBgls.toLocaleString()} BGLs\n` +
        `On Hold: ${state.onHoldBgls.toLocaleString()} BGLs\n` +
        `Available: ${storeState.getAvailableStock().toLocaleString()} BGLs\n` +
        `Price: €${state.bglPriceEur.toFixed(2)} / $${state.bglPriceUsd.toFixed(2)} per BGL\n` +
        `Pending: ${Object.keys(state.pendingOrders).length}\n` +
        `Completed: ${Object.keys(state.orders).length}\n` +
        `Daily Tip Used: ${state.dailyTipUsed} BGLs`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function refreshStoreMessage(client) {
  const channelId = process.env.STORE_CHANNEL_ID;
  if (!channelId) return;
  let channel;
  try { channel = await client.channels.fetch(channelId); }
  catch (e) { console.error(`[Store] Cannot fetch channel ${channelId}: ${e.message}`); return; }
  if (!channel) return;

  const payload = await buildStoreMessage();
  const state = storeState.get();
  const messageId = state.storeMessageId || process.env.STORE_MESSAGE_ID;

  if (messageId) {
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(payload);
      if (!state.storeMessageId) storeState.setStoreMessageId(messageId);
      return;
    } catch (e) {
      console.warn(`[Store] Tracked message gone (${e.message}) — sending new`);
      storeState.setStoreMessageId(null);
    }
  }
  try {
    const msg = await channel.send(payload);
    storeState.setStoreMessageId(msg.id);
    console.log(`[Store] ✅ Embed posted — message ID: ${msg.id} (add STORE_MESSAGE_ID=${msg.id} to Railway)`);
  } catch (e) {
    console.error(`[Store] Failed to send embed: ${e.message}`);
  }
}

module.exports = { ADMIN_COMMANDS, handleAdminCommand, refreshStoreMessage, isAdmin };
