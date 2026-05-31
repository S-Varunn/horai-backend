const express = require('express');
const { z } = require('zod');
const db = require('../db/knex');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeEventSummary } = require('../services/payroll');

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────────

async function getEvent(eventId) {
  return db('events').where({ id: eventId }).first();
}

async function isOrgOwner(orgId, userId) {
  const row = await db('organizations').where({ id: orgId, owner_id: userId }).first();
  return !!row;
}

async function isMember(orgId, userId) {
  const row = await db('organization_members').where({ org_id: orgId, user_id: userId }).first();
  return !!row;
}

// ── Tips (organizer sets per collaborator) ─────────────────────────────────

// PUT /api/events/:id/tips/:userId
router.put('/events/:id/tips/:userId', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!(await isOrgOwner(event.org_id, req.user.id))) {
      return res.status(403).json({ error: 'Not the organizer of this event' });
    }

    // Only accepted collaborators can receive tips
    const inv = await db('event_invitations')
      .where({ event_id: req.params.id, user_id: req.params.userId, status: 'accepted' }).first();
    if (!inv) return res.status(400).json({ error: 'User has not accepted an invitation to this event' });

    const { tip_amount, notes } = z.object({
      tip_amount: z.number().min(0),
      notes: z.string().optional(),
    }).parse(req.body);

    const [tip] = await db('collaborator_tips')
      .insert({
        event_id: req.params.id,
        user_id: req.params.userId,
        tip_amount,
        notes: notes || null,
      })
      .onConflict(['event_id', 'user_id'])
      .merge({ tip_amount, notes: notes || null, updated_at: new Date() })
      .returning('*');

    res.json(tip);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// GET /api/events/:id/tips
router.get('/events/:id/tips', requireAuth, async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!(await isMember(event.org_id, req.user.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const tips = await db('collaborator_tips')
      .join('users', 'collaborator_tips.user_id', 'users.id')
      .where('collaborator_tips.event_id', req.params.id)
      .select('collaborator_tips.*', 'users.name as user_name', 'users.email as user_email');

    res.json(tips);
  } catch (err) { next(err); }
});

// ── Payroll Summary ────────────────────────────────────────────────────────

// GET /api/events/:id/summary
router.get('/events/:id/summary', requireAuth, async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!(await isMember(event.org_id, req.user.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const summary = await computeEventSummary(event);
    res.json(summary);
  } catch (err) { next(err); }
});

module.exports = router;
