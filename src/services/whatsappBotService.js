/**
 * @file whatsappBotService.js
 * @description Complete, ground-up rewrite of the Native WhatsApp Gateway using Baileys.
 * Features:
 * - Direct QR code generation (terminal + Base64 PNG for UI)
 * - 8-character phone pairing code generation (requestPairingCode)
 * - Rock-solid self-chat (Message Yourself) & direct chat AI message execution
 * - Automated owner auto-pairing and 6-digit member code pairing
 * - Robust connection management & reconnection logic
 */

const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
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

// ── Global Gateway State ───────────────────────────────────────────────────────
let sock = null;
let currentQR = null;
let currentQRDataUrl = null;
let botStatus = 'disconnected'; // 'disconnected' | 'qr_ready' | 'connected'
let connectedPhone = null;
let isStarting = false;
let reconnectTimer = null;
const processedMessageIds = new Set();

/**
 * Strip all non-digit characters and device IDs from a WhatsApp JID or phone number.
 * e.g., "15551234567:12@s.whatsapp.net" -> "15551234567"
 *       "+1 (555) 123-4567" -> "15551234567"
 */
function extractDigits(raw) {
  if (!raw) return '';
  return String(raw).split('@')[0].split(':')[0].replace(/\D/g, '');
}

/**
 * Format a phone number to standard E.164 with a leading '+'.
 * e.g., "15551234567" -> "+15551234567"
 */
function formatE164(raw) {
  const digits = extractDigits(raw);
  return digits ? `+${digits}` : '';
}

/**
 * Find user by phone number (checks both with and without leading '+').
 */
async function findUserByPhone(rawPhone) {
  const digits = extractDigits(rawPhone);
  if (!digits) return null;
  return db('users')
    .where('whatsapp_phone', digits)
    .orWhere('whatsapp_phone', `+${digits}`)
    .first();
}

/**
 * Initialize WhatsApp Baileys Socket.
 */
