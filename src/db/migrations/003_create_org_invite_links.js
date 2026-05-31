exports.up = function (knex) {
  return knex.schema.createTable('org_invite_links', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('org_id').notNullable()
      .references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('invite_code').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('created_by').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('expires_at').notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('org_invite_links');
};
