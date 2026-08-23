/**
 * @file whatsappBotService.js
 * @description Built-in Native WhatsApp Gateway using Baileys.
 * Runs standalone inside Node.js, generates terminal/web QR codes, and processes AI messages.
 */

const path = require('path');
const fs = require('fs');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');

const db = require('../db/knex');
const { processAgentMessage } = require('./agentService');
const { getPendingAction } = require('./agent/confirmation');

const AUTH_DIR = path.join(__dirname, '../../data/whatsapp_auth');

let sock = null;
let currentQR = null;
let currentQRDataUrl = null;
let botStatus = 'disconnected'; // 'disconnected' | 'qr_ready' | 'connected'
let connectedPhone = null;

/**
 * Normalize incoming phone / JID to standard format (e.g. +1234567890 or 1234567890).
 */
function normalizePhone(jid) {
  if (!jid) return '';
  let clean = jid.replace(/@.*$/, '').trim();
  const hasPlus = clean.startsWith('+');
  clean = clean.replace(/\D/g, '');
  return hasPlus ? `+${clean}` : clean;
}

/**
 * Initialize and start the Baileys WhatsApp Socket Bot.
 */
async function initWhatsAppBot() {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Connection Lifecycle Updates ──────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        botStatus = 'qr_ready';
        try {
          currentQRDataUrl = await QRCode.toDataURL(qr);
        } catch (e) {
          currentQRDataUrl = null;
        }

        if (process.env.NODE_ENV !== 'production') {
          console.log('\n📱 ═══════════════════════════════════════════════════════════════');
          console.log('📱  SCAN THIS QR CODE IN WHATSAPP TO CONNECT HORAI ASSISTANT:');
          console.log('📱 ═══════════════════════════════════════════════════════════════\n');
          qrcodeTerminal.generate(qr, { small: true });
          console.log('\n👉 Open WhatsApp on your phone ➔ Settings ➔ Linked Devices ➔ Link a Device\n');
        }
      }

      if (connection === 'open') {
        botStatus = 'connected';
        currentQR = null;
        currentQRDataUrl = null;
        connectedPhone = normalizePhone(sock.user?.id || '');
        console.log(`✅ [WhatsApp Bot] Connected successfully as ${connectedPhone || 'Horai Assistant'}`);

        // Automatically link the connected phone to the organization owner if unlinked
        if (connectedPhone) {
          (async () => {
            try {
              const org = await db('organizations').orderBy('created_at', 'asc').first();
              if (org?.owner_id) {
                const owner = await db('users').where({ id: org.owner_id }).first();
                if (owner && !owner.whatsapp_phone) {
                  await db('users').where({ id: owner.id }).update({
                    whatsapp_phone: connectedPhone,
                    whatsapp_pairing_code: null,
                    whatsapp_pairing_expires_at: null,
                  });
                  console.log(`[WhatsApp Bot] Automatically paired organization owner (${owner.email}) with WhatsApp ${connectedPhone}`);
                }
              }
            } catch (e) {}
          })();
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        botStatus = 'disconnected';
        connectedPhone = null;

        // In production, only log abnormal disconnects (not routine 408 QR refresh timeouts)
        if (statusCode !== 408 || process.env.NODE_ENV !== 'production') {
          console.log(`⚠️ [WhatsApp Bot] Connection closed (code: ${statusCode || 'unknown'}). Reconnecting: ${shouldReconnect}`);
        }

        if (shouldReconnect) {
          setTimeout(() => initWhatsAppBot(), 2000);
        } else {
          if (process.env.NODE_ENV !== 'production') {
            console.log('🔄 [WhatsApp Bot] Session reset. Cleaning auth directory and preparing fresh connection...');
          }
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
          setTimeout(() => initWhatsAppBot(), 1500);
        }
      }
    });

    const sentBotMessageIds = new Set();

    async function sendBotReply(jid, content) {
      try {
        const sent = await sock.sendMessage(jid, content);
        if (sent?.key?.id) {
          sentBotMessageIds.add(sent.key.id);
          if (sentBotMessageIds.size > 1000) {
            const first = sentBotMessageIds.values().next().value;
            sentBotMessageIds.delete(first);
          }
        }
        return sent;
      } catch (e) {
        console.error('[WhatsApp Bot] Send reply error:', e.message);
      }
    }

    // ── Inbound Message Handler ───────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

        // Skip automated messages sent by the bot itself
        if (msg.key.id && sentBotMessageIds.has(msg.key.id)) continue;

        const myJid = sock.user?.id || '';
        const myCleanPhone = normalizePhone(myJid);
        const senderJid = msg.key.remoteJid;
        const cleanSender = normalizePhone(senderJid);

        const isSelfChat = cleanSender === myCleanPhone || senderJid === myJid;

        // If fromMe is true, only allow if it is a Note to Self / Message Yourself chat
        // Do not process fromMe messages in other normal chats (to avoid interfering with personal conversations)
        if (msg.key.fromMe && !isSelfChat) continue;

        // Extract message text from various Baileys message types
        const rawText = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          ''
        ).trim();

        if (!rawText) continue;

        const textUpper = rawText.toUpperCase();

        // 1. Handle Pairing Command: "PAIR 123456" or "123456"
        const pairMatch = rawText.match(/^(?:PAIR\s+)?(\d{6})$/i);
        if (pairMatch) {
          const code = pairMatch[1];
          const now = new Date();

          const user = await db('users')
            .where({ whatsapp_pairing_code: code })
            .where('whatsapp_pairing_expires_at', '>', now)
            .first();

          if (!user) {
            await sendBotReply(senderJid, {
              text: '❌ Invalid or expired 6-digit pairing code.\n\nPlease open the Horai web app, click "Link WhatsApp" to get a fresh code, and send it here.',
            });
            continue;
          }

          // Unlink any existing account using this number
          await db('users').where({ whatsapp_phone: cleanSender }).update({ whatsapp_phone: null });

          // Link phone to user
          await db('users')
            .where({ id: user.id })
            .update({
              whatsapp_phone: cleanSender,
              whatsapp_pairing_code: null,
              whatsapp_pairing_expires_at: null,
            });

          await sendBotReply(senderJid, {
            text: `✅ *Successfully paired!*\n\nWelcome *${user.name}*! Your WhatsApp is now connected to Horai.\n\nYou can now manage events, timesheets, and payroll directly from here, for example:\n• "Whats the rate for Arangettram?"\n• "How much do I owe everyone?"\n• "Who are the members of Arangettram?"\n• "Log 4.5 hours on Arangettram for Sarah"`,
          });
          continue;
        }

        // 2. Handle Unlink Command: "UNPAIR"
        if (textUpper === 'UNPAIR') {
          const user = await db('users').where({ whatsapp_phone: cleanSender }).first();
          if (user) {
            await db('users').where({ id: user.id }).update({ whatsapp_phone: null });
            await sendBotReply(senderJid, { text: '✅ Your WhatsApp account has been unlinked from Horai.' });
          } else {
            await sendBotReply(senderJid, { text: 'Your WhatsApp is not linked to any account.' });
          }
          continue;
        }

        // 3. Handle Help Command: "HELP"
        if (textUpper === 'HELP') {
          await sendBotReply(senderJid, {
            text: `🤖 *Horai Assistant Commands*\n\nTo talk to me, prefix your message with *Horai*, for example:\n• "Horai, whats the rate for Arangettram?"\n• "Horai, how much do I owe everyone?"\n• "Horai, who are the members of Arangettram?"\n• "Horai, log 4 hours on Arangettram for Sarah"\n• "Horai, start session for Arangettram"\n\n• *Unlink Account:* "UNPAIR"`,
          });
          continue;
        }

        // 4. Verify User is Paired & check for Pending Confirmation
        let user = await db('users').where({ whatsapp_phone: cleanSender }).first();

        // If user is in self-chat and not yet linked, automatically associate with organization head
        if (!user && isSelfChat) {
          const org = await db('organizations').orderBy('created_at', 'asc').first();
          if (org?.owner_id) {
            user = await db('users').where({ id: org.owner_id }).first();
            if (user) {
              await db('users').where({ id: user.id }).update({ whatsapp_phone: cleanSender });
            }
          }
        }

        const pendingAction = user ? getPendingAction(user.id) : null;
        const isConfirmResponse = pendingAction && /^(yes|no|confirm|cancel|y|n|proceed|apply)$/i.test(rawText.trim());

        // 5. Check for "Horai" Prefix / Trigger (e.g. "Horai, ...", "@Horai ...", "!...", "/...")
        const horaiPrefixMatch = rawText.match(/^(?:(?:@|!)?horai[\s,:]+|[!/])\s*(.*)$/i);
        const mentionsHorai = /\bhorai\b/i.test(rawText);

        // In self-chat, allow direct questions OR questions mentioning Horai
        // In external chats, require explicit Horai prefix or confirmation
        if (!isSelfChat && !horaiPrefixMatch && !mentionsHorai && !isConfirmResponse) {
          continue;
        }

        // 6. If user is not yet paired, invite them to link with their 6-digit code
        if (!user) {
          await sendBotReply(senderJid, {
            text: `👋 Welcome to *Horai Assistant*!\n\nYour number (*${cleanSender}*) is not yet linked to a Horai account.\n\n*How to link:*\n1. Open your Horai web app.\n2. Click the WhatsApp icon in the header.\n3. Reply here with:\n👉 *PAIR <6-digit-code>*`,
          });
          continue;
        }

        // 7. Clean the prompt before sending to AI Agent
        let cleanPrompt = rawText;
        if (horaiPrefixMatch && horaiPrefixMatch[1]) {
          cleanPrompt = horaiPrefixMatch[1].trim();
        } else if (!isConfirmResponse) {
          cleanPrompt = rawText.replace(/\bhorai\b/gi, '').trim();
        }
        if (!cleanPrompt) cleanPrompt = rawText;

        // 8. Execute Autonomous AI Agent Process
        try {
          const result = await processAgentMessage({
            user,
            message: cleanPrompt,
            history: [],
          });

          await sendBotReply(senderJid, {
            text: result.reply,
          });
        } catch (agentErr) {
          console.error('[WhatsApp Agent Error]:', agentErr);
          await sendBotReply(senderJid, {
            text: `⚠️ Sorry, I encountered an error: ${agentErr.message}`,
          });
        }
      }
    });

    return sock;
  } catch (err) {
    console.error('❌ [WhatsApp Bot] Initialization error:', err);
  }
}

