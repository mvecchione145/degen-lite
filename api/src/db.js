import pg from 'pg';
import { config } from './config.js';

// Every NUMERIC comes back as a JS number rather than a string. There are ten
// of them — stake, net, the four pool limits, stipend_amount, ledger amount,
// spread, total and line — and all are small enough that a double represents
// them exactly at the scales this app deals in.
//
// This is safe only because no money decision is made from these values in JS.
// Affordability, the per-selection cap, the minimum, grading and payouts are
// all decided in SQL, in exact NUMERIC; the parsed numbers exist to be
// displayed. Summing them in JS is the thing to avoid — do it in the query,
// the way listBets and listPoolBets both now do.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Compose waits for the container healthcheck, but Postgres briefly restarts
// after running its init scripts, so a connection can still be refused here.
export async function waitForDatabase({ attempts = 40, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await query('SELECT 1');
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function closeDatabase() {
  await pool.end().catch(() => {});
}
