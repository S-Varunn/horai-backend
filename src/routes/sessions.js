const express = require('express');
const { z } = require('zod');
const db = require('../db/knex');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const { getEvent, isLead, hasAcceptedInvitation, canManageEvent } = require('../db/queries');

// ── Time Sessions (lead-only) ──────────────────────────────────────────────

// POST /api/events/:id/sessions/start
router.post('/events/:id/sessions/start', requireAuth, async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!(await canManageEvent(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Only the lead collaborator or organizer can start a session' });
    }
    if (event.status === 'completed') return res.status(400).json({ error: 'Event is already completed' });

    // Check no open session already
    const open = await db('time_sessions')
      .where({ event_id: req.params.id })
      .whereNull('stopped_at')
      .first();
    if (open) return res.status(409).json({ error: 'A session is already running', session: open });

    const { started_at, title } = z.object({ 
      started_at: z.string(),
      title: z.string().optional().nullable() 
    }).parse(req.body);

    const [session] = await db('time_sessions')
      .insert({ 
        event_id: req.params.id, 
        started_by: req.user.id, 
        started_at: new Date(started_at),
        title: title || null
      })
      .returning('*');

    // Mark event as active if it was scheduled/draft
    if (['draft', 'scheduled'].includes(event.status)) {
      await db('events').where({ id: req.params.id }).update({ status: 'active', updated_at: new Date() });
    }

    res.status(201).json(session);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// POST /api/events/:id/sessions/stop
router.post('/events/:id/sessions/stop', requireAuth, async (req, res, next) => {
  try {
    if (!(await canManageEvent(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Only the lead collaborator or organizer can stop a session' });
    }

    const open = await db('time_sessions')
      .where({ event_id: req.params.id })
      .whereNull('stopped_at')
      .first();
    if (!open) return res.status(404).json({ error: 'No active session found' });

    const { stopped_at } = z.object({ stopped_at: z.string() }).parse(req.body);
    const stoppedDate = new Date(stopped_at);
    const startedDate = new Date(open.started_at);
    const duration_minutes = Math.max(0, Math.round((stoppedDate - startedDate) / 60000));

    const [session] = await db('time_sessions')
      .where({ id: open.id })
      .update({ stopped_at: stoppedDate, stopped_by: req.user.id, duration_minutes })
      .returning('*');

    res.json(session);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// GET /api/events/:id/sessions
router.get('/events/:id/sessions', requireAuth, async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const sessions = await db('time_sessions')
      .where({ event_id: req.params.id })
      .orderBy('started_at', 'asc');

    const total_minutes = sessions.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
    res.json({ sessions, total_minutes, total_hours: +(total_minutes / 60).toFixed(2) });
  } catch (err) { next(err); }
});

// ── Manual Time Entries (any accepted collaborator) ────────────────────────

// POST /api/events/:id/time
router.post('/events/:id/time', requireAuth, async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status === 'completed') return res.status(400).json({ error: 'Event is already completed' });
    if (!(await hasAcceptedInvitation(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Must have accepted invitation to add time' });
    }

    const schema = z.object({
      user_id: z.string().uuid().optional(), // Allow specifying user if lead/organizer
      minutes_worked: z.number().int().positive(),
      notes: z.string().optional(),
      entry_at: z.string().optional(),
      session_id: z.string().uuid().optional().nullable(),
    });
    const data = schema.parse(req.body);

    let targetUserId = req.user.id;
    if (data.user_id && data.user_id !== req.user.id) {
      if (!(await canManageEvent(req.params.id, req.user.id))) {
        return res.status(403).json({ error: 'Only the lead or organizer can add time for others' });
      }
      targetUserId = data.user_id;
    }

    // Verify target user has accepted invitation
    if (!(await hasAcceptedInvitation(req.params.id, targetUserId))) {
      return res.status(403).json({ error: 'Target user has not accepted invitation to this event' });
    }

    const [entry] = await db('collaborator_time_entries').insert({
      event_id: req.params.id,
      user_id: targetUserId,
      minutes_worked: data.minutes_worked,
      notes: data.notes || null,
      entry_at: data.entry_at ? new Date(data.entry_at) : null,
      session_id: data.session_id || null,
    }).returning('*');

    res.status(201).json(entry);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// GET /api/events/:id/time — list manual entries for an event
router.get('/events/:id/time', requireAuth, async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const entries = await db('collaborator_time_entries')
      .join('users', 'collaborator_time_entries.user_id', 'users.id')
      .where('collaborator_time_entries.event_id', req.params.id)
      .select(
        'collaborator_time_entries.*',
        'users.name as user_name',
        'users.email as user_email'
      )
      .orderBy('collaborator_time_entries.entry_at', 'asc');

    res.json(entries);
  } catch (err) { next(err); }
});

// DELETE /api/time-entries/:id
router.delete('/time-entries/:id', requireAuth, async (req, res, next) => {
  try {
    const entry = await db('collaborator_time_entries').where({ id: req.params.id }).first();
    if (!entry) return res.status(404).json({ error: 'Time entry not found' });
    if (entry.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Cannot delete another user\'s time entry' });
    }
    const event = await getEvent(entry.event_id);
    if (event.status === 'completed') return res.status(400).json({ error: 'Event is completed; entries are locked' });

    await db('collaborator_time_entries').where({ id: req.params.id }).delete();
    res.json({ message: 'Time entry deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
