exports.up = function (knex) {
  return knex.schema.alterTable('time_sessions', (table) => {
    table.string('title').nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('time_sessions', (table) => {
    table.dropColumn('title');
  });
};
