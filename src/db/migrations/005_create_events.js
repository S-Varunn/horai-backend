exports.up = function (knex) {
  return knex.schema.createTable('events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('org_id').notNullable()
      .references('id').inTable('organizations').onDelete('CASCADE');
    table.string('title').notNullable();
    table.text('description');
    // event_date is a client-provided timestamp (no server clock)
    table.timestamp('event_date').notNullable();
    table.decimal('hourly_rate', 10, 2).notNullable();
    table.enu('status', ['draft', 'scheduled', 'active', 'completed']).notNullable().defaultTo('draft');
    table.uuid('created_by').notNullable()
      .references('id').inTable('users').onDelete('RESTRICT');
    table.uuid('lead_collaborator_id')
      .references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('events');
};
