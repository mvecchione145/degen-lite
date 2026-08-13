import cron from 'node-cron';
import { config, sharpEnabled } from './config.js';
import { closeDatabase, waitForDatabase } from './db.js';
import { closeCache, initCache } from './cache.js';
import { runSettlement } from './services/settlement.js';
import { applySharpLines, ingestSeason } from './services/ingest.js';

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
    const result = await ingestSeason(config.ingestSeason);
    if (result.skipped) {
      console.warn(`[worker] ingest skipped: ${result.skipped}`);
      return;
    }
    console.log(
      `[worker] ingest (${trigger}): ${result.games_upserted} games across `
      + `${result.weeks_ingested} weeks`
      + (result.errors.length ? `, ${result.errors.length} week(s) failed` : ''),
    );
    if (result.games_upserted > 0) await settle('post-ingest');
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
    const result = await applySharpLines();
    if (result.skipped) return;
    console.log(
      `[worker] odds (${trigger}): priced ${result.events_priced} events, `
      + `updated ${result.updated} of ${result.games_considered} open games`
      + (result.unmatched ? `, ${result.unmatched} unmatched` : '')
      + (result.served_from_cache ? ` (${result.served_from_cache} page(s) from cache)` : ''),
    );
  } catch (err) {
    // A line feed outage must not stop settlement — existing lines simply stand.
    console.error('[worker] odds refresh failed:', err.message);
  } finally {
    pricing = false;
  }
}

async function main() {
  await waitForDatabase();
  await initCache();
  console.log('[worker] started');
  console.log(`[worker] settlement cron: ${config.settlementCron}`);
  console.log(
    config.ingestEnabled
      ? `[worker] ingest cron: ${config.ingestCron} (season ${config.ingestSeason})`
      : '[worker] ingest disabled (set INGEST_ENABLED=true to pull live scores)',
  );
  console.log(
    sharpEnabled()
      ? `[worker] odds cron: ${config.oddsCron} `
        + `(SharpAPI, ${config.sharp.league}, ${config.sharp.requestsPerMinute} req/min)`
      : '[worker] odds disabled (no SHARP_API_KEY — lines stay as seeded)',
  );

  await settle('startup');
  await ingest('startup');
  await refreshOdds('startup');

  cron.schedule(config.settlementCron, () => settle('cron'));
  if (config.ingestEnabled) {
    cron.schedule(config.ingestCron, () => ingest('cron'));
  }
  if (sharpEnabled()) {
    cron.schedule(config.oddsCron, () => refreshOdds('cron'));
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
