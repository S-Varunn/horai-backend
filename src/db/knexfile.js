require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * @type { import('knex').Knex.Config }
 */
module.exports = {
  development: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'horai_db',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
    },
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
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'horai_db',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
    },
    migrations: {
      directory: './migrations',
      tableName: 'knex_migrations',
    },
  },

  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL
      ? {
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
        }
      : {
          host: process.env.DB_HOST,
          port: parseInt(process.env.DB_PORT) || 5432,
          database: process.env.DB_NAME,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
        },
    migrations: {
      directory: './migrations',
      tableName: 'knex_migrations',
    },
    pool: { min: 2, max: 10 },
  },
};
