const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const db = require('../db/knex');
const { processAgentMessage } = require('./agentService');

let client = null;

/**
 * Initialize Discord Bot Client
 */
function initDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log('[Discord Bot] DISCORD_BOT_TOKEN not configured. Discord Bot service skipped.');
    return null;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once('ready', () => {
    console.log(`🤖 [Discord Bot] Logged in as ${client.user.tag}! Ready to handle Horai timesheets.`);
  });

  client.on('messageCreate', async (message) => {
    try {
      // Ignore bot messages
      if (message.author.bot) return;

      const isDM = !message.guild;
      const isMentioned = client.user && message.mentions.has(client.user.id);

      // Respond only to DMs or direct mentions in servers
      if (!isDM && !isMentioned) return;

      // Clean prompt text (strip <@botId>)
      let rawText = message.content || '';
      if (client.user) {
        rawText = rawText.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
      }

      if (!rawText) {
        return message.reply('👋 Hi there! How can I assist you with your Horai timesheets and events today?');
      }

      const discordUserId = message.author.id;
      const discordUsername = message.author.tag || message.author.username;
      const textUpper = rawText.toUpperCase();

      // 1. Check for Pairing Command: "PAIR 123456" or "123456"
      const pairMatch = rawText.match(/^(?:PAIR\s+)?(\d{6})$/i);
      if (pairMatch) {
        const code = pairMatch[1];
        const now = new Date();

        const user = await db('users')
          .where({ discord_pairing_code: code })
          .where('discord_pairing_expires_at', '>', now)
          .first();

        if (!user) {
          return message.reply(
            '❌ **Invalid or expired 6-digit pairing code.**\n\nPlease log into the Horai web app, click **"Link Discord"** to generate a new PIN, and send it here.'
          );
        }

        // Unlink this Discord ID if previously attached to another user
        await db('users').where({ discord_user_id: discordUserId }).update({ discord_user_id: null, discord_username: null });

        // Link this user
        await db('users')
          .where({ id: user.id })
          .update({
            discord_user_id: discordUserId,
            discord_username: discordUsername,
            discord_pairing_code: null,
            discord_pairing_expires_at: null,
          });

        const welcomeEmbed = new EmbedBuilder()
          .setColor(0x6366f1)
          .setTitle('✅ Successfully Connected!')
          .setDescription(`Welcome **${user.name}**! Your Discord account is now linked to your Horai account.`)
          .addFields(
            { name: '📅 Manage Events', value: '`Create event Gala on Friday for $30/hr`\n`List my events`' },
            { name: '⏱️ Live Timers & Hours', value: '`Start timer for Gala`\n`Log 4.5 hours on Gala for John`' },
            { name: '💰 Expenses & Payroll', value: '`Submit expense $50 for Gala: Flowers`\n`Payroll summary for Gala`' }
          )
          .setFooter({ text: 'Horai AI Timesheet Assistant' });

        return message.reply({ embeds: [welcomeEmbed] });
      }

      // 2. Check for Unpair Command: "UNPAIR"
      if (textUpper === 'UNPAIR') {
        const user = await db('users').where({ discord_user_id: discordUserId }).first();
        if (!user) {
          return message.reply('Your Discord account is not linked to any Horai account.');
        }

        await db('users').where({ id: user.id }).update({ discord_user_id: null, discord_username: null });
        return message.reply('✅ Your Discord account has been unlinked from Horai.');
      }

      // 3. Check for Help Command: "HELP"
      if (textUpper === 'HELP') {
        const helpEmbed = new EmbedBuilder()
          .setColor(0x3b82f6)
          .setTitle('🤖 Horai Timesheet Assistant — Commands')
          .setDescription('You can chat with me in natural language to manage your events and payroll.')
          .addFields(
            { name: '📅 Events', value: '• `List my events`\n• `Create catering event tomorrow at $25/hr`\n• `Show details for Gala`' },
            { name: '⏱️ Sessions & Hours', value: '• `Start session for Gala`\n• `Stop session for Gala`\n• `Log 3.5 hours on Gala for Sarah`' },
            { name: '💵 Expenses & Payroll', value: '• `Submit material expense $45 for Gala for supplies`\n• `Show payroll summary for Gala`\n• `Add $10 tip to Sarah for Gala`' },
            { name: '🔗 Account', value: '• `PAIR <6-digit-code>` — Link account\n• `UNPAIR` — Unlink account' }
          )
          .setFooter({ text: 'Horai AI Assistant' });

        return message.reply({ embeds: [helpEmbed] });
      }

      // 4. Look up Paired User
      const user = await db('users').where({ discord_user_id: discordUserId }).first();
      if (!user) {
        const notLinkedEmbed = new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle('👋 Welcome to Horai Assistant!')
          .setDescription('Your Discord account is not yet linked to your Horai account.')
          .addFields(
            { name: '1. Get Your Pairing PIN', value: 'Open the [Horai Web App](http://localhost:5173), and click **"Link Discord"** in the top navigation.' },
            { name: '2. Link Account', value: 'Reply to this bot with:\n👉 `PAIR <6-digit-code>`' }
          )
          .setFooter({ text: 'Horai AI Assistant' });

        return message.reply({ embeds: [notLinkedEmbed] });
      }

      // 5. Execute Agent Flow with Paired User Context
      // Send typing indicator while processing LLM
      await message.channel.sendTyping();

      const result = await processAgentMessage({
        user,
        message: rawText,
        history: [],
      });

      // Split long replies if over 2000 chars (Discord message limit)
      const reply = result.reply || 'Done!';
      if (reply.length <= 2000) {
        await message.reply(reply);
      } else {
        const chunks = reply.match(/[\s\S]{1,1900}/g) || [reply];
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      }
    } catch (err) {
      console.error('[Discord Bot Error]:', err);
      message.reply(`⚠️ Sorry, I encountered an error: ${err.message}`).catch(() => {});
    }
  });

  client.login(token).catch((err) => {
    console.error('❌ [Discord Bot] Failed to login to Discord:', err.message);
  });

  return client;
}

module.exports = {
  initDiscordBot,
  getDiscordClient: () => client,
};
