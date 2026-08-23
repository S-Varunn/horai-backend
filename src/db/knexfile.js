const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

function getDatabaseConfig() {
  const dbUrl =
    process.env.DATABASE_URL ||
    process.env.DATABASE_PRIVATE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.POSTGRES_URL;

  if (dbUrl) {
    // Disable SSL for local connections or Railway internal private network
    const isInternal =
      dbUrl.includes('railway.internal') ||
      dbUrl.includes('localhost') ||
      dbUrl.includes('127.0.0.1') ||
      process.env.DB_SSL === 'false';

    if (isInternal) {
      return {
        connectionString: dbUrl,
        ssl: false,
      };
    }

    return {
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
    };
  }

  // Support Railway / standard Postgres environment variables (PGHOST, PGPORT, etc.)
  const host = process.env.DB_HOST || process.env.PGHOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || process.env.PGPORT || '5432', 10);
  const database = process.env.DB_NAME || process.env.PGDATABASE || 'horai_db';
  const user = process.env.DB_USER || process.env.PGUSER || 'postgres';
  const password = process.env.DB_PASSWORD || process.env.PGPASSWORD;

  const isLocal = host === 'localhost' || host === '127.0.0.1' || host.includes('railway.internal');

  return {
    host,
    port,
    database,
    user,
    password,
    ssl: isLocal || process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  };
}

/**
 * @type { import('knex').Knex.Config }
 */
module.exports = {
  development: {
    client: 'pg',
    connection: getDatabaseConfig(),
    migrations: {
      directory: './migrations',
      tableName: 'knex_migrations',
    },
    seeds: {
      directory: './seeds',
    },
  },

  test: {
    client: 'pg',
    connection: getDatabaseConfig(),
    migrations: {
      directory: './migrations',
      tableName: 'knex_migrations',
    },
  },

  production: {
    client: 'pg',
    connection: getDatabaseConfig(),
    migrations: {
      directory: './migrations',
      tableName: 'knex_migrations',
    },
    pool: { min: 2, max: 10 },
  },
};
