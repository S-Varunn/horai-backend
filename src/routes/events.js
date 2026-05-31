const express = require('express');
const { z } = require('zod');
const db = require('../db/knex');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────────

const { 
  getEvent, isMember, isOrgOwner, isEventOrganizer, isLead, hasAcceptedInvitation, canManageEvent 
} = require('../db/queries');

// ── Create event ───────────────────────────────────────────────────────────

// POST /api/orgs/:orgId/events
router.post('/orgs/:orgId/events', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    if (!(await isOrgOwner(req.params.orgId, req.user.id))) {
      return res.status(403).json({ error: 'Not the owner of this organization' });
    }
    const schema = z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      event_date: z.string(),
      hourly_rate: z.number().positive(),
      lead_collaborator_id: z.string().uuid().optional().nullable(),
    });
    const data = schema.parse(req.body);

    const existing = await db('events').where({ org_id: req.params.orgId, title: data.title }).first();
    if (existing) return res.status(409).json({ error: 'An event with this title already exists in this organization' });

    const [event] = await db('events').insert({
      org_id: req.params.orgId,
      title: data.title,
      description: data.description || null,
      event_date: new Date(data.event_date),
      hourly_rate: data.hourly_rate,
      created_by: req.user.id,
      lead_collaborator_id: data.lead_collaborator_id || null,
      status: 'draft',
    }).returning('*');

    res.status(201).json(event);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// ── List events in org ─────────────────────────────────────────────────────

// GET /api/orgs/:orgId/events
router.get('/orgs/:orgId/events', requireAuth, async (req, res, next) => {
  try {
    if (!(await isMember(req.params.orgId, req.user.id))) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }
    const events = await db('events')
      .where({ org_id: req.params.orgId })
      .orderBy('event_date', 'desc');
    res.json(events);
  } catch (err) { next(err); }
});

// ── Get single event ───────────────────────────────────────────────────────

// GET /api/events/:id
router.get('/events/:id', requireAuth, async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!(await isMember(event.org_id, req.user.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const [lead, invitations] = await Promise.all([
      event.lead_collaborator_id
        ? db('users').where({ id: event.lead_collaborator_id }).select('id', 'name', 'email').first()
        : null,
      db('event_invitations')
        .join('users', 'event_invitations.user_id', 'users.id')
        .where('event_invitations.event_id', req.params.id)
        .select('users.id', 'users.name', 'users.email',
          'event_invitations.status', 'event_invitations.invited_at', 'event_invitations.responded_at'),
    ]);

    res.json({ ...event, lead_collaborator: lead, invitations });
  } catch (err) { next(err); }
});

// ── Update event ───────────────────────────────────────────────────────────

