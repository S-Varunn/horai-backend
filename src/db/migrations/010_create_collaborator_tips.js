exports.up = function (knex) {
  return knex.schema.createTable('collaborator_tips', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('event_id').notNullable()
      .references('id').inTable('events').onDelete('CASCADE');
    table.uuid('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    // Organizer sets tip per collaborator individually
    table.decimal('tip_amount', 10, 2).notNullable().defaultTo(0);
    table.text('notes');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.unique(['event_id', 'user_id']);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('collaborator_tips');
};
