const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const db = require('../db/knex');
const { requireAuth } = require('../middleware/auth');
const { send2FACode } = require('../services/email');

const router = express.Router();

const registerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['organizer', 'collaborator']),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);

    // Check unique name and email
    const existingName = await db('users').where({ name: data.name }).first();
    if (existingName) return res.status(409).json({ error: 'A user with this name already exists' });

    const existingEmail = await db('users').where({ email: data.email }).first();
    if (existingEmail) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(data.password, 12);
    const [user] = await db('users')
      .insert({ name: data.name, email: data.email, password_hash, role: data.role })
      .returning(['id', 'name', 'email', 'role', 'created_at']);

    res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const data = loginSchema.parse(req.body);
    const user = await db('users').where({ email: data.email }).first();
    if (!user || !(await bcrypt.compare(data.password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.two_factor_enabled) {
      // Generate 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      await db('users').where({ id: user.id }).update({
        two_factor_code: code,
        two_factor_expires_at: expiresAt
      });

      await send2FACode(user.email, code);

      return res.json({ 
        status: '2fa_required', 
        userId: user.id,
        message: 'A verification code has been sent to your email' 
      });
    }

    const safe = { id: user.id, name: user.name, email: user.email, role: user.role };
    res.json({ user: safe, token: signToken(safe) });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// POST /api/auth/verify-2fa
router.post('/verify-2fa', async (req, res, next) => {
  try {
    const { userId, code } = z.object({
      userId: z.string().uuid(),
      code: z.string().length(6)
    }).parse(req.body);

    const user = await db('users').where({ id: userId }).first();
    if (!user || !user.two_factor_code || user.two_factor_code !== code) {
      return res.status(401).json({ error: 'Invalid verification code' });
    }

    if (new Date(user.two_factor_expires_at) < new Date()) {
      return res.status(410).json({ error: 'Verification code has expired' });
    }

    // Clear code after successful verification
    await db('users').where({ id: userId }).update({
      two_factor_code: null,
      two_factor_expires_at: null
    });

    const safe = { id: user.id, name: user.name, email: user.email, role: user.role };
    res.json({ user: safe, token: signToken(safe) });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// PATCH /api/auth/2fa/toggle
router.patch('/2fa/toggle', requireAuth, async (req, res, next) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    
    const [user] = await db('users')
      .where({ id: req.user.id })
      .update({ two_factor_enabled: enabled })
      .returning(['id', 'two_factor_enabled']);
    
    res.json({ message: `2FA ${enabled ? 'enabled' : 'disabled'} successfully`, two_factor_enabled: user.two_factor_enabled });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await db('users')
      .where({ id: req.user.id })
      .select('id', 'name', 'email', 'role', 'created_at')
      .first();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
