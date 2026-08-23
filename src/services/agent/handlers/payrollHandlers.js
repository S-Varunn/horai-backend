/**
 * @file payrollHandlers.js
 * @description Handlers for tips, payroll summaries, and detailed collaborator timesheets
 */

const db = require('../../../db/knex');
const { computeEventSummary } = require('../../payroll');
const { canUserManageEvent, findEvent, findUserInOrg, isOrgHead } = require('../resolvers');
const { setPendingAction } = require('../confirmation');

async function handleSetTip(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const canManage = await canUserManageEvent(event, user, org);
  if (!canManage) return { error: '⛔ Only the Event Lead or Organizer can set tips.' };

  const collab = await findUserInOrg(org.id, args.collaborator_name_or_email);
  if (!collab) return { error: `Collaborator "${args.collaborator_name_or_email}" not found.` };

  const existingTip = await db('collaborator_tips').where({ event_id: event.id, user_id: collab.id }).first();
  const oldTipAmount = existingTip ? `$${existingTip.tip_amount}` : '$0.00';

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'set_tip', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm tip update:**\n• Event: **${event.title}**\n• Collaborator: **${collab.name}**\n• Tip Amount: **${oldTipAmount}** ➔ **$${parseFloat(args.tip_amount).toFixed(2)}**\n${args.notes ? '• Notes: ' + args.notes : ''}\n\nReply **"YES"** to confirm or **"NO"** to cancel.`,
    };
  }

  const [tip] = await db('collaborator_tips')
    .insert({
      event_id: event.id,
      user_id: collab.id,
      tip_amount: parseFloat(args.tip_amount),
      notes: args.notes || null,
    })
    .onConflict(['event_id', 'user_id'])
    .merge({ tip_amount: parseFloat(args.tip_amount), notes: args.notes || null, updated_at: new Date() })
    .returning('*');

  return {
    success: true,
    message: `✅ Set tip of **$${tip.tip_amount}** for **${collab.name}** on **"${event.title}"**!`,
    tip,
  };
}

async function handleRemoveTip(args, { user, org, skipConfirmation }) {
  const event = await findEvent(org.id, args.event_identifier);
  if (!event) return { error: `Event not found: "${args.event_identifier}"` };

  const canManage = await canUserManageEvent(event, user, org);
  if (!canManage) return { error: '⛔ Only the Event Lead or Organizer can remove tips.' };

  const collab = await findUserInOrg(org.id, args.collaborator_name_or_email);
  if (!collab) return { error: `Collaborator "${args.collaborator_name_or_email}" not found.` };

  if (!skipConfirmation) {
    setPendingAction(user.id, { toolName: 'remove_tip', args, user, org });
    return {
      requires_confirmation: true,
      message: `⚠️ **Please confirm removing tip:**\n• Event: **${event.title}**\n• Collaborator: **${collab.name}**\n\nReply **"YES"** to remove tip or **"NO"** to cancel.`,
    };
  }

  await db('collaborator_tips').where({ event_id: event.id, user_id: collab.id }).del();
  return {
    success: true,
    message: `✅ Removed tip for **${collab.name}** on **"${event.title}"**.`,
  };
}

async function handleGetPayrollSummary(args, { org, user }) {
  // Non-organizers only see their own payout breakdown
  if (!isOrgHead(user, org)) {
    return await handleGetCollaboratorTimesheet(
      { collaborator_name_or_email: 'me', event_identifier: args.event_identifier },
      { org, user }
    );
  }

  // Case 1: Specific single event requested
  if (args.event_identifier && !/^(all|everyone|org|organization|total|overall)$/i.test(args.event_identifier.trim())) {
    const event = await findEvent(org.id, args.event_identifier);
    if (!event) return { error: `Event not found: "${args.event_identifier}"` };

    const summary = await computeEventSummary(event);
    return {
      event_title: event.title,
      status: event.status,
      hourly_rate: event.hourly_rate,
      event_date: event.event_date ? new Date(event.event_date).toISOString().split('T')[0] : null,
      grand_total: summary.grand_total,
      collaborators: summary.collaborators.map((c) => ({
        name: c.user.name,
        email: c.user.email,
        hours_worked: c.breakdown.hours_worked,
        base_pay: c.breakdown.base_pay,
        driving_pay: c.breakdown.driving.driving_pay,
        other_expenses: c.breakdown.other_expenses,
        tip: c.breakdown.tip,
        total_owed: c.breakdown.total_owed,
      })),
      breakdown_text: `💰 **Payroll Summary for ${event.title}**\nRate: $${event.hourly_rate}/hr | Date: ${event.event_date ? new Date(event.event_date).toISOString().split('T')[0] : 'No date'}\n\n${summary.collaborators.map((c) => `• **${c.user.name}**: ${c.breakdown.hours_worked}h worked | Base: $${c.breakdown.base_pay} | Total: **$${c.breakdown.total_owed}**`).join('\n')}\n\n🏆 **Grand Total Payout: $${summary.grand_total}**`,
    };
  }

  // Case 2: Org-Wide Total Payroll across ALL events
  const allEvents = await db('events').where({ org_id: org.id });
  if (!allEvents.length) {
    return {
      organization: org.name,
      grand_total: 0,
      breakdown_text: `💰 **Total Organization Payout: $0**\nNo events found in **${org.name}**.`,
    };
  }

  const memberTotals = new Map();
  let orgGrandTotal = 0;

  for (const event of allEvents) {
    const summary = await computeEventSummary(event);
    orgGrandTotal += summary.grand_total;

    for (const c of summary.collaborators) {
      const existing = memberTotals.get(c.user.id) || {
        name: c.user.name,
        email: c.user.email,
        hours: 0,
        base: 0,
        driving: 0,
        material: 0,
        tips: 0,
        total: 0,
      };

      existing.hours += c.breakdown.hours_worked;
      existing.base += c.breakdown.base_pay;
      existing.driving += c.breakdown.driving.driving_pay;
      existing.material += c.breakdown.other_expenses;
      existing.tips += c.breakdown.tip;
      existing.total += c.breakdown.total_owed;

      memberTotals.set(c.user.id, existing);
    }
  }

  const activeMembers = Array.from(memberTotals.values()).filter((m) => m.total > 0 || m.hours > 0);

  if (activeMembers.length === 0) {
    return {
      organization: org.name,
      grand_total: 0,
      breakdown_text: `💰 **Total Organization Payout: $0**\nNo unpaid hours or balances recorded for **${org.name}**.`,
    };
  }

  const collabsList = activeMembers
    .map((m) => `• **${m.name}**: ${m.hours}h worked | Base: $${m.base} | Driving: $${m.driving} | Tips: $${m.tips} ➔ **$${m.total}**`)
    .join('\n');

  return {
    organization: org.name,
    events_count: allEvents.length,
    grand_total: orgGrandTotal,
    collaborators: activeMembers,
    breakdown_text: `💰 **Total Payout Owed Across "${org.name}": $${orgGrandTotal}**\n\n**Member Balances:**\n${collabsList}\n━━━━━━━━━━━━━━━━━━\n🏆 **Total Organization Liabilities: $${orgGrandTotal}**`,
  };
}

async function handleGetCollaboratorTimesheet(args, { org, user }) {
  const nameRaw = (args.collaborator_name_or_email || '').trim().toLowerCase();

  // If user asked about "everyone" / "all" / "team", forward to org payroll summary
  if (/^(everyone|everybody|all|all\s+members|team|total|overall)$/i.test(nameRaw)) {
    return await handleGetPayrollSummary({}, { org, user });
  }

  // If user asked about "me" / "myself" / "my" or left empty, resolve to the current user
  let targetUser = user;
  if (nameRaw && !/^(me|myself|i|my|mine)$/i.test(nameRaw)) {
    targetUser = await findUserInOrg(org.id, args.collaborator_name_or_email);
    if (!targetUser) return { error: `Collaborator "${args.collaborator_name_or_email}" not found in organization.` };
  }

  // Privacy restriction: Non-organizers can only view their own payout details
  if (!isOrgHead(user, org) && targetUser.id !== user.id) {
    return {
      error: `⛔ Privacy Restriction: You can only view your own hours and payout details. To check ${targetUser.name}'s payout, please ask the organization organizer.`,
    };
  }

  // Case 1: Specific event requested
  if (args.event_identifier) {
    const event = await findEvent(org.id, args.event_identifier);
    if (!event) return { error: `Event not found: "${args.event_identifier}"` };

    const summary = await computeEventSummary(event);
    const collabSummary = summary.collaborators.find((c) => c.user.id === targetUser.id);

    const manualEntries = await db('collaborator_time_entries')
      .where({ event_id: event.id, user_id: targetUser.id })
      .orderBy('created_at', 'desc');

    const expenses = await db('expenses')
      .where({ event_id: event.id, user_id: targetUser.id })
      .orderBy('created_at', 'desc');

    const hoursWorked = collabSummary ? collabSummary.breakdown.hours_worked : 0;
    const basePay = collabSummary ? collabSummary.breakdown.base_pay : 0;
    const drivingPay = collabSummary ? collabSummary.breakdown.driving.driving_pay : 0;
    const otherExpenses = collabSummary ? collabSummary.breakdown.other_expenses : 0;
    const tip = collabSummary ? collabSummary.breakdown.tip : 0;
    const totalOwed = collabSummary ? collabSummary.breakdown.total_owed : 0;

    return {
      event_title: event.title,
      collaborator_name: targetUser.name,
      collaborator_email: targetUser.email,
      hourly_rate: event.hourly_rate,
      hours_worked: hoursWorked,
      minutes_worked: Math.round(hoursWorked * 60),
      base_pay: basePay,
      driving_pay: drivingPay,
      material_expenses: otherExpenses,
      tip: tip,
      total_owed: totalOwed,
      entries_count: manualEntries.length,
      expenses_count: expenses.length,
      breakdown_text: `⏱️ **Timesheet & Summary for ${targetUser.name} on "${event.title}":**\n• **Total Time Worked:** **${hoursWorked} hours** (${Math.round(hoursWorked * 60)} mins)\n• **Hourly Rate:** $${event.hourly_rate}/hr\n• **Base Pay:** $${basePay}\n• **Driving Reimbursement:** $${drivingPay}\n• **Material Expenses:** $${otherExpenses}\n• **Tip:** $${tip}\n━━━━━━━━━━━━━━━━━━\n💰 **Total Payout Owed:** **$${totalOwed}**`,
    };
  }

  // Case 2: Across ALL events in organization
  const allEvents = await db('events').where({ org_id: org.id });
  if (!allEvents.length) {
    return {
      collaborator_name: targetUser.name,
      total_owed: 0,
      breakdown_text: `ℹ️ **${targetUser.name}** has no logged hours or pending payouts (No events in organization).`,
    };
  }

  let totalHours = 0;
  let totalBasePay = 0;
  let totalDrivingPay = 0;
  let totalMaterial = 0;
  let totalTips = 0;
  let grandTotalOwed = 0;
  const eventSummaries = [];

  for (const event of allEvents) {
    const summary = await computeEventSummary(event);
    const collabSummary = summary.collaborators.find((c) => c.user.id === targetUser.id);
    if (collabSummary && (collabSummary.breakdown.hours_worked > 0 || collabSummary.breakdown.total_owed > 0)) {
      totalHours += collabSummary.breakdown.hours_worked;
      totalBasePay += collabSummary.breakdown.base_pay;
      totalDrivingPay += collabSummary.breakdown.driving.driving_pay;
      totalMaterial += collabSummary.breakdown.other_expenses;
      totalTips += collabSummary.breakdown.tip;
      grandTotalOwed += collabSummary.breakdown.total_owed;
      eventSummaries.push({
        title: event.title,
        hours: collabSummary.breakdown.hours_worked,
        total: collabSummary.breakdown.total_owed,
      });
    }
  }

  if (eventSummaries.length === 0) {
    return {
      collaborator_name: targetUser.name,
      total_owed: 0,
      breakdown_text: `ℹ️ You currently owe **$0** to **${targetUser.name}** (No active hours or payouts logged).`,
    };
  }

  const eventsListText = eventSummaries
    .map((e) => `• **${e.title}**: ${e.hours}h worked ➔ **$${e.total}**`)
    .join('\n');

  return {
    collaborator_name: targetUser.name,
    collaborator_email: targetUser.email,
    total_hours_worked: totalHours,
    total_base_pay: totalBasePay,
    total_driving_reimbursement: totalDrivingPay,
    total_material_expenses: totalMaterial,
    total_tips: totalTips,
    total_owed: grandTotalOwed,
    events_count: eventSummaries.length,
    breakdown_text: `💰 **Total Owed to ${targetUser.name}: $${grandTotalOwed}**\n\n**Breakdown across events:**\n${eventsListText}\n\n• **Total Hours:** ${totalHours}h\n• **Base Pay:** $${totalBasePay}\n• **Driving Reimbursement:** $${totalDrivingPay}\n• **Material Expenses:** $${totalMaterial}\n• **Tips:** $${totalTips}\n━━━━━━━━━━━━━━━━━━\n🏆 **Grand Total Owed:** **$${grandTotalOwed}**`,
  };
}

module.exports = {
  set_tip: handleSetTip,
  remove_tip: handleRemoveTip,
  get_payroll_summary: handleGetPayrollSummary,
  get_collaborator_timesheet: handleGetCollaboratorTimesheet,
};