// PATCH /api/events/:id
router.patch('/events/:id', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    if (!(await isEventOrganizer(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Not the organizer of this event' });
    }
    const event = await getEvent(req.params.id);
    if (event.status === 'completed') return res.status(400).json({ error: 'Cannot edit a completed event' });

    const schema = z.object({
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      event_date: z.string().optional(),
      hourly_rate: z.number().positive().optional(),
      status: z.enum(['draft', 'scheduled', 'active']).optional(),
    });
    const data = schema.parse(req.body);

    const updates = { ...data, updated_at: new Date() };
    if (data.event_date) updates.event_date = new Date(data.event_date);

    const [updated] = await db('events').where({ id: req.params.id }).update(updates).returning('*');
    res.json(updated);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// ── Set lead collaborator ──────────────────────────────────────────────────

// PATCH /api/events/:id/lead
router.patch('/events/:id/lead', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    if (!(await isEventOrganizer(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Not the organizer of this event' });
    }
    const { lead_collaborator_id } = z.object({
      lead_collaborator_id: z.string().uuid().nullable(),
    }).parse(req.body);

    // Ensure the lead is an accepted invitee
    if (lead_collaborator_id) {
      const inv = await db('event_invitations')
        .where({ event_id: req.params.id, user_id: lead_collaborator_id, status: 'accepted' }).first();
      if (!inv) return res.status(400).json({ error: 'User has not accepted invitation to this event' });
    }

    const [updated] = await db('events')
      .where({ id: req.params.id })
      .update({ lead_collaborator_id, updated_at: new Date() })
      .returning('*');
    res.json(updated);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// ── Delete event ───────────────────────────────────────────────────────────

// DELETE /api/events/:id
router.delete('/events/:id', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    if (!(await isEventOrganizer(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Not the organizer of this event' });
    }
    const event = await getEvent(req.params.id);
    if (event.status === 'completed') return res.status(400).json({ error: 'Cannot delete a completed event' });
    await db('events').where({ id: req.params.id }).delete();
    res.json({ message: 'Event deleted' });
  } catch (err) { next(err); }
});

// ── Invite collaborators ───────────────────────────────────────────────────

// POST /api/events/:id/invite
router.post('/events/:id/invite', requireAuth, async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    
    // Check if the user is a member of the organization
    if (!(await isMember(event.org_id, req.user.id))) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    if (event.status === 'completed') return res.status(400).json({ error: 'Event is already completed' });

    const { user_ids, invited_at } = z.object({
      user_ids: z.array(z.string().uuid()).min(1),
      invited_at: z.string().optional(),
    }).parse(req.body);

    // Verify all invited users are org members
    const members = await db('organization_members')
      .where('org_id', event.org_id)
      .whereIn('user_id', user_ids)
      .select('user_id');
    const memberSet = new Set(members.map((m) => m.user_id));
    const nonMembers = user_ids.filter((id) => !memberSet.has(id));
    if (nonMembers.length) {
      return res.status(400).json({ error: 'Some users are not org members', non_members: nonMembers });
    }

    // Upsert invitations
    const rows = user_ids.map((uid) => ({
      event_id: req.params.id,
      user_id: uid,
      status: 'pending',
      invited_at: invited_at ? new Date(invited_at) : null,
    }));
    await db('event_invitations')
      .insert(rows)
      .onConflict(['event_id', 'user_id'])
      .merge({ status: 'pending', invited_at: invited_at ? new Date(invited_at) : null });

    res.status(201).json({ message: `Invited ${user_ids.length} collaborator(s)` });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// PATCH /api/events/:id/rsvp
router.patch('/events/:id/rsvp', requireAuth, async (req, res, next) => {
  try {
    const { status, responded_at } = z.object({
      status: z.enum(['accepted', 'declined']),
      responded_at: z.string().optional(),
    }).parse(req.body);

    const inv = await db('event_invitations')
      .where({ event_id: req.params.id, user_id: req.user.id }).first();
    if (!inv) return res.status(404).json({ error: 'No invitation found for this event' });
    
    if (inv.status === 'requested') {
      return res.status(400).json({ error: 'Cannot RSVP to a join request. Wait for organizer approval.' });
    }

    const [updated] = await db('event_invitations')
      .where({ event_id: req.params.id, user_id: req.user.id })
      .update({ status, responded_at: responded_at ? new Date(responded_at) : new Date() })
      .returning('*');
    res.json(updated);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// ── Join Request ───────────────────────────────────────────────────────────

// POST /api/events/:id/join-request
router.post('/events/:id/join-request', requireAuth, async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!(await isMember(event.org_id, req.user.id))) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }
    if (event.status === 'completed') return res.status(400).json({ error: 'Event is already completed' });

    const existing = await db('event_invitations')
      .where({ event_id: req.params.id, user_id: req.user.id }).first();
    
    if (existing) {
      return res.status(409).json({ error: 'You already have an invitation or request for this event', status: existing.status });
    }

    const [invitation] = await db('event_invitations').insert({
      event_id: req.params.id,
      user_id: req.user.id,
      status: 'requested',
      invited_at: new Date(),
    }).returning('*');

    res.status(201).json(invitation);
  } catch (err) { next(err); }
});

// ── Review Join Request ────────────────────────────────────────────────────

// PATCH /api/events/:id/requests/:userId
router.patch('/events/:id/requests/:userId', requireAuth, async (req, res, next) => {
  try {
    if (!(await canManageEvent(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Only organizer or lead can review requests' });
    }

    const { status } = z.object({
      status: z.enum(['accepted', 'rejected']),
    }).parse(req.body);

    const inv = await db('event_invitations')
      .where({ event_id: req.params.id, user_id: req.params.userId, status: 'requested' }).first();
    
    if (!inv) return res.status(404).json({ error: 'No join request found for this user' });

    const [updated] = await db('event_invitations')
      .where({ event_id: req.params.id, user_id: req.params.userId })
      .update({ status, responded_at: new Date() })
      .returning('*');

    res.json(updated);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// ── Complete event ─────────────────────────────────────────────────────────

// POST /api/events/:id/complete
router.post('/events/:id/complete', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    if (!(await isEventOrganizer(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Not the organizer of this event' });
    }
    const event = await getEvent(req.params.id);
    if (event.status === 'completed') return res.status(400).json({ error: 'Event already completed' });

    // Warn if any expenses are still pending
    const pendingExpenses = await db('expenses')
      .where({ event_id: req.params.id, status: 'pending' })
      .count('id as count').first();
    if (parseInt(pendingExpenses.count) > 0) {
      return res.status(400).json({
        error: 'There are pending expenses that must be reviewed before completing the event',
        pending_count: parseInt(pendingExpenses.count),
      });
    }

    const [updated] = await db('events')
      .where({ id: req.params.id })
      .update({ status: 'completed', updated_at: new Date() })
      .returning('*');
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
