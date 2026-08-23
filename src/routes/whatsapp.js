const express = require('express');
const db = require('../db/knex');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Normalize Phone Helper ───────────────────────────────────────────────────

function normalizePhone(sender) {
  if (!sender) return '';
  // Remove whatsapp JID suffix if present (e.g. 15551234567@s.whatsapp.net -> 15551234567)
  let clean = sender.replace(/@.*$/, '').trim();
  // Strip non-digit characters except leading plus
  const hasPlus = clean.startsWith('+');
  clean = clean.replace(/\D/g, '');
  return hasPlus ? `+${clean}` : clean;
}

// ── Web App Routes (Protected) ────────────────────────────────────────────────

// POST /api/whatsapp/pairing-code — Generate 6-digit pairing code (15 min validity)
router.post('/pairing-code', requireAuth, async (req, res, next) => {
  try {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await db('users')
      .where({ id: req.user.id })
      .update({
        whatsapp_pairing_code: code,
        whatsapp_pairing_expires_at: expiresAt,
      });

    res.json({
      code,
      expires_at: expiresAt.toISOString(),
      instructions: `Send "PAIR ${code}" to the WhatsApp bot to link your account.`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/whatsapp/gateway-status — Check WhatsApp Bot connection & get QR code (Owner only)
router.get('/gateway-status', requireAuth, async (req, res, next) => {
  try {
    const { getWhatsAppStatus } = require('../services/whatsappBotService');
    const { getUserDefaultOrg, isOrgHead } = require('../services/agent/resolvers');

    const org = await getUserDefaultOrg(req.user.id);
    const isOwner = org ? isOrgHead(req.user, org) : false;

    const botStatus = getWhatsAppStatus();

    // If not an organization head/owner, omit the QR code payload
    if (!isOwner) {
      return res.json({
        status: botStatus.status === 'connected' ? 'connected' : 'disconnected',
        is_owner: false,
        connected_phone: botStatus.connected_phone,
        qr_raw: null,
        qr_data_url: null,
      });
    }

    res.json({
      ...botStatus,
      is_owner: true,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/request-gateway-code — Request 8-digit WhatsApp pairing code (Owner only)
router.post('/request-gateway-code', requireAuth, async (req, res, next) => {
  try {
    const { requestGatewayPairingCode } = require('../services/whatsappBotService');
    const { getUserDefaultOrg, isOrgHead } = require('../services/agent/resolvers');

    const org = await getUserDefaultOrg(req.user.id);
    const isOwner = org ? isOrgHead(req.user, org) : false;

    if (!isOwner) {
      return res.status(403).json({ error: 'Only organization heads can request a WhatsApp Bot pairing code.' });
    }

    const { phone } = req.body || {};
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required (e.g. +1234567890).' });
    }

    const result = await requestGatewayPairingCode(phone);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/whatsapp/status — Check current WhatsApp pairing status
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const user = await db('users')
      .where({ id: req.user.id })
      .select('id', 'name', 'email', 'whatsapp_phone', 'whatsapp_pairing_code', 'whatsapp_pairing_expires_at')
      .first();

    if (!user) return res.status(401).json({ error: 'User not found' });

    const isCodeValid = user.whatsapp_pairing_expires_at && new Date(user.whatsapp_pairing_expires_at) > new Date();

    res.json({
      paired: !!user.whatsapp_phone,
      phone_number: user.whatsapp_phone || null,
      pairing_code: isCodeValid ? user.whatsapp_pairing_code : null,
      expires_at: isCodeValid ? user.whatsapp_pairing_expires_at : null,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/whatsapp/unlink — Unlink WhatsApp account
router.delete('/unlink', requireAuth, async (req, res, next) => {
  try {
    await db('users')
      .where({ id: req.user.id })
      .update({
        whatsapp_phone: null,
        whatsapp_pairing_code: null,
        whatsapp_pairing_expires_at: null,
      });

    res.json({ success: true, message: 'WhatsApp unlinked successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = {
  whatsappRouter: router,
};
