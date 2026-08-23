/**
 * @file eventHandlers.js
 * @description Handlers for event lifecycle, leads, invitations, and metadata
 */

const db = require('../../../db/knex');
const { isOrgHead, canUserManageEvent, findEvent, findUserInOrg } = require('../resolvers');
const { setPendingAction } = require('../confirmation');
const { buildEventFullContext } = require('../contextBuilders');

async function handleListEvents(args, { org }) {
  let query = db('events').where({ org_id: org.id });
  if (args.status) {
    query = query.where({ status: args.status });
  }
  const events = await query.orderBy('event_date', 'desc');
  return {
    organization: org.name,
    count: events.length,
    events: events.map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      status: e.status,
      event_date: e.event_date ? new Date(e.event_date).toISOString().split('T')[0] : null,
      hourly_rate: e.hourly_rate,
      lead_collaborator_id: e.lead_collaborator_id,
    })),
  };
}

async function handleCreateEvent(args, { user, org }) {
  if (!isOrgHead(user, org)) {
    return {
      error: '⛔ Permission Denied: Only the Head of Organization (Organizer) has permission to create new events.',
    };
  }

  let leadCollaboratorId = null;
  let leadName = null;
  if (args.lead_collaborator_name_or_email) {
    const lead = await findUserInOrg(org.id, args.lead_collaborator_name_or_email);
    if (lead) {
      leadCollaboratorId = lead.id;
      leadName = lead.name;
    }
  }

  const [event] = await db('events')
    .insert({
      org_id: org.id,
      title: args.title,
      event_date: args.event_date,
      hourly_rate: parseFloat(args.hourly_rate),
      description: args.description || null,
      status: 'scheduled',
      created_by: user.id,
      lead_collaborator_id: leadCollaboratorId,
    })
    .returning('*');

  // Auto-invite event lead
  if (leadCollaboratorId) {
    await db('event_invitations')
      .insert({
        event_id: event.id,
        user_id: leadCollaboratorId,
        status: 'accepted',
      })
      .onConflict(['event_id', 'user_id'])
      .merge();
  }

  // Invite specified collaborators
  const invitedMembers = [];
  if (args.invitee_names_or_emails && Array.isArray(args.invitee_names_or_emails)) {
    for (const nameOrEmail of args.invitee_names_or_emails) {
      const u = await findUserInOrg(org.id, nameOrEmail);
      if (u) {
        await db('event_invitations')
          .insert({
            event_id: event.id,
            user_id: u.id,
            status: 'pending',
          })
          .onConflict(['event_id', 'user_id'])
          .ignore();
        invitedMembers.push(u.name);
      }
    }
  }

  const baseUrl = process.env.BASE_URL || 'http://localhost:5173';
  const joinLink = `${baseUrl}/events/${event.id}`;

  return {
    success: true,
    message: `🎉 Event **"${event.title}"** created successfully!`,
    event_id: event.id,
    event_date: event.event_date,
    hourly_rate: event.hourly_rate,
    lead: leadName || 'Unassigned',
    join_link: joinLink,
    invited: invitedMembers,
  };
}

async function handleGetEventDetails(args, { org }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const lead = event.lead_collaborator_id
    ? await db('users').where({ id: event.lead_collaborator_id }).select('name', 'email').first()
    : null;

  const invitations = await db('event_invitations')
    .join('users', 'event_invitations.user_id', 'users.id')
    .where({ event_id: event.id })
    .select('users.name', 'users.email', 'event_invitations.status');

  const activeSession = await db('time_sessions')
    .where({ event_id: event.id })
    .whereNull('stopped_at')
    .first();

  const baseUrl = process.env.BASE_URL || 'http://localhost:5173';
  const joinLink = `${baseUrl}/events/${event.id}`;

  const rosterText = invitations.length
    ? invitations.map((i) => `• **${i.name}** (${i.email}) - *${i.status}*`).join('\n')
    : '• *No collaborators joined yet.*';

  return {
    id: event.id,
    title: event.title,
    description: event.description,
    status: event.status,
    event_date: event.event_date ? new Date(event.event_date).toISOString().split('T')[0] : null,
    hourly_rate: event.hourly_rate,
    lead_collaborator: lead ? `${lead.name} (${lead.email})` : 'Unassigned',
    join_link: joinLink,
    active_timer: activeSession ? { started_at: activeSession.started_at, title: activeSession.title } : null,
    roster: invitations,
    message: `👥 **Team & Event Details for "${event.title}":**\n• **Event Lead:** ${lead ? `${lead.name} (${lead.email})` : 'Unassigned'}\n• **Hourly Rate:** $${parseFloat(event.hourly_rate).toFixed(2)}/hr\n• **Date:** ${event.event_date ? new Date(event.event_date).toISOString().split('T')[0] : 'No date'}\n\n**Collaborator Roster (${invitations.length}):**\n${rosterText}\n\n🎫 **Join Link:** ${joinLink}`,
  };
}

async function handleGetEventFullContext(args, { user, org }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };
  return await buildEventFullContext(event, user, org);
}

async function handleGetEventJoinLink(args, { org }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const baseUrl = process.env.BASE_URL || 'http://localhost:5173';
  const joinLink = `${baseUrl}/events/${event.id}`;

  return {
    event_id: event.id,
    event_title: event.title,
    join_link: joinLink,
    join_code: event.id,
  };
}

