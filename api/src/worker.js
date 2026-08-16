import cron from 'node-cron';
import { config, sharpEnabled } from './config.js';
import { closeDatabase, waitForDatabase } from './db.js';
import { closeCache, initCache } from './cache.js';
import { runSettlement } from './services/settlement.js';
import { applySharpLines, ingestConfiguredLeagues } from './services/ingest.js';
import { LEAGUES } from './leagues.js';

// Stands in for the EventBridge-driven scheduled tasks in docs/architecture.md.
// Same image as the API, different entrypoint — mirroring one ECS task
// definition per job.

let settling = false;
let ingesting = false;
let pricing = false;

async function settle(trigger) {
  if (settling) return;
  settling = true;
  try {
    const result = await runSettlement();
    const changed = result.bets_settled + result.bets_voided + result.stipends_granted
      + result.members_busted + result.picks_graded + result.members_eliminated;
    if (changed > 0) {
      console.log(
        `[worker] settlement (${trigger}): `
        + `${result.bets_settled} bets settled, ${result.bets_voided} voided, `
        + `${result.stipends_granted} stipends, ${result.members_busted} bust, `
        + `${result.picks_graded} picks graded, `
        + `${result.members_eliminated} eliminated`,
      );
    }
  } catch (err) {
    console.error('[worker] settlement failed:', err.message);
  } finally {
    settling = false;
  }
}

async function ingest(trigger) {
  if (!config.ingestEnabled || ingesting) return;
  ingesting = true;
  try {
    const runs = await ingestConfiguredLeagues(config.ingestSeason);
    let upserted = 0;
    for (const result of runs) {
      if (result.skipped) {
        console.warn(`[worker] ingest skipped (${result.league}): ${result.skipped}`);
        continue;
      }
      upserted += result.games_upserted;
      console.log(
        `[worker] ingest (${trigger}, ${result.league}): `
        + `${result.games_upserted} games across ${result.weeks_ingested} weeks`
        + (result.errors.length ? `, ${result.errors.length} week(s) failed` : ''),
      );
    }
    if (upserted > 0) await settle('post-ingest');
  } catch (err) {
    console.error('[worker] ingest failed:', err.message);
  } finally {
    ingesting = false;
  }
}

// Refreshes spreads and totals from SharpAPI. Independent of score ingestion:
// SharpAPI has no scores, so lines and results come from different providers on
// different schedules.
async function refreshOdds(trigger) {
  if (!sharpEnabled() || pricing) return;
  pricing = true;
  try {
    for (const league of config.ingestLeagues) {
      const result = await applySharpLines(league);
      if (result.skipped) {
        console.log(`[worker] odds (${trigger}, ${league}): ${result.skipped}`);
        continue;
      }
      console.log(
        `[worker] odds (${trigger}, ${result.league}): `
        + `priced ${result.events_priced} events, updated ${result.updated} `
        + `of ${result.games_considered} open games`
        + (result.unmatched ? `, ${result.unmatched} unmatched` : '')
        + (result.truncated ? ', FEED TRUNCATED' : '')
        + (result.served_from_cache ? ` (${result.served_from_cache} page(s) from cache)` : ''),
      );
    }
  } catch (err) {
    // A line feed outage must not stop settlement — existing lines simply stand.
    console.error('[worker] odds refresh failed:', err.message);
  } finally {
    pricing = false;
  }
}

// Registers every expression a *_CRON carries against the same job. Two
// schedules firing at once is harmless — each job holds a re-entrancy flag and
// the second call returns immediately — so overlapping ranges cost nothing
// beyond a skipped tick.
function schedule(exprs, job, name) {
  for (const expr of exprs) {
    // node-cron throws on a bad expression, but from inside schedule() the
    // message never says which of several it choked on.
    if (!cron.validate(expr)) {
      throw new Error(`[worker] invalid ${name} cron expression: "${expr}"`);
    }
    cron.schedule(expr, () => job('cron'), { timezone: config.cronTimezone });
  }
}

async function main() {
  await waitForDatabase();
  await initCache();
  console.log('[worker] started');
  console.log(`[worker] cron timezone: ${config.cronTimezone}`);
  const show = (exprs) => exprs.map((e) => `"${e}"`).join(' + ');
  console.log(`[worker] settlement cron: ${show(config.settlementCron)}`);
  console.log(
    config.ingestEnabled
      ? `[worker] ingest cron: ${show(config.ingestCron)} `
        + `(season ${config.ingestSeason}, leagues ${config.ingestLeagues.join('+')})`
      : '[worker] ingest disabled (set INGEST_ENABLED=true to pull live scores)',
  );
  console.log(
    sharpEnabled()
      ? `[worker] odds cron: ${show(config.oddsCron)} `
        + `(SharpAPI, ${config.ingestLeagues.filter((l) => LEAGUES[l]?.sharpPricing).join('+') || 'no priced league'}, `
        + `${config.sharp.requestsPerMinute} req/min)`
      : '[worker] odds disabled (no SHARP_API_KEY — lines stay as seeded)',
  );

  // Order matters on a first boot: pull the schedule, price it, then settle
  // anything already final. Reversing it would settle against an empty table.
  await ingest('startup');
  await refreshOdds('startup');
  await settle('startup');

  schedule(config.settlementCron, settle, 'settlement');
  if (config.ingestEnabled) {
    schedule(config.ingestCron, ingest, 'ingest');
  }
  if (sharpEnabled()) {
    schedule(config.oddsCron, refreshOdds, 'odds');
  }

  const shutdown = async () => {
    console.log('[worker] shutting down');
    await closeCache();
    await closeDatabase();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[worker] failed to start:', err);
  process.exit(1);
});
