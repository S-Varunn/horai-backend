const express = require('express');
const { z } = require('zod');
const db = require('../db/knex');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────────

async function isMember(orgId, userId) {
  const row = await db('organization_members').where({ org_id: orgId, user_id: userId }).first();
  return !!row;
}

async function isOwner(orgId, userId) {
  const row = await db('organizations').where({ id: orgId, owner_id: userId }).first();
  return !!row;
}

// ── Routes ─────────────────────────────────────────────────────────────────

// GET /api/orgs — list orgs the user belongs to
router.get('/orgs', requireAuth, async (req, res, next) => {
  try {
    const orgs = await db('organizations')
      .join('organization_members', 'organizations.id', 'organization_members.org_id')
      .where('organization_members.user_id', req.user.id)
      .select('organizations.*', 'organization_members.joined_at');
    res.json(orgs);
  } catch (err) { next(err); }
});

// POST /api/orgs — create org (organizer only)
router.post('/orgs', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
    
    const existing = await db('organizations').where({ name }).first();
    if (existing) return res.status(409).json({ error: 'An organization with this name already exists' });

    const [org] = await db('organizations')
      .insert({ name, owner_id: req.user.id })
      .returning('*');
    // Auto-add organizer as member
    await db('organization_members').insert({ org_id: org.id, user_id: req.user.id });
    res.status(201).json(org);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// GET /api/orgs/:id
router.get('/orgs/:id', requireAuth, async (req, res, next) => {
  try {
    if (!(await isMember(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }
    const org = await db('organizations')
      .join('users', 'organizations.owner_id', 'users.id')
      .where('organizations.id', req.params.id)
      .select('organizations.*', 'users.name as owner_name', 'users.email as owner_email')
      .first();
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json(org);
  } catch (err) { next(err); }
});

// PATCH /api/orgs/:id — rename org (owner only)
router.patch('/orgs/:id', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    if (!(await isOwner(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Not the owner' });
    }
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
    const [org] = await db('organizations').where({ id: req.params.id }).update({ name }).returning('*');
    res.json(org);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// GET /api/orgs/:id/members
router.get('/orgs/:id/members', requireAuth, async (req, res, next) => {
  try {
    if (!(await isMember(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Not a member' });
    }
    const members = await db('organization_members')
      .join('users', 'organization_members.user_id', 'users.id')
      .where('organization_members.org_id', req.params.id)
      .select('users.id', 'users.name', 'users.email', 'users.role', 'organization_members.joined_at');
    res.json(members);
  } catch (err) { next(err); }
});

// POST /api/orgs/join/:invite_code — join org via invite link
router.post('/orgs/join/:invite_code', requireAuth, async (req, res, next) => {
  try {
    const link = await db('org_invite_links')
      .where({ invite_code: req.params.invite_code, is_active: true })
      .first();
    if (!link) return res.status(404).json({ error: 'Invalid or revoked invite link' });
    if (new Date(link.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invite link has expired' });
    }

    const existing = await db('organization_members')
      .where({ org_id: link.org_id, user_id: req.user.id }).first();
    if (existing) return res.status(409).json({ error: 'Already a member of this organization' });

    await db('organization_members').insert({ org_id: link.org_id, user_id: req.user.id });
    const org = await db('organizations').where({ id: link.org_id }).first();
    res.json({ message: 'Joined organization successfully', organization: org });
  } catch (err) { next(err); }
});

// POST /api/orgs/:id/invite-links — generate invite link (owner only)
router.post('/orgs/:id/invite-links', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    if (!(await isOwner(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Not the owner of this organization' });
    }
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const [link] = await db('org_invite_links')
      .insert({ org_id: req.params.id, created_by: req.user.id, expires_at })
      .returning('*');
    res.status(201).json({
      ...link,
      invite_url: `${process.env.BASE_URL}/api/orgs/join/${link.invite_code}`,
    });
  } catch (err) { next(err); }
});

// GET /api/orgs/:id/invite-links — list invite links (owner only)
router.get('/orgs/:id/invite-links', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    if (!(await isOwner(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Not the owner' });
    }
    const links = await db('org_invite_links')
      .where({ org_id: req.params.id })
      .orderBy('created_at', 'desc');
    res.json(links.map((l) => ({
      ...l,
      invite_url: `${process.env.BASE_URL}/api/orgs/join/${l.invite_code}`,
    })));
  } catch (err) { next(err); }
});

// DELETE /api/orgs/:id/invite-links/:linkId — revoke (owner only)
router.delete('/orgs/:id/invite-links/:linkId', requireAuth, requireRole('organizer'), async (req, res, next) => {
  try {
    if (!(await isOwner(req.params.id, req.user.id))) {
      return res.status(403).json({ error: 'Not the owner' });
    }
    const count = await db('org_invite_links')
      .where({ id: req.params.linkId, org_id: req.params.id })
      .update({ is_active: false });
    if (!count) return res.status(404).json({ error: 'Invite link not found' });
    res.json({ message: 'Invite link revoked' });
  } catch (err) { next(err); }
});

module.exports = router;
