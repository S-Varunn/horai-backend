/**
 * @file expenseHandlers.js
 * @description Handlers for submitting, updating, reviewing, and deleting expenses
 */

const db = require('../../../db/knex');
const { canUserManageEvent, findEvent, findUserInOrg } = require('../resolvers');
const { setPendingAction } = require('../confirmation');

async function handleSubmitExpense(args, { user, org }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const isDriving = args.type === 'driving';
  const hoursDriven = isDriving ? parseFloat(args.hours_driven || 0) : null;
  const isPassenger = isDriving ? Boolean(args.is_passenger) : null;
  const amountUsd = isDriving ? null : parseFloat(args.amount_usd || 0);

  const [expense] = await db('expenses')
    .insert({
      event_id: event.id,
      user_id: user.id,
      type: args.type,
      hours_driven: hoursDriven,
      is_passenger: isPassenger,
      amount_usd: amountUsd,
      description: args.description || null,
      status: 'pending',
    })
    .returning('*');

  const expenseLabel = isDriving
    ? `${hoursDriven} driving hours (${isPassenger ? 'Passenger' : 'Driver'})`
    : `$${amountUsd} (${args.type})`;

  return {
    success: true,
    message: `🧾 Submitted **${expenseLabel}** for **"${event.title}"** (Status: *Pending Review*).`,
    expense_id: expense.id,
  };
}

async function handleUpdateExpense(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const pendingExpense = await db('expenses')
    .where({ event_id: event.id, user_id: user.id, status: 'pending' })
    .orderBy('created_at', 'desc')
    .first();

  if (!pendingExpense) return { error: `No pending expense found for you on "${event.title}".` };

  const updates = {};
  const diffs = [];

  if (args.amount_usd !== undefined) {
    updates.amount_usd = parseFloat(args.amount_usd);
    diffs.push(`• Amount: **$${pendingExpense.amount_usd || 0}** ➔ **$${args.amount_usd}**`);
  }
  if (args.hours_driven !== undefined) {
    updates.hours_driven = parseFloat(args.hours_driven);
    diffs.push(`• Driving Hours: **${pendingExpense.hours_driven || 0}h** ➔ **${args.hours_driven}h**`);
  }
  if (args.description !== undefined) {
    updates.description = args.description;
    diffs.push(`• Description: updated`);
  }

  if (Object.keys(updates).length === 0) return { success: true, message: 'No expense changes provided.' };

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'update_expense', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm updating your pending expense for "${event.title}":**\n${diffs.join('\n')}\n\nReply **"YES"** to confirm or **"NO"** to cancel.`,
    };
  }

  const [updated] = await db('expenses').where({ id: pendingExpense.id }).update(updates).returning('*');
  return {
    success: true,
    message: `✅ Updated pending expense for **"${event.title}"**!`,
    expense: updated,
  };
}

async function handleReviewExpense(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const canManage = await canUserManageEvent(event, user, org);
  if (!canManage) return { error: '⛔ Only the Event Lead or Organizer can review expenses.' };

  const targetUser = await findUserInOrg(org.id, args.collaborator_name_or_email);
  if (!targetUser) return { error: `Collaborator "${args.collaborator_name_or_email}" not found.` };

  const pendingExpense = await db('expenses')
    .where({ event_id: event.id, user_id: targetUser.id, status: 'pending' })
    .orderBy('created_at', 'desc')
    .first();

  if (!pendingExpense) return { error: `No pending expense found for ${targetUser.name} on "${event.title}".` };

  const decision = args.decision === 'approved' ? 'approved' : 'rejected';
  const val = pendingExpense.type === 'driving'
    ? `${pendingExpense.hours_driven} driving hours`
    : `$${pendingExpense.amount_usd}`;

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'review_expense', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm expense review:**\n• Event: **${event.title}**\n• Collaborator: **${targetUser.name}**\n• Expense: **${val}**\n• Action: **${decision.toUpperCase()}**\n\nReply **"YES"** to confirm or **"NO"** to cancel.`,
    };
  }

  await db('expenses').where({ id: pendingExpense.id }).update({ status: decision });
  return {
    success: true,
    message: `✅ Expense of **${val}** for **${targetUser.name}** has been **${decision}**!`,
  };
}

async function handleDeleteExpense(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  let targetUserId = user.id;
  let targetUserName = user.name;

  if (args.collaborator_name_or_email) {
    const canManage = await canUserManageEvent(event, user, org);
    if (canManage) {
      const u = await findUserInOrg(org.id, args.collaborator_name_or_email);
      if (u) {
        targetUserId = u.id;
        targetUserName = u.name;
      }
    }
  }

  const pendingExpense = await db('expenses')
    .where({ event_id: event.id, user_id: targetUserId, status: 'pending' })
    .orderBy('created_at', 'desc')
    .first();

  if (!pendingExpense) return { error: `No pending expense found on "${event.title}".` };

  const val = pendingExpense.type === 'driving'
    ? `${pendingExpense.hours_driven} driving hours`
    : `$${pendingExpense.amount_usd}`;

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'delete_expense', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm deleting expense:**\n• Event: **${event.title}**\n• Expense: **${val}**\n\nReply **"YES"** to delete or **"NO"** to cancel.`,
    };
  }

  await db('expenses').where({ id: pendingExpense.id }).del();
  return {
    success: true,
    message: `✅ Deleted pending expense for **${targetUserName}** on **"${event.title}"**.`,
  };
}

module.exports = {
  submit_expense: handleSubmitExpense,
  update_expense: handleUpdateExpense,
  review_expense: handleReviewExpense,
  delete_expense: handleDeleteExpense,
};
