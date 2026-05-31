exports.up = function (knex) {
  return knex.schema.createTable('time_sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('event_id').notNullable()
      .references('id').inTable('events').onDelete('CASCADE');
    table.uuid('started_by').notNullable()
      .references('id').inTable('users').onDelete('RESTRICT');
    table.uuid('stopped_by')
      .references('id').inTable('users').onDelete('SET NULL');
    // Client-provided timestamps — no server clock
    table.timestamp('started_at').notNullable();
    table.timestamp('stopped_at');
    // Computed and stored when session is stopped (in minutes)
    table.integer('duration_minutes');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('time_sessions');
};
