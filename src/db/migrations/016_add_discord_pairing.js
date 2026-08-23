exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.string('discord_user_id').nullable().unique();
    table.string('discord_username').nullable();
    table.string('discord_pairing_code', 6).nullable();
    table.timestamp('discord_pairing_expires_at').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('discord_user_id');
    table.dropColumn('discord_username');
    table.dropColumn('discord_pairing_code');
    table.dropColumn('discord_pairing_expires_at');
  });
};
