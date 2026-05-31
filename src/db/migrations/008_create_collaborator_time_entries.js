exports.up = function (knex) {
  return knex.schema.createTable('collaborator_time_entries', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('event_id').notNullable()
      .references('id').inTable('events').onDelete('CASCADE');
    table.uuid('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    // Nullable — manual entries may not be tied to a session
    table.uuid('session_id')
      .references('id').inTable('time_sessions').onDelete('SET NULL');
    table.integer('minutes_worked').notNullable();
    table.text('notes');
    // Client-provided timestamp
    table.timestamp('entry_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('collaborator_time_entries');
};
