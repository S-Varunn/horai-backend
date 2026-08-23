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
      await db.raw('SELECT 1');
      
      const [batchNo, log] = await db.migrate.latest({
        directory: __dirname + '/migrations',
        tableName: 'knex_migrations',
      });

      if (log.length > 0) {
        console.log(`[DB Migration] Applied Batch ${batchNo}:`, log);
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
