exports.up = function (knex) {
  return knex.schema.createTable('organization_members', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('org_id').notNullable()
      .references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    table.timestamp('joined_at').defaultTo(knex.fn.now());
    table.unique(['org_id', 'user_id']);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('organization_members');
};
