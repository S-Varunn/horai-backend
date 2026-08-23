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
let reconnectTimer = null;
const sentBotMessageIds = new Set();

/**
 * Extract clean digits only from a JID or phone number (e.g. 15551234567:12@s.whatsapp.net -> 15551234567).
 */
function cleanDigits(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
}

/**
 * Normalize incoming phone / JID to standard E.164 format (+1234567890).
 */
function normalizePhone(jid) {
  const digits = cleanDigits(jid);
  return digits ? `+${digits}` : '';
}

/**
 * Helper to find user by phone number (matching with or without leading '+').
 */
async function findUserByPhone(phone) {
  const digits = cleanDigits(phone);
  if (!digits) return null;
  return db('users')
    .where('whatsapp_phone', digits)
    .orWhere('whatsapp_phone', `+${digits}`)
    .first();
}

/**
 * Initialize and start the Baileys WhatsApp Socket Bot.
 */
async function initWhatsAppBot() {
  try {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

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
            } catch (e) {
              console.error('[WhatsApp Bot] Auto-link owner error:', e.message);
            }
          })();
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        botStatus = 'disconnected';
        connectedPhone = null;

        if (statusCode !== 408 || process.env.NODE_ENV !== 'production') {
          console.log(`⚠️ [WhatsApp Bot] Connection closed (code: ${statusCode || 'unknown'}). Reconnecting: ${shouldReconnect}`);
        }

        if (shouldReconnect) {
          reconnectTimer = setTimeout(() => initWhatsAppBot(), 3000);
        } else {
          if (process.env.NODE_ENV !== 'production') {
            console.log('🔄 [WhatsApp Bot] Session reset. Cleaning auth directory and preparing fresh connection...');
          }
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
          reconnectTimer = setTimeout(() => initWhatsAppBot(), 2000);
        }
      }
    });

    async function sendBotReply(jid, content) {
      try {
        if (!sock) return;
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
        const myCleanDigits = cleanDigits(myJid);
        const senderJid = msg.key.remoteJid;
        const cleanSenderDigits = cleanDigits(senderJid);
        const cleanSenderFormatted = cleanSenderDigits ? `+${cleanSenderDigits}` : '';

        const isSelfChat = cleanSenderDigits === myCleanDigits || senderJid.split('@')[0].split(':')[0] === myJid.split('@')[0].split(':')[0];

        // If fromMe is true, only allow if it is a Note to Self / Message Yourself chat
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

        console.log(`📩 [WhatsApp Inbound] from ${cleanSenderFormatted || senderJid} (${isSelfChat ? 'Self-Chat' : 'Direct'}): "${rawText}"`);

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
          await db('users')
            .where('whatsapp_phone', cleanSenderDigits)
            .orWhere('whatsapp_phone', cleanSenderFormatted)
            .update({ whatsapp_phone: null });

          // Link phone to user
          await db('users')
            .where({ id: user.id })
            .update({
              whatsapp_phone: cleanSenderFormatted,
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
          const user = await findUserByPhone(cleanSenderDigits);
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
            text: `🤖 *Horai Assistant Commands*\n\nTo talk to me, ask questions or give instructions, for example:\n• "Whats the rate for Arangettram?"\n• "How much do I owe everyone?"\n• "Who are the members of Arangettram?"\n• "Log 4 hours on Arangettram for Sarah"\n• "Start session for Arangettram"\n\n• *Unlink Account:* "UNPAIR"`,
          });
          continue;
        }

        // 4. Verify User is Paired & check for Pending Confirmation
        let user = await findUserByPhone(cleanSenderDigits);

        // If user is in self-chat and not yet linked, automatically associate with organization head
        if (!user && isSelfChat) {
          const org = await db('organizations').orderBy('created_at', 'asc').first();
          if (org?.owner_id) {
            user = await db('users').where({ id: org.owner_id }).first();
            if (user) {
              await db('users').where({ id: user.id }).update({ whatsapp_phone: cleanSenderFormatted });
              console.log(`[WhatsApp Bot] Auto-linked self-chat user (${user.email}) to ${cleanSenderFormatted}`);
            }
          }
        }

        const pendingAction = user ? getPendingAction(user.id) : null;
        const isConfirmResponse = pendingAction && /^(yes|no|confirm|cancel|y|n|proceed|apply)$/i.test(rawText.trim());

        // 5. Check for "Horai" Prefix / Trigger (e.g. "Horai, ...", "@Horai ...", "!...", "/...")
        const horaiPrefixMatch = rawText.match(/^(?:(?:@|!)?horai[\s,:]+|[!/])\s*(.*)$/i);
        const mentionsHorai = /\bhorai\b/i.test(rawText);

        // In self-chat or direct chats, allow direct questions
        if (!isSelfChat && !horaiPrefixMatch && !mentionsHorai && !isConfirmResponse) {
          // If in a group or external chat without prefix, ignore
          if (senderJid.endsWith('@g.us')) continue;
        }

        // 6. If user is not yet paired, invite them to link with their 6-digit code
        if (!user) {
          await sendBotReply(senderJid, {
            text: `👋 Welcome to *Horai Assistant*!\n\nYour number (*${cleanSenderFormatted}*) is not yet linked to a Horai account.\n\n*How to link:*\n1. Open your Horai web app.\n2. Click the WhatsApp icon in the header.\n3. Reply here with:\n👉 *PAIR <6-digit-code>*`,
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
          console.log(`🤖 [WhatsApp Agent Processing] prompt: "${cleanPrompt}" for user: ${user.name}`);
          const result = await processAgentMessage({
            user,
            message: cleanPrompt,
            history: [],
          });

          await sendBotReply(senderJid, {
            text: result.reply,
          });
          console.log(`💬 [WhatsApp Agent Replied]: "${result.reply.substring(0, 80)}..."`);
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
  const digitsOnly = cleanDigits(phone);
  if (!digitsOnly || digitsOnly.length < 8) {
    throw new Error('Please enter a valid phone number with country code (e.g. +1234567890).');
  }

  if (botStatus === 'connected' && sock?.authState?.creds?.registered) {
    throw new Error(`WhatsApp Bot is already registered and connected as ${connectedPhone || 'active session'}.`);
  }

  // Clear existing socket before requesting pairing code to avoid conflicting WS instances
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.ws?.close();
      sock.end();
    } catch (e) {}
    sock = null;
  }

  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (e) {}

  await initWhatsAppBot();

  // Wait for the socket to be initialized and in QR / connecting state
  let attempts = 0;
  while (attempts < 35) {
    if (sock?.requestPairingCode && (botStatus === 'qr_ready' || sock?.ws?.readyState === 1 || sock?.ws?.isOpen)) {
      try {
        const rawCode = await sock.requestPairingCode(digitsOnly);
        const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
        console.log(`🔑 [WhatsApp Bot] Pairing code generated for ${digitsOnly}: ${formatted}`);
        return {
          phone: `+${digitsOnly}`,
          code: formatted,
          raw_code: rawCode,
        };
      } catch (innerErr) {
        // Socket may still be handshaking, wait a moment and retry loop
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    attempts++;
  }

  if (!sock) {
    throw new Error('WhatsApp service could not be initialized. Please verify internet connectivity.');
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
    console.error('❌ [WhatsApp Bot] Pairing code generation error:', err);
    throw new Error(err.message || 'Failed to request pairing code. Please try again.');
  }
}

module.exports = {
  initWhatsAppBot,
  getWhatsAppStatus,
  requestGatewayPairingCode,
};
