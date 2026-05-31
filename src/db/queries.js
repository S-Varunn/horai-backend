const db = require('./knex');

async function getEvent(eventId) {
  return db('events').where({ id: eventId }).first();
}

async function isMember(orgId, userId) {
  const row = await db('organization_members').where({ org_id: orgId, user_id: userId }).first();
  return !!row;
}

async function isOrgOwner(orgId, userId) {
  const row = await db('organizations').where({ id: orgId, owner_id: userId }).first();
  return !!row;
}

async function isEventOrganizer(eventId, userId) {
  const event = await getEvent(eventId);
  if (!event) return false;
  return isOrgOwner(event.org_id, userId);
}

async function isLead(eventId, userId) {
  const event = await getEvent(eventId);
  return event && event.lead_collaborator_id === userId;
}

async function hasAcceptedInvitation(eventId, userId) {
  const inv = await db('event_invitations')
    .where({ event_id: eventId, user_id: userId, status: 'accepted' }).first();
  return !!inv;
}

async function canManageEvent(eventId, userId) {
  return (await isEventOrganizer(eventId, userId)) || (await isLead(eventId, userId));
}

module.exports = {
  getEvent,
  isMember,
  isOrgOwner,
  isEventOrganizer,
  isLead,
  hasAcceptedInvitation,
  canManageEvent,
};
