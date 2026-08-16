// Everything that differs between the leagues we ingest, in one place.
//
// ESPN is the schedule of record for every league: it supplies fixtures, weeks,
// statuses and final scores, and — for games that have not finished — a spread
// and a total. SharpAPI, where it is available, replaces those lines with
// sportsbook numbers. See docs/data-sources.md.

export const LEAGUES = {
  NFL: {
    id: 'NFL',
    label: 'NFL',
    espnPath: 'football/nfl',
    espnParams: {},
    regularWeeks: 18,
    // The NFL postseason is not ingested today; pools run the regular season.
    postseason: null,
    // SharpAPI's slug is lowercase. Its /leagues endpoint is the authority —
    // the documentation site shows "NCAAF", but an uppercase league parameter
    // returns 200 with zero rows rather than an error.
    sharpLeague: 'nfl',
    sharpPricing: true,
    // 32 teams, every nickname distinct, and both feeds spell a team the same
    // way ("New England Patriots"), so a last-word fallback is safe here.
    nicknameFallback: true,
    // Wide enough to absorb timezone drift across a 16-game slate.
    kickoffToleranceHours: 48,
  },

  NCAAF: {
    id: 'NCAAF',
    label: 'College football',
    espnPath: 'football/college-football',
    // groups=80 is FBS. Without it ESPN returns only ranked matchups — 23
    // events instead of 96 — and the board silently shows a fifth of the slate.
    // limit=300 is headroom: a 99-game Saturday is close to the default page.
    espnParams: { groups: '80', limit: '300' },
    regularWeeks: 16,
    // The entire postseason — bowls and the CFP, mid-December into January —
    // lives in ESPN's seasontype=3 week 1. Stored as week 17 so 46 bowl games
    // do not land on the same board as September's week 1.
    postseason: { seasontype: 3, week: 1, storeAsWeek: 17 },
    sharpLeague: 'ncaaf',
    // Off deliberately. On a live free-tier key, /odds?league=ncaaf returns 200
    // with zero rows for every market, while nfl returns rows on the same key —
    // the tier lists the league but does not price it. The /events feed for
    // ncaaf is also polluted with mislabelled and prop-style entries
    // ("POR Fire @ SEA Storm"), so it is not a safe fallback either.
    // ESPN prices 98 of 99 games, which is what makes the league playable.
    // Flip this to true if the key is upgraded — the join below is ready.
    sharpPricing: false,
    // 230 teams and ten different Bulldogs: matching on the last word of a name
    // is a coin flip, so college joins on the full name only.
    nicknameFallback: false,
    // A 60-game Saturday leaves no room for a two-day window.
    kickoffToleranceHours: 12,
  },
};

export const LEAGUE_IDS = Object.keys(LEAGUES);
export const DEFAULT_LEAGUE = 'NFL';

export function leagueOrThrow(id) {
  const league = LEAGUES[id];
  if (!league) {
    throw new Error(`Unknown league "${id}". Known: ${LEAGUE_IDS.join(', ')}`);
  }
  return league;
}

// The weeks an ingest run should walk, in storage order. Each entry says which
// ESPN slate to ask for and which week number the rows are filed under — the
// two differ only for a postseason that ESPN crams into a single week.
export function ingestWeeks(league) {
  const weeks = [];
  for (let week = 1; week <= league.regularWeeks; week += 1) {
    weeks.push({ seasontype: 2, week, storeAsWeek: week });
  }
  if (league.postseason) {
    const { seasontype, week, storeAsWeek } = league.postseason;
    weeks.push({ seasontype, week, storeAsWeek });
  }
  return weeks;
}
