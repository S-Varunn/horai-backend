const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { processAgentMessage } = require('../services/agentService');
const db = require('../db/knex');

const router = express.Router();

// POST /api/agent/chat — Interactive chat for authenticated web users
router.post('/chat', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      message: z.string().min(1),
      history: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string(),
          })
        )
        .optional()
        .default([]),
    });

    const { message, history } = schema.parse(req.body);

    const user = await db('users').where({ id: req.user.id }).first();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await processAgentMessage({
      user,
      message,
      history,
    });

    res.json({
      reply: result.reply,
      tools_used: result.tools_used,
    });
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: 'Validation failed', details: err.errors });
    }
    next(err);
  }
});

module.exports = router;
