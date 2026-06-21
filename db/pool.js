const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Without this listener, an error on an idle client (e.g. the database
// being paused/restarted, or a network blip) is treated as an uncaught
// exception by Node and crashes the entire process. Logging it here lets
// the pool recover and keeps the API server alive.
pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});

module.exports = pool;