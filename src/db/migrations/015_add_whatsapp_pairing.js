exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.string('whatsapp_phone').nullable().unique();
    table.string('whatsapp_pairing_code', 6).nullable();
    table.timestamp('whatsapp_pairing_expires_at').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('whatsapp_phone');
    table.dropColumn('whatsapp_pairing_code');
    table.dropColumn('whatsapp_pairing_expires_at');
  });
};
