// deploy-commands.js
// Registers slash commands with Discord

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { ADMIN_COMMANDS } = require('./commands/admin');

const commands = ADMIN_COMMANDS.map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Deploying ${commands.length} slash commands...`);

    const guildId = process.env.GUILD_ID;
    if (guildId) {
      // Guild-specific (instant)
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
        { body: commands }
      );
      console.log(`✅ Deployed to guild ${guildId}`);
    } else {
      // Global (up to 1 hour to propagate)
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log('✅ Deployed globally');
    }
  } catch (e) {
    console.error('Failed to deploy commands:', e);
  }
})();