async function initWhatsAppBot() {
  if (isStarting) return;
  isStarting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

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
      keepAliveIntervalMs: 25000,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Connection Status Handler ──────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        botStatus = 'qr_ready';
        try {
          currentQRDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
        } catch (e) {
          currentQRDataUrl = null;
        }

        if (process.env.NODE_ENV !== 'production') {
          console.log('\n📱 ═══════════════════════════════════════════════════════════════');
          console.log('📱  SCAN THIS QR CODE IN WHATSAPP TO CONNECT HORAI ASSISTANT:');
          console.log('📱 ═══════════════════════════════════════════════════════════════\n');
          qrcodeTerminal.generate(qr, { small: true });
          console.log('\n👉 Open WhatsApp ➔ Settings ➔ Linked Devices ➔ Link a Device\n');
        }
      }

      if (connection === 'open') {
        botStatus = 'connected';
        currentQR = null;
        currentQRDataUrl = null;

        const myJid = sock.user?.id || '';
        connectedPhone = formatE164(myJid);
        console.log(`\n✅ [WhatsApp Bot] Connected successfully as ${connectedPhone || 'Horai Assistant'}!\n`);

        // Automatically pair the connected phone to the organization owner if unlinked
        if (connectedPhone) {
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
                console.log(`[WhatsApp Bot] Automatically linked owner (${owner.email}) with ${connectedPhone}`);
              }
            }
          } catch (e) {
            console.error('[WhatsApp Bot] Auto-link owner error:', e.message);
          }
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        botStatus = 'disconnected';
        connectedPhone = null;

        if (statusCode !== 408 || process.env.NODE_ENV !== 'production') {
          console.log(`⚠️ [WhatsApp Bot] Disconnected (code: ${statusCode || 'unknown'}). Reconnecting: ${!isLoggedOut}`);
        }

        if (isLoggedOut) {
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
          reconnectTimer = setTimeout(() => {
            isStarting = false;
            initWhatsAppBot();
          }, 2000);
        } else {
          reconnectTimer = setTimeout(() => {
            isStarting = false;
            initWhatsAppBot();
          }, 3000);
        }
      }
    });

    // ── Helper to Send WhatsApp Messages ──────────────────────────────────────
    async function replyToChat(jid, text) {
      if (!sock) return;
      try {
        const sent = await sock.sendMessage(jid, { text });
        if (sent?.key?.id) {
          processedMessageIds.add(sent.key.id);
          if (processedMessageIds.size > 2000) {
            const oldest = processedMessageIds.values().next().value;
            processedMessageIds.delete(oldest);
          }
        }
        return sent;
      } catch (err) {
        console.error('[WhatsApp Bot] Reply error:', err.message);
      }
    }

    // ── Inbound Message Handler ───────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

        // Skip messages sent by the bot's automated reply system
        if (msg.key.id && processedMessageIds.has(msg.key.id)) continue;

        const senderJid = msg.key.remoteJid;
        const myJid = sock?.user?.id || '';

        const myDigits = extractDigits(myJid);
        const senderDigits = extractDigits(senderJid);
        const senderFormatted = formatE164(senderDigits);

        // Accurate Self-Chat detection (messaging oneself / note to self)
        const isSelfChat = senderDigits === myDigits || senderJid.split('@')[0].split(':')[0] === myJid.split('@')[0].split(':')[0];

        // If fromMe is true, only allow if it is a Self-Chat (skip sent messages in normal 1-on-1 external chats)
        if (msg.key.fromMe && !isSelfChat) continue;

        // Extract message text from text, image caption, video caption, or extended text
        const rawText = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          ''
        ).trim();

        if (!rawText) continue;

        console.log(`📩 [WhatsApp Inbound] from ${senderFormatted || senderJid} (${isSelfChat ? 'Self-Chat' : 'Chat'}): "${rawText}"`);

        const textUpper = rawText.toUpperCase();

        // 1. Pairing Command: "PAIR 123456" or "123456"
        const pairMatch = rawText.match(/^(?:PAIR\s+)?(\d{6})$/i);
        if (pairMatch) {
          const code = pairMatch[1];
          const now = new Date();

          const user = await db('users')
            .where({ whatsapp_pairing_code: code })
            .where('whatsapp_pairing_expires_at', '>', now)
            .first();

          if (!user) {
            await replyToChat(
              senderJid,
              '❌ *Invalid or expired pairing code.*\n\nPlease open Horai web app, click "Link WhatsApp" to get a fresh 6-digit code, and send it here.'
            );
            continue;
          }

          // Unlink any old account with this phone
          await db('users')
            .where('whatsapp_phone', senderDigits)
            .orWhere('whatsapp_phone', senderFormatted)
            .update({ whatsapp_phone: null });

          // Link phone to user
          await db('users')
            .where({ id: user.id })
            .update({
              whatsapp_phone: senderFormatted,
              whatsapp_pairing_code: null,
              whatsapp_pairing_expires_at: null,
            });

          await replyToChat(
            senderJid,
            `✅ *Successfully connected to Horai!*\n\nWelcome *${user.name}*! You can now manage your events, hours, expenses, and payroll directly here.\n\nTry asking:\n• "Whats the rate for Arangettram?"\n• "How much do I owe everyone?"\n• "Log 4 hours on Arangettram for Sarah"\n• "Start session for Arangettram"`
          );
          continue;
        }

        // 2. Unpair Command: "UNPAIR"
        if (textUpper === 'UNPAIR') {
          const user = await findUserByPhone(senderDigits);
          if (user) {
            await db('users').where({ id: user.id }).update({ whatsapp_phone: null });
            await replyToChat(senderJid, '✅ Your WhatsApp account has been unlinked from Horai.');
          } else {
            await replyToChat(senderJid, 'Your WhatsApp is not linked to any Horai account.');
          }
          continue;
        }

        // 3. Help Command: "HELP"
        if (textUpper === 'HELP') {
          await replyToChat(
            senderJid,
            `🤖 *Horai Assistant Commands*\n\nYou can ask me anything about your timesheets, expenses, and events:\n• "Whats the rate for Arangettram?"\n• "How much do I owe everyone?"\n• "Log 4 hours on Arangettram for Sarah"\n• "Start session for Arangettram"\n\n• *Unlink Account:* Send "UNPAIR"`
          );
          continue;
        }

        // 4. Resolve User
        let user = await findUserByPhone(senderDigits);

        // If self-chat and not yet explicitly paired, associate with organization owner
        if (!user && isSelfChat) {
          const org = await db('organizations').orderBy('created_at', 'asc').first();
          if (org?.owner_id) {
            user = await db('users').where({ id: org.owner_id }).first();
            if (user) {
              await db('users').where({ id: user.id }).update({ whatsapp_phone: senderFormatted });
              console.log(`[WhatsApp Bot] Auto-linked self-chat to owner (${user.email})`);
            }
          }
        }

        const pendingAction = user ? getPendingAction(user.id) : null;
        const isConfirmResponse = pendingAction && /^(yes|no|confirm|cancel|y|n|proceed|apply)$/i.test(rawText.trim());

        // 5. Check Triggers / Mentions in Group or External Chats
        const horaiPrefixMatch = rawText.match(/^(?:(?:@|!)?horai[\s,:]+|[!/])\s*(.*)$/i);
        const mentionsHorai = /\bhorai\b/i.test(rawText);

        if (!isSelfChat && !horaiPrefixMatch && !mentionsHorai && !isConfirmResponse) {
          if (senderJid.endsWith('@g.us')) continue; // Ignore unrelated group chatter
        }

        // 6. If user is still not registered
        if (!user) {
          await replyToChat(
            senderJid,
            `👋 Welcome to *Horai Assistant*!\n\nYour number (*${senderFormatted}*) is not yet connected to a Horai account.\n\n*To connect:*\n1. Open your Horai web dashboard.\n2. Click the WhatsApp button in the header.\n3. Reply here with:\n👉 *PAIR <6-digit-code>*`
          );
          continue;
        }

        // 7. Clean Prompt for AI
        let cleanPrompt = rawText;
        if (horaiPrefixMatch && horaiPrefixMatch[1]) {
          cleanPrompt = horaiPrefixMatch[1].trim();
        } else if (!isConfirmResponse) {
          cleanPrompt = rawText.replace(/\bhorai\b/gi, '').trim();
        }
        if (!cleanPrompt) cleanPrompt = rawText;

        // 8. Process Message through AI Agent
        try {
          console.log(`🤖 [WhatsApp AI] Processing: "${cleanPrompt}" for ${user.name}`);
          const result = await processAgentMessage({
            user,
            message: cleanPrompt,
            history: [],
          });

          await replyToChat(senderJid, result.reply);
          console.log(`💬 [WhatsApp AI] Sent reply: "${result.reply.substring(0, 80)}..."`);
        } catch (agentErr) {
          console.error('❌ [WhatsApp AI Error]:', agentErr);
          await replyToChat(senderJid, `⚠️ Sorry, I encountered an error: ${agentErr.message}`);
        }
      }
    });

    isStarting = false;
    return sock;
  } catch (err) {
    isStarting = false;
    console.error('❌ [WhatsApp Bot] Initialization error:', err);
  }
}