async function handleUpdateEvent(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const canManage = await canUserManageEvent(event, user, org);
  if (!canManage) {
    return { error: '⛔ Permission Denied: Only the Event Lead or Organizer can modify this event.' };
  }

  const updates = {};
  const diffs = [];

  if (args.title && args.title !== event.title) {
    updates.title = args.title;
    diffs.push(`• Title: **"${event.title}"** ➔ **"${args.title}"**`);
  }
  if (args.event_date) {
    const formattedDate = new Date(args.event_date).toISOString().split('T')[0];
    const oldDate = event.event_date ? new Date(event.event_date).toISOString().split('T')[0] : 'None';
    if (formattedDate !== oldDate) {
      updates.event_date = args.event_date;
      diffs.push(`• Event Date: **${oldDate}** ➔ **${formattedDate}**`);
    }
  }
  if (args.hourly_rate !== undefined && parseFloat(args.hourly_rate) !== parseFloat(event.hourly_rate)) {
    updates.hourly_rate = parseFloat(args.hourly_rate);
    diffs.push(`• Hourly Rate: **$${parseFloat(event.hourly_rate).toFixed(2)}/hr** ➔ **$${parseFloat(args.hourly_rate).toFixed(2)}/hr**`);
  }
  if (args.description !== undefined && args.description !== event.description) {
    updates.description = args.description;
    diffs.push(`• Description: updated`);
  }
  if (args.status && args.status !== event.status) {
    updates.status = args.status;
    diffs.push(`• Status: **${event.status}** ➔ **${args.status}**`);
  }

  if (Object.keys(updates).length === 0) {
    return { success: true, message: `No changes detected for event **"${event.title}"**.` };
  }

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'update_event', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm the following updates for "${event.title}":**\n${diffs.join('\n')}\n\nReply **"YES"** to confirm and apply these changes, or **"NO"** to cancel.`,
    };
  }

  const [updatedEvent] = await db('events')
    .where({ id: event.id })
    .update(updates)
    .returning('*');

  return {
    success: true,
    message: `✅ Event **"${updatedEvent.title}"** has been updated successfully!`,
    event: updatedEvent,
  };
}

async function handleSetEventLead(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const canManage = await canUserManageEvent(event, user, org);
  if (!canManage) return { error: '⛔ Only the Event Lead or Organizer can assign an Event Lead.' };

  const lead = await findUserInOrg(org.id, args.collaborator_name_or_email);
  if (!lead) return { error: `Collaborator "${args.collaborator_name_or_email}" not found in organization.` };

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'set_event_lead', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm Event Lead assignment:**\n• Event: **${event.title}**\n• New Lead: **${lead.name}** (${lead.email})\n\nReply **"YES"** to confirm or **"NO"** to cancel.`,
    };
  }

  await db('events').where({ id: event.id }).update({ lead_collaborator_id: lead.id });

  await db('event_invitations')
    .insert({ event_id: event.id, user_id: lead.id, status: 'accepted' })
    .onConflict(['event_id', 'user_id'])
    .merge({ status: 'accepted' });

  return {
    success: true,
    message: `✅ **${lead.name}** is now assigned as the Event Lead for **"${event.title}"**!`,
  };
}

async function handleRemoveEventLead(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  if (!isOrgHead(user, org)) return { error: '⛔ Only the Organization Owner can remove the Event Lead.' };

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'remove_event_lead', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm unassigning the Event Lead for "${event.title}".**\n\nReply **"YES"** to confirm or **"NO"** to cancel.`,
    };
  }

  await db('events').where({ id: event.id }).update({ lead_collaborator_id: null });
  return {
    success: true,
    message: `✅ Event Lead unassigned from **"${event.title}"**.`,
  };
}

async function handleInviteCollabsToEvent(args, { user, org }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const canManage = await canUserManageEvent(event, user, org);
  if (!canManage) return { error: '⛔ Only the Event Lead or Organizer can invite members to this event.' };

  const invited = [];
  const notFound = [];

  for (const identifier of args.collaborator_names_or_emails) {
    const targetUser = await findUserInOrg(org.id, identifier);
    if (targetUser) {
      await db('event_invitations')
        .insert({ event_id: event.id, user_id: targetUser.id, status: 'pending' })
        .onConflict(['event_id', 'user_id'])
        .ignore();
      invited.push(targetUser.name);
    } else {
      notFound.push(identifier);
    }
  }

  return {
    success: true,
    message: `📩 Invitations sent for **"${event.title}"**: ${invited.join(', ') || 'None'}${notFound.length ? ` (Not found: ${notFound.join(', ')})` : ''}`,
    invited,
    not_found: notFound,
  };
}

async function handleRemoveCollabFromEvent(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const canManage = await canUserManageEvent(event, user, org);
  if (!canManage) return { error: '⛔ Only the Event Lead or Organizer can remove collaborators from this event.' };

  const targetUser = await findUserInOrg(org.id, args.collaborator_name_or_email);
  if (!targetUser) return { error: `Collaborator "${args.collaborator_name_or_email}" not found.` };

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'remove_collaborator_from_event', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm removing collaborator from event:**\n• Event: **${event.title}**\n• Collaborator: **${targetUser.name}**\n\nReply **"YES"** to confirm or **"NO"** to cancel.`,
    };
  }

  await db('event_invitations').where({ event_id: event.id, user_id: targetUser.id }).del();

  if (event.lead_collaborator_id === targetUser.id) {
    await db('events').where({ id: event.id }).update({ lead_collaborator_id: null });
  }

  return {
    success: true,
    message: `✅ Removed **${targetUser.name}** from **"${event.title}"**.`,
  };
}

module.exports = {
  list_events: handleListEvents,
  create_event: handleCreateEvent,
  get_event_details: handleGetEventDetails,
  get_event_full_context: handleGetEventFullContext,
  get_event_join_link: handleGetEventJoinLink,
  update_event: handleUpdateEvent,
  set_event_lead: handleSetEventLead,
  remove_event_lead: handleRemoveEventLead,
  invite_collaborators_to_event: handleInviteCollabsToEvent,
  remove_collaborator_from_event: handleRemoveCollabFromEvent,
};
