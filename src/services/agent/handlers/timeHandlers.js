/**
 * @file timeHandlers.js
 * @description Handlers for live timers, sessions, and manual timesheet adjustments
 */

const db = require('../../../db/knex');
const { canUserManageEvent, findEvent, findUserInOrg } = require('../resolvers');
const { setPendingAction } = require('../confirmation');

async function handleStartSession(args, { user, org }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const existingActive = await db('time_sessions')
    .where({ event_id: event.id })
    .whereNull('stopped_at')
    .first();

  if (existingActive) {
    return {
      error: `A session ("${existingActive.title || 'Live Session'}") is already active on "${event.title}", started at ${new Date(existingActive.started_at).toLocaleTimeString()}.`,
    };
  }

  const [session] = await db('time_sessions')
    .insert({
      event_id: event.id,
      started_by: user.id,
      title: args.title || 'Live Session',
      started_at: new Date(),
    })
    .returning('*');

  return {
    success: true,
    message: `⏱️ Started session **"${session.title}"** on **"${event.title}"** at ${new Date(session.started_at).toLocaleTimeString()}!`,
    session_id: session.id,
  };
}

async function handleStopSession(args, { org }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const activeSession = await db('time_sessions')
    .where({ event_id: event.id })
    .whereNull('stopped_at')
    .first();

  if (!activeSession) {
    return { error: `No active timer session running on "${event.title}".` };
  }

  const now = new Date();
  const startedAt = new Date(activeSession.started_at);
  const minutesWorked = Math.round((now - startedAt) / 60000);
  const hoursFormatted = (minutesWorked / 60).toFixed(2);

  const [stopped] = await db('time_sessions')
    .where({ id: activeSession.id })
    .update({ stopped_at: now })
    .returning('*');

  // Auto-log collaborator time entries for accepted collaborators
  const acceptedMembers = await db('event_invitations')
    .where({ event_id: event.id, status: 'accepted' })
    .select('user_id');

  const userIdsToLog = new Set(acceptedMembers.map((m) => m.user_id));
  if (event.lead_collaborator_id) userIdsToLog.add(event.lead_collaborator_id);

  for (const uid of userIdsToLog) {
    await db('collaborator_time_entries')
      .insert({
        event_id: event.id,
        user_id: uid,
        session_id: stopped.id,
        minutes_worked: minutesWorked,
        entry_at: startedAt,
      })
      .onConflict(['session_id', 'user_id'])
      .merge({ minutes_worked: minutesWorked });
  }

  return {
    success: true,
    message: `🛑 Stopped session **"${stopped.title}"** on **"${event.title}"**.\nDuration: **${hoursFormatted} hours** (${minutesWorked} mins) logged for ${userIdsToLog.size} collaborator(s).`,
    duration_minutes: minutesWorked,
    duration_hours: hoursFormatted,
  };
}

