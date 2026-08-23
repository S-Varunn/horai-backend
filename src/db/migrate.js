const knex = require('knex');
const config = require('./knexfile');

const env = process.env.NODE_ENV || 'production';
const dbConfig = config[env] || config.production;
const db = knex(dbConfig);

async function runMigrations() {
  const maxRetries = 10;
  const retryIntervalMs = 2000;

  console.log(`[DB Migration] Running migrations for environment: "${env}"...`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[DB Migration] Connecting to database (Attempt ${attempt}/${maxRetries})...`);
      await db.raw('SELECT 1');
      console.log(`[DB Migration] Database connected successfully! Running knex.migrate.latest()...`);
      
      const [batchNo, log] = await db.migrate.latest({
        directory: __dirname + '/migrations',
        tableName: 'knex_migrations',
      });

      if (log.length === 0) {
        console.log(`[DB Migration] Database schema is already up to date.`);
      } else {
        console.log(`[DB Migration] Successfully applied Batch ${batchNo}:`, log);
      }

      await db.destroy();
      process.exit(0);
    } catch (err) {
      console.warn(`[DB Migration] Connection attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) {
        console.error(`[DB Migration] ❌ Max connection retries reached. Exiting.`);
        console.error(err);
        process.exit(1);
      }
      console.log(`[DB Migration] Retrying in ${retryIntervalMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
    }
  }
}

runMigrations();