/**
 * Return current WhatsApp Gateway Status & QR Code for the frontend.
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
 * Request an 8-character phone pairing code for the gateway.
 */
async function requestGatewayPairingCode(phone) {
  const digits = extractDigits(phone);
  if (!digits || digits.length < 8) {
    throw new Error('Please enter a valid phone number with country code (e.g. +1234567890).');
  }

  if (botStatus === 'connected' && sock?.authState?.creds?.registered) {
    throw new Error(`WhatsApp Bot is already connected as ${connectedPhone || 'active session'}.`);
  }

  if (!sock) {
    await initWhatsAppBot();
  }

  // Poll for active socket ready to generate pairing code
  let attempts = 0;
  while (attempts < 30) {
    if (sock?.requestPairingCode && (botStatus === 'qr_ready' || sock?.ws?.readyState === 1 || sock?.ws?.isOpen)) {
      try {
        const rawCode = await sock.requestPairingCode(digits);
        const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
        console.log(`🔑 [WhatsApp Bot] Pairing code generated for ${digits}: ${formatted}`);
        return {
          phone: `+${digits}`,
          code: formatted,
          raw_code: rawCode,
        };
      } catch (err) {
        // Socket may still be handshaking, retry after delay
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    attempts++;
  }

  // If initial attempt did not succeed, perform a clean reset and try once more
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

  isStarting = false;
  await initWhatsAppBot();

  let retryAttempts = 0;
  while (retryAttempts < 30) {
    if (sock?.requestPairingCode && (botStatus === 'qr_ready' || sock?.ws?.readyState === 1 || sock?.ws?.isOpen)) {
      try {
        const rawCode = await sock.requestPairingCode(digits);
        const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
        console.log(`🔑 [WhatsApp Bot] Pairing code generated on retry for ${digits}: ${formatted}`);
        return {
          phone: `+${digits}`,
          code: formatted,
          raw_code: rawCode,
        };
      } catch (err) {
        // retry loop
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    retryAttempts++;
  }

  throw new Error('Failed to generate pairing code. Please scan the QR code or try again.');
}

module.exports = {
  initWhatsAppBot,
  getWhatsAppStatus,
  requestGatewayPairingCode,
};
