/**
 * @file resolvers.js
 * @description Fuzzy entity resolution and access permission utilities for Horai Assistant
 */

const db = require('../../db/knex');

/**
 * Get user default organization (owned or member of).
 */
async function getUserDefaultOrg(userId) {
  let org = await db('organizations').where({ owner_id: userId }).first();
  if (!org) {
    const membership = await db('organization_members')
      .join('organizations', 'organization_members.org_id', 'organizations.id')
      .where('organization_members.user_id', userId)
      .select('organizations.*')
      .first();
    org = membership || null;
  }
  return org;
}

/**
 * Check if a user is the head/owner or organizer of the organization.
 */
function isOrgHead(user, org) {
  if (!org) return false;
  return org.owner_id === user.id || user.role === 'organizer';
}

/**
 * Check if a user has permission to manage a specific event.
 */
async function canUserManageEvent(event, user, org) {
  if (!event || !org) return false;
  if (isOrgHead(user, org)) return true;
  if (event.created_by === user.id) return true;
  if (event.lead_collaborator_id === user.id) return true;
  return false;
}

/**
 * Compute classic Levenshtein distance between two strings.
 */
function levenshteinDistance(s1, s2) {
  const m = s1.length;
  const n = s2.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Resolve an event with exactness and distance metadata.
 */
async function resolveEvent(orgId, identifier) {
  if (!identifier) return null;
  const raw = identifier.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
  if (isUuid) {
    const event = await db('events').where({ id: raw, org_id: orgId }).first();
    if (event) return { event, isExact: true, distance: 0 };
  }

  const allEvents = await db('events').where({ org_id: orgId });
  if (!allEvents.length) return null;

  const clean = raw.toLowerCase().replace(/\b(event|the|for|on|at)\b/gi, '').replace(/["']/g, '').trim();

  // 1. Exact match
  const exact = allEvents.find((e) => e.title.toLowerCase() === raw.toLowerCase() || e.title.toLowerCase() === clean);
  if (exact) return { event: exact, isExact: true, distance: 0 };

  // 2. Substring match
  const sub = allEvents.find((e) => e.title.toLowerCase().includes(clean) || clean.includes(e.title.toLowerCase()));
  if (sub) {
    const isVeryClose = sub.title.toLowerCase() === clean;
    return { event: sub, isExact: isVeryClose, distance: Math.abs(sub.title.length - clean.length) };
  }

  // 3. Fuzzy Levenshtein match (distance <= 4)
  let bestMatch = null;
  let minDistance = 999;
  for (const e of allEvents) {
    const dist = levenshteinDistance(clean, e.title.toLowerCase());
    if (dist < minDistance && dist <= 4) {
      minDistance = dist;
      bestMatch = e;
    }
  }

  if (bestMatch) {
    return { event: bestMatch, isExact: minDistance === 0, distance: minDistance };
  }

  return null;
}

/**
 * Find an event in an organization by UUID, title, substring, prefix, or Levenshtein distance.
 */
async function findEvent(orgId, identifier) {
  const res = await resolveEvent(orgId, identifier);
  return res ? res.event : null;
}

/**
 * Resolve a user in an organization with exactness and distance metadata.
 */
async function resolveUserInOrg(orgId, nameOrEmail) {
  if (!nameOrEmail) return null;
  const raw = nameOrEmail.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
  if (isUuid) {
    const u = await db('users').where({ id: raw }).first();
    if (u) return { user: u, isExact: true, distance: 0 };
  }

  const allMembers = await db('users')
    .join('organization_members', 'users.id', 'organization_members.user_id')
    .where('organization_members.org_id', orgId)
    .select('users.*');

  if (!allMembers.length) return null;

  const clean = raw.toLowerCase().replace(/["']/g, '').trim();

  // 1. Exact email match
  let exactEmail = allMembers.find((u) => u.email.toLowerCase() === clean);
  if (exactEmail) return { user: exactEmail, isExact: true, distance: 0 };

  // 2. Email prefix match
  let emailPrefix = allMembers.find((u) => u.email.toLowerCase().split('@')[0] === clean);
  if (emailPrefix) return { user: emailPrefix, isExact: true, distance: 0 };

  // 3. Exact full name match
  let exactName = allMembers.find((u) => u.name.toLowerCase() === clean);
  if (exactName) return { user: exactName, isExact: true, distance: 0 };

  // 4. Token match (e.g. "Tharun" in "Tharun Kumar")
  let tokenMatch = allMembers.find((u) => u.name.toLowerCase().split(/\s+/).includes(clean));
  if (tokenMatch) return { user: tokenMatch, isExact: true, distance: 0 };

  // 5. Substring match
  let subMatch = allMembers.find((u) => u.name.toLowerCase().includes(clean));
  if (subMatch) return { user: subMatch, isExact: false, distance: Math.abs(subMatch.name.length - clean.length) };

  // 6. Fuzzy Levenshtein match (distance <= 3)
  let bestMatch = null;
  let minDistance = 999;
  for (const u of allMembers) {
    const fullNameDist = levenshteinDistance(clean, u.name.toLowerCase());
    const firstNameDist = levenshteinDistance(clean, u.name.toLowerCase().split(/\s+/)[0]);
    const dist = Math.min(fullNameDist, firstNameDist);
    if (dist < minDistance && dist <= 3) {
      minDistance = dist;
      bestMatch = u;
    }
  }

  if (bestMatch) {
    return { user: bestMatch, isExact: minDistance === 0, distance: minDistance };
  }

  return null;
}

/**
 * Find a user in an organization by UUID, email, name, substring, prefix, or Levenshtein distance.
 */
async function findUserInOrg(orgId, nameOrEmail) {
  const res = await resolveUserInOrg(orgId, nameOrEmail);
  return res ? res.user : null;
}

module.exports = {
  getUserDefaultOrg,
  isOrgHead,
  canUserManageEvent,
  levenshteinDistance,
  resolveEvent,
  findEvent,
  resolveUserInOrg,
  findUserInOrg,
};