async function handleLogManualTime(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const canManage = await canUserManageEvent(event, user, org);
  if (!canManage) return { error: '⛔ Only the Event Lead or Organizer can manually log time for collaborators.' };

  const targetUser = await findUserInOrg(org.id, args.collaborator_name_or_email);
  if (!targetUser) return { error: `Collaborator "${args.collaborator_name_or_email}" not found.` };

  const hours = parseFloat(args.hours);
  if (isNaN(hours) || hours <= 0) return { error: 'Hours must be a positive number.' };
  const minutesWorked = Math.round(hours * 60);

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'log_manual_time', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm manual time entry:**\n• Event: **${event.title}**\n• Collaborator: **${targetUser.name}**\n• Hours to log: **${hours}h** (${minutesWorked} mins)\n${args.notes ? '• Notes: ' + args.notes : ''}\n\nReply **"YES"** to confirm or **"NO"** to cancel.`,
    };
  }

  const [entry] = await db('collaborator_time_entries')
    .insert({
      event_id: event.id,
      user_id: targetUser.id,
      minutes_worked: minutesWorked,
      notes: args.notes || null,
      entry_at: new Date(),
    })
    .returning('*');

  return {
    success: true,
    message: `✅ Logged **${hours} hours** for **${targetUser.name}** on **"${event.title}"**.`,
    entry_id: entry.id,
  };
}

async function handleModifyTimeEntry(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const canManage = await canUserManageEvent(event, user, org);
  if (!canManage) return { error: '⛔ Only the Event Lead or Organizer can adjust hours.' };

  const targetUser = await findUserInOrg(org.id, args.collaborator_name_or_email);
  if (!targetUser) return { error: `Collaborator "${args.collaborator_name_or_email}" not found.` };

  const rawHours = args.new_hours !== undefined ? args.new_hours : (args.new_hours_worked !== undefined ? args.new_hours_worked : args.hours);
  const newHours = parseFloat(rawHours);
  if (isNaN(newHours) || newHours < 0) return { error: 'New hours must be a valid number.' };
  const newMinutes = Math.round(newHours * 60);

  const existingEntry = await db('collaborator_time_entries')
    .where({ event_id: event.id, user_id: targetUser.id })
    .orderBy('created_at', 'desc')
    .first();

  const oldHours = existingEntry ? (existingEntry.minutes_worked / 60).toFixed(1) : '0';

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'modify_time_entry', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm timesheet adjustment:**\n• Event: **${event.title}**\n• Collaborator: **${targetUser.name}**\n• Hours: **${oldHours}h** ➔ **${newHours}h** (${newMinutes} mins)\n\nReply **"YES"** to confirm or **"NO"** to cancel.`,
    };
  }

  if (existingEntry) {
    await db('collaborator_time_entries')
      .where({ id: existingEntry.id })
      .update({
        minutes_worked: newMinutes,
        notes: args.notes || existingEntry.notes || 'Adjusted by organizer/lead',
      });
  } else {
    await db('collaborator_time_entries').insert({
      event_id: event.id,
      user_id: targetUser.id,
      minutes_worked: newMinutes,
      notes: args.notes || 'Manually entered',
      entry_at: new Date(),
    });
  }

  return {
    success: true,
    message: existingEntry
      ? `✅ Adjusted hours for **${targetUser.name}** on **"${event.title}"** to **${newHours} hours** (${newMinutes} mins).`
      : `✅ Created time entry for **${targetUser.name}** on **"${event.title}"** with **${newHours} hours**.`,
  };
}

async function handleDeleteTimeEntry(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const canManage = await canUserManageEvent(event, user, org);
  if (!canManage) return { error: '⛔ Only the Event Lead or Organizer can delete time entries.' };

  const targetUser = await findUserInOrg(org.id, args.collaborator_name_or_email);
  if (!targetUser) return { error: `Collaborator "${args.collaborator_name_or_email}" not found.` };

  const latestEntry = await db('collaborator_time_entries')
    .where({ event_id: event.id, user_id: targetUser.id })
    .orderBy('created_at', 'desc')
    .first();

  if (!latestEntry) return { error: `No time entry found for ${targetUser.name} on "${event.title}".` };

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'delete_time_entry', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm deleting time entry:**\n• Event: **${event.title}**\n• Collaborator: **${targetUser.name}**\n• Entry: **${(latestEntry.minutes_worked / 60).toFixed(1)}h** (${latestEntry.minutes_worked} mins)\n\nReply **"YES"** to delete or **"NO"** to cancel.`,
    };
  }

  await db('collaborator_time_entries').where({ id: latestEntry.id }).del();
  return {
    success: true,
    message: `✅ Deleted time entry of **${(latestEntry.minutes_worked / 60).toFixed(1)}h** for **${targetUser.name}** on **"${event.title}"**.`,
  };
}

module.exports = {
  start_session: handleStartSession,
  stop_session: handleStopSession,
  log_manual_time: handleLogManualTime,
  modify_time_entry: handleModifyTimeEntry,
  delete_time_entry: handleDeleteTimeEntry,
};
