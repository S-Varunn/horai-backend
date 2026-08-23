/**
 * @file contextBuilders.js
 * @description Structured data snapshot builders for AI agent reasoning
 */

const db = require('../../db/knex');
const { computeEventSummary } = require('../payroll');

/**
 * Build unified snapshot of an event (details, roster, timers, manual logs, expenses, tips, payroll).
 */
async function buildEventFullContext(event, user, org) {
  const [summary, leadUser, invitations, sessions, manualEntries, expenses, tips] = await Promise.all([
    computeEventSummary(event),
    event.lead_collaborator_id ? db('users').where({ id: event.lead_collaborator_id }).select('id', 'name', 'email').first() : null,
    db('event_invitations')
      .join('users', 'event_invitations.user_id', 'users.id')
      .where({ event_id: event.id })
      .select('users.id', 'users.name', 'users.email', 'event_invitations.status', 'event_invitations.invited_at'),
    db('time_sessions').where({ event_id: event.id }).orderBy('started_at', 'desc'),
    db('collaborator_time_entries')
      .join('users', 'collaborator_time_entries.user_id', 'users.id')
      .where({ event_id: event.id })
      .select('collaborator_time_entries.*', 'users.name as user_name', 'users.email as user_email'),
    db('expenses')
      .join('users', 'expenses.user_id', 'users.id')
      .where({ event_id: event.id })
      .select('expenses.*', 'users.name as user_name', 'users.email as user_email'),
    db('collaborator_tips')
      .join('users', 'collaborator_tips.user_id', 'users.id')
      .where({ event_id: event.id })
      .select('collaborator_tips.*', 'users.name as user_name', 'users.email as user_email'),
  ]);

  const baseUrl = process.env.BASE_URL || 'http://localhost:5173';
  const joinLink = `${baseUrl}/events/${event.id}`;
  const activeSession = sessions.find((s) => !s.stopped_at);

  const isOwnerOrLead =
    org?.owner_id === user?.id || user?.role === 'organizer' || event.lead_collaborator_id === user?.id;

  // Filter sensitive member data: collaborators only see their own logs & payout
  const filteredManualEntries = isOwnerOrLead
    ? manualEntries
    : manualEntries.filter((e) => e.user_id === user?.id);

  const filteredExpenses = isOwnerOrLead
    ? expenses
    : expenses.filter((exp) => exp.user_id === user?.id);

  const filteredTips = isOwnerOrLead
    ? tips
    : tips.filter((t) => t.user_id === user?.id);

  const filteredCollabs = isOwnerOrLead
    ? summary.collaborators
    : summary.collaborators.filter((c) => c.user.id === user?.id);

  const userPayoutTotal = filteredCollabs.reduce((acc, c) => acc + (c.breakdown.total_owed || 0), 0);

  return {
    event: {
      id: event.id,
      title: event.title,
      description: event.description,
      status: event.status,
      event_date: event.event_date ? new Date(event.event_date).toISOString().split('T')[0] : null,
      hourly_rate: event.hourly_rate,
      lead_collaborator: leadUser ? `${leadUser.name} (${leadUser.email})` : 'Unassigned',
      is_current_user_lead: event.lead_collaborator_id === user?.id,
      join_code: event.id,
      join_link: joinLink,
      active_timer: activeSession ? { started_at: activeSession.started_at, title: activeSession.title } : null,
    },
    team_members: invitations.map((i) => ({
      name: i.name,
      email: i.email,
      status: i.status,
    })),
    time_tracking: {
      total_sessions_count: sessions.length,
      manual_entries_count: filteredManualEntries.length,
      manual_entries: filteredManualEntries.map((e) => ({
        collaborator: e.user_name,
        hours: (e.minutes_worked / 60).toFixed(1),
        minutes: e.minutes_worked,
        notes: e.notes,
        created_at: e.created_at,
      })),
    },
    expenses: {
      total_count: filteredExpenses.length,
      items: filteredExpenses.map((exp) => ({
        collaborator: exp.user_name,
        type: exp.type,
        status: exp.status,
        amount_usd: exp.amount_usd,
        hours_driven: exp.hours_driven,
        is_passenger: exp.is_passenger,
        description: exp.description,
      })),
    },
    tips: filteredTips.map((t) => ({
      collaborator: t.user_name,
      amount: t.tip_amount,
      notes: t.notes,
    })),
    payroll_and_payout_breakdown: {
      grand_total: isOwnerOrLead ? summary.grand_total : userPayoutTotal,
      collaborators: filteredCollabs.map((c) => ({
        name: c.user.name,
        email: c.user.email,
        hours_worked: c.breakdown.hours_worked,
        base_pay: c.breakdown.base_pay,
        driving_reimbursement: c.breakdown.driving.driving_pay,
        material_expenses: c.breakdown.other_expenses,
        tip: c.breakdown.tip,
        total_payout_owed: c.breakdown.total_owed,
      })),
    },
  };
}

/**
 * Build unified snapshot of an organization (name, members, roles, invite links, events).
 */
async function buildOrganizationOverview(org, user) {
  const [events, members, inviteLinks] = await Promise.all([
    db('events').where({ org_id: org.id }).orderBy('event_date', 'desc'),
    db('organization_members')
      .join('users', 'organization_members.user_id', 'users.id')
      .where({ org_id: org.id })
      .select('users.id', 'users.name', 'users.email', 'users.role', 'organization_members.joined_at'),
    db('org_invite_links').where({ org_id: org.id, is_active: true }),
  ]);

  const baseUrl = process.env.BASE_URL || 'http://localhost:5173';

  return {
    organization: {
      id: org.id,
      name: org.name,
      is_owner: org.owner_id === user.id,
      active_invite_links: inviteLinks.map((l) => `${baseUrl}/join/${l.invite_code}`),
    },
    members_count: members.length,
    members: members.map((m) => ({
      name: m.name,
      email: m.email,
      role: m.role || 'collaborator',
      is_owner: m.id === org.owner_id,
    })),
    events_count: events.length,
    events: events.map((e) => ({
      id: e.id,
      title: e.title,
      status: e.status,
      event_date: e.event_date ? new Date(e.event_date).toISOString().split('T')[0] : null,
      hourly_rate: e.hourly_rate,
      join_link: `${baseUrl}/events/${e.id}`,
    })),
  };
}

module.exports = {
  buildEventFullContext,
  buildOrganizationOverview,
};
