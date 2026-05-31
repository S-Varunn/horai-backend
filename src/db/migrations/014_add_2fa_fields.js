exports.up = function (knex) {
  return knex.schema.alterTable('users', (table) => {
    table.boolean('two_factor_enabled').defaultTo(false);
    table.string('two_factor_code').nullable();
    table.timestamp('two_factor_expires_at').nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('users', (table) => {
    table.dropColumn('two_factor_enabled');
    table.dropColumn('two_factor_code');
    table.dropColumn('two_factor_expires_at');
  });
};
