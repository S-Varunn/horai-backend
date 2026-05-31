exports.up = function (knex) {
  return knex.schema.createTable('event_invitations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('event_id').notNullable()
      .references('id').inTable('events').onDelete('CASCADE');
    table.uuid('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    table.enu('status', ['pending', 'accepted', 'declined']).notNullable().defaultTo('pending');
    // All timestamps are client-provided
    table.timestamp('invited_at');
    table.timestamp('responded_at');
    table.unique(['event_id', 'user_id']);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('event_invitations');
};
