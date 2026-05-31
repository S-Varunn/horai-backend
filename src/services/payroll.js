const db = require('../db/knex');

/**
 * Computes the full payroll summary for an event.
 * All monetary values are in USD, rounded to 2 decimal places.
 *
 * Formula per collaborator:
 *   hours_worked   = SUM(session.duration_minutes + manual_entries.minutes_worked) / 60
 *   base_pay       = hours_worked × event.hourly_rate
 *   driving_pay    = SUM(hours_driven [driver])   × hourly_rate
 *                  + SUM(hours_driven [passenger]) × hourly_rate / 2
 *   other_expenses = SUM(amount_usd WHERE type IN (material, other) AND status=approved)
 *   tip            = collaborator_tips.tip_amount (organizer-set per person)
 *   total_owed     = base_pay + driving_pay + other_expenses + tip
 */
async function computeEventSummary(event) {
  const hourlyRate = parseFloat(event.hourly_rate);

  // Fetch all accepted collaborators
  const invitations = await db('event_invitations')
    .join('users', 'event_invitations.user_id', 'users.id')
    .where({ event_id: event.id, status: 'accepted' })
    .select('users.id', 'users.name', 'users.email');

  // Fetch all closed time sessions (lead-driven)
  const sessions = await db('time_sessions')
    .where({ event_id: event.id })
    .whereNotNull('stopped_at')
    .select('duration_minutes');
  const totalSessionMinutes = sessions.reduce((s, r) => s + (r.duration_minutes || 0), 0);

  // Fetch manual time entries per collaborator
  const manualEntries = await db('collaborator_time_entries')
    .where({ event_id: event.id })
    .select('user_id', 'minutes_worked');

  // Fetch approved expenses
  const expenses = await db('expenses')
    .where({ event_id: event.id, status: 'approved' })
    .select('user_id', 'type', 'amount_usd', 'hours_driven', 'is_passenger');

  // Fetch tips
  const tips = await db('collaborator_tips')
    .where({ event_id: event.id })
    .select('user_id', 'tip_amount', 'notes');

  const tipMap = Object.fromEntries(tips.map((t) => [t.user_id, t]));

  // Build per-collaborator breakdown
  const collaborators = invitations.map((user) => {
    // Manual time entries for this user
    const userManualMinutes = manualEntries
      .filter((e) => e.user_id === user.id)
      .reduce((s, e) => s + e.minutes_worked, 0);

    // All collaborators share session time equally (sessions are event-wide)
    // Session time is a shared pool — each collaborator gets credit for session hours
    const totalMinutes = totalSessionMinutes + userManualMinutes;
    const hours_worked = +(totalMinutes / 60).toFixed(4);
    const base_pay = +(hours_worked * hourlyRate).toFixed(2);

    // Driving expenses for this user
    const userExpenses = expenses.filter((e) => e.user_id === user.id);
    const driverHours = userExpenses
      .filter((e) => e.type === 'driving' && !e.is_passenger)
      .reduce((s, e) => s + parseFloat(e.hours_driven || 0), 0);
    const passengerHours = userExpenses
      .filter((e) => e.type === 'driving' && e.is_passenger)
      .reduce((s, e) => s + parseFloat(e.hours_driven || 0), 0);
    const driving_pay = +(
      driverHours * hourlyRate + passengerHours * (hourlyRate / 2)
    ).toFixed(2);

    // Material / other expenses
    const other_expenses = +userExpenses
      .filter((e) => e.type === 'material' || e.type === 'other')
      .reduce((s, e) => s + parseFloat(e.amount_usd || 0), 0)
      .toFixed(2);

    const tipRecord = tipMap[user.id];
    const tip = tipRecord ? +parseFloat(tipRecord.tip_amount).toFixed(2) : 0;
    const tip_notes = tipRecord ? tipRecord.notes : null;

    const total_owed = +(base_pay + driving_pay + other_expenses + tip).toFixed(2);

    return {
      user: { id: user.id, name: user.name, email: user.email },
      breakdown: {
        total_minutes: totalMinutes,
        hours_worked,
        hourly_rate: hourlyRate,
        base_pay,
        driving: {
          driver_hours: +driverHours.toFixed(4),
          passenger_hours: +passengerHours.toFixed(4),
          driving_pay,
        },
        other_expenses,
        tip,
        tip_notes,
        total_owed,
      },
    };
  });

  const grand_total = +collaborators
    .reduce((s, c) => s + c.breakdown.total_owed, 0)
    .toFixed(2);

  return {
    event: {
      id: event.id,
      title: event.title,
      status: event.status,
      hourly_rate: hourlyRate,
      event_date: event.event_date,
    },
    collaborators,
    grand_total,
    generated_at: new Date().toISOString(),
  };
}

module.exports = { computeEventSummary };
