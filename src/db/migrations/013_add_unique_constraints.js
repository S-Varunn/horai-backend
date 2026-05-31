exports.up = async function (knex) {
  // Organizations must have unique names
  await knex.schema.alterTable('organizations', (table) => {
    table.unique('name');
  });

  // Events must have unique titles per organization
  await knex.schema.alterTable('events', (table) => {
    table.unique(['org_id', 'title']);
  });

  // Users must have unique names (Collaborators/Organizers)
  await knex.schema.alterTable('users', (table) => {
    table.unique('name');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropUnique('name');
  });

  await knex.schema.alterTable('events', (table) => {
    table.dropUnique(['org_id', 'title']);
  });

  await knex.schema.alterTable('organizations', (table) => {
    table.dropUnique('name');
  });
};
