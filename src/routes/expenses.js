const express = require('express');
const { z } = require('zod');
const db = require('../db/knex');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────────

async function getEvent(eventId) {
  return db('events').where({ id: eventId }).first();
}

async function isOrgOwner(orgId, userId) {
  const row = await db('organizations').where({ id: orgId, owner_id: userId }).first();
  return !!row;
}

async function hasAcceptedInvitation(eventId, userId) {
  const inv = await db('event_invitations')
    .where({ event_id: eventId, user_id: userId, status: 'accepted' }).first();
  return !!inv;
}

// ── Submit expense ─────────────────────────────────────────────────────────

// POST /api/events/:id/expenses
router.post('/events/:id/expenses', requireAuth, async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status === 'completed') return res.status(400).json({ error: 'Event is completed; expenses are locked' });
    if (!(await hasAcceptedInvitation(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Must have accepted invitation to submit expenses' });
    }

    const schema = z.discriminatedUnion('type', [
      z.object({
        type: z.literal('driving'),
        hours_driven: z.number().positive(),
        is_passenger: z.boolean().default(false),
        description: z.string().optional(),
        receipt_note: z.string().optional(),
        submitted_at: z.string().optional(),
      }),
      z.object({
        type: z.literal('material'),
        amount_usd: z.number().positive(),
        description: z.string().min(1),
        receipt_note: z.string().optional(),
        submitted_at: z.string().optional(),
      }),
      z.object({
        type: z.literal('other'),
        amount_usd: z.number().positive(),
        description: z.string().min(1),
        receipt_note: z.string().optional(),
        submitted_at: z.string().optional(),
      }),
    ]);

    const data = schema.parse(req.body);

    const [expense] = await db('expenses').insert({
      event_id: req.params.id,
      user_id: req.user.id,
      type: data.type,
      description: data.description || null,
      amount_usd: data.amount_usd ?? null,
      hours_driven: data.hours_driven ?? null,
      is_passenger: data.is_passenger ?? false,
      receipt_note: data.receipt_note || null,
      submitted_at: data.submitted_at ? new Date(data.submitted_at) : null,
      status: 'pending',
    }).returning('*');

    res.status(201).json(expense);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// ── List expenses ──────────────────────────────────────────────────────────

// GET /api/events/:id/expenses
router.get('/events/:id/expenses', requireAuth, async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const expenses = await db('expenses')
      .join('users', 'expenses.user_id', 'users.id')
      .where('expenses.event_id', req.params.id)
      .select(
        'expenses.*',
        'users.name as user_name',
        'users.email as user_email'
      )
      .orderBy('expenses.submitted_at', 'asc');

    res.json(expenses);
  } catch (err) { next(err); }
});

// ── Delete own pending expense ─────────────────────────────────────────────

// DELETE /api/expenses/:id
router.delete('/expenses/:id', requireAuth, async (req, res, next) => {
  try {
    const expense = await db('expenses').where({ id: req.params.id }).first();
    if (!expense) return res.status(404).json({ error: 'Expense not found' });
    if (expense.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Cannot delete another user\'s expense' });
    }
    if (expense.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending expenses can be deleted' });
    }

    const event = await getEvent(expense.event_id);
    if (event.status === 'completed') return res.status(400).json({ error: 'Event is completed; expenses are locked' });

    await db('expenses').where({ id: req.params.id }).delete();
    res.json({ message: 'Expense deleted' });
  } catch (err) { next(err); }
});

// ── Organizer: review expense ──────────────────────────────────────────────

// PATCH /api/expenses/:id/review
router.patch('/expenses/:id/review', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    const expense = await db('expenses').where({ id: req.params.id }).first();
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    const event = await getEvent(expense.event_id);
    if (!(await isOrgOwner(event.org_id, req.user.id))) {
      return res.status(403).json({ error: 'Not the organizer of this event' });
    }
    if (event.status === 'completed') return res.status(400).json({ error: 'Event is completed' });

    const { status, organizer_comment } = z.object({
      status: z.enum(['approved', 'rejected']),
      organizer_comment: z.string().optional(),
    }).parse(req.body);

    const [updated] = await db('expenses')
      .where({ id: req.params.id })
      .update({ status, organizer_comment: organizer_comment || null, reviewed_at: new Date() })
      .returning('*');

    res.json(updated);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

module.exports = router;