/**
 * Get current WhatsApp Bot connection status and QR code
 */
function getWhatsAppStatus() {
  return {
    status: botStatus,
    connected_phone: connectedPhone,
    qr_raw: currentQR,
    qr_data_url: currentQRDataUrl,
  };
}

/**
 * Request an 8-character pairing code using the owner's phone number.
 * Completely avoids camera QR scanning and connection errors.
 */
async function requestGatewayPairingCode(phone) {
  const digitsOnly = String(phone || '').replace(/\D/g, '');
  if (!digitsOnly || digitsOnly.length < 8) {
    throw new Error('Please enter a valid phone number with country code (e.g. +1234567890).');
  }

  if (sock?.authState?.creds?.registered) {
    throw new Error('WhatsApp Bot is already registered and connected.');
  }

  // Clear any partial QR auth state so clean pairing handshake occurs
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (e) {}

  await initWhatsAppBot();

  // Wait for the socket to reach open WS state
  let attempts = 0;
  while ((!sock?.ws || sock.ws.readyState !== 1) && attempts < 50) {
    await new Promise((r) => setTimeout(r, 200));
    attempts++;
  }

  if (!sock || !sock.ws || sock.ws.readyState !== 1) {
    throw new Error('WhatsApp service could not be initialized.');
  }

  try {
    const rawCode = await sock.requestPairingCode(digitsOnly);
    const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
    console.log(`🔑 [WhatsApp Bot] Pairing code generated for ${digitsOnly}: ${formatted}`);
    return {
      phone: `+${digitsOnly}`,
      code: formatted,
      raw_code: rawCode,
    };
  } catch (err) {
    console.log('🔄 Retrying pairing code request with fresh socket:', err.message);
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch (e) {}
    await initWhatsAppBot();
    let retryAttempts = 0;
    while ((!sock?.ws || sock.ws.readyState !== 1) && retryAttempts < 50) {
      await new Promise((r) => setTimeout(r, 200));
      retryAttempts++;
    }
    const rawCode = await sock.requestPairingCode(digitsOnly);
    const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
    console.log(`🔑 [WhatsApp Bot] Pairing code generated on retry for ${digitsOnly}: ${formatted}`);
    return {
      phone: `+${digitsOnly}`,
      code: formatted,
      raw_code: rawCode,
    };
  }
}

module.exports = {
  initWhatsAppBot,
  getWhatsAppStatus,
  requestGatewayPairingCode,
};
