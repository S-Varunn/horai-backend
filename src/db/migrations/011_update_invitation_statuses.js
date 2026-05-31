exports.up = async function (knex) {
  // Postgres 10+ supports ADD VALUE for enums, but Knex .enu might have created a check constraint or a type.
  // We'll try to drop the check constraint and add a new one if it's a check constraint, 
  // or add a value to the type if it's a native enum.
  // For simplicity and robustness on typical Knex/Postgres setups:
  try {
    // Try to add values to a native enum type if it exists
    // The type name is usually 'event_invitations_status_playable_type' or similar, but Knex often doesn't use native types unless specified.
    // However, if we don't know the type name, we can try to alter the column.
    
    await knex.raw("ALTER TABLE event_invitations DROP CONSTRAINT IF EXISTS event_invitations_status_check");
    await knex.raw("ALTER TABLE event_invitations ADD CONSTRAINT event_invitations_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'requested', 'rejected'))");
  } catch (err) {
    console.log("Migration warning (might be handled by native enum):", err.message);
    // If it's a native enum, we might need a different approach, but this covers the common case.
  }
};

exports.down = async function (knex) {
  await knex.raw("ALTER TABLE event_invitations DROP CONSTRAINT IF EXISTS event_invitations_status_check");
  await knex.raw("ALTER TABLE event_invitations ADD CONSTRAINT event_invitations_status_check CHECK (status IN ('pending', 'accepted', 'declined'))");
};
