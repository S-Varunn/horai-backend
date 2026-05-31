exports.up = function (knex) {
  return knex.schema.createTable('expenses', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('event_id').notNullable()
      .references('id').inTable('events').onDelete('CASCADE');
    table.uuid('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    table.enu('type', ['material', 'driving', 'other']).notNullable();
    table.string('description');
    // For material / other
    table.decimal('amount_usd', 10, 2);
    // For driving — compensated at hourly_rate (driver) or hourly_rate/2 (passenger)
    table.decimal('hours_driven', 8, 2);
    table.boolean('is_passenger').notNullable().defaultTo(false);
    table.text('receipt_note');
    // Organizer review
    table.enu('status', ['pending', 'approved', 'rejected']).notNullable().defaultTo('pending');
    table.text('organizer_comment');
    // Client-provided timestamps
    table.timestamp('submitted_at');
    table.timestamp('reviewed_at');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('expenses');
};
