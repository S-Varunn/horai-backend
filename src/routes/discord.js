const express = require('express');
const db = require('../db/knex');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/discord/pairing-code — Generate 6-digit PIN for Discord (15 min validity)
router.post('/pairing-code', requireAuth, async (req, res, next) => {
  try {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await db('users')
      .where({ id: req.user.id })
      .update({
        discord_pairing_code: code,
        discord_pairing_expires_at: expiresAt,
      });

    res.json({
      code,
      expires_at: expiresAt.toISOString(),
      instructions: `Send "PAIR ${code}" in Discord DM to the Horai Bot to link your account.`,
      bot_invite_url: `https://discord.com/oauth2/authorize?client_id=1540787285862125618&permissions=68608&integration_type=0&scope=bot`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/discord/status — check pairing status
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const user = await db('users').where({ id: req.user.id }).first();
    if (!user) return res.status(401).json({ error: 'User not found' });

    const isPaired = !!user.discord_user_id;
    const isCodeActive =
      user.discord_pairing_code &&
      user.discord_pairing_expires_at &&
      new Date(user.discord_pairing_expires_at) > new Date();

    const clientId = process.env.DISCORD_CLIENT_ID || '1540787285862125618';
    const botInviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=68608&integration_type=0&scope=bot`;

    res.json({
      paired: isPaired,
      discord_user_id: user.discord_user_id || null,
      discord_username: user.discord_username || null,
      pairing_code: isCodeActive ? user.discord_pairing_code : null,
      expires_at: isCodeActive ? user.discord_pairing_expires_at : null,
      bot_invite_url: botInviteUrl,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/discord/unlink — Unlink Discord account
router.delete('/unlink', requireAuth, async (req, res, next) => {
  try {
    await db('users')
      .where({ id: req.user.id })
      .update({
        discord_user_id: null,
        discord_username: null,
        discord_pairing_code: null,
        discord_pairing_expires_at: null,
      });

    res.json({ success: true, message: 'Discord unlinked successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
