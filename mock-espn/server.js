import http from 'node:http';
import { createHash } from 'node:crypto';

// A stand-in for ESPN's scoreboard that plays a whole season in minutes.
//
// It speaks the same endpoint and returns the same payload shape the ingester
// already parses, so nothing in the app knows the difference — point ESPN_BASE
// at this and the real code path runs: the same URL building, the same
// toGameRow mapping, the same upsert, the same kickoff lock, the same
// settlement. A mock that the app has to be modified to accept would not be
// testing much.
//
// Time is the whole point. Kickoffs are real timestamps a few minutes apart
// rather than months, so a season's worth of state transitions —
// SCHEDULED → IN_PROGRESS → FINAL, bets locking, settlement paying out —
// happens while you watch. Nothing here has a clock of its own: every response
// is computed from the wall clock against a fixed season start, which means
// restarting this process does not lose the season's position.
//
// See docs/mock-season.md.

const PORT = Number(process.env.PORT || 3001);

// How long a "week" lasts. 18 NFL weeks at 300s is a 90-minute season.
const WEEK_SECONDS = Number(process.env.MOCK_WEEK_SECONDS || 300);

// How long a game stays IN_PROGRESS before it goes FINAL.
const GAME_SECONDS = Number(process.env.MOCK_GAME_SECONDS || Math.round(WEEK_SECONDS / 5));

// How long after boot week 1 kicks off. Without a lead-in the first fixtures
// are already live before anyone can open the board, and the first thing you
// would want to test — placing a bet — is unavailable. One week's worth by
// default, so the whole opening slate is bettable at startup.
const LEAD_SECONDS = Number(process.env.MOCK_LEAD_SECONDS || WEEK_SECONDS);

// The instant week 1 kicks off. Defaults to boot plus the lead-in, so a fresh
// container starts a fresh season; pin it to an ISO timestamp to replay one.
const SEASON_START = process.env.MOCK_SEASON_START
  ? new Date(process.env.MOCK_SEASON_START).getTime()
  : Date.now() + LEAD_SECONDS * 1000;

/* --------------------------------------------------------------- fixtures */

const NFL_TEAMS = [
  ['Arizona Cardinals', 'ARI'], ['Atlanta Falcons', 'ATL'],
  ['Baltimore Ravens', 'BAL'], ['Buffalo Bills', 'BUF'],
  ['Carolina Panthers', 'CAR'], ['Chicago Bears', 'CHI'],
  ['Cincinnati Bengals', 'CIN'], ['Cleveland Browns', 'CLE'],
  ['Dallas Cowboys', 'DAL'], ['Denver Broncos', 'DEN'],
  ['Detroit Lions', 'DET'], ['Green Bay Packers', 'GB'],
  ['Houston Texans', 'HOU'], ['Indianapolis Colts', 'IND'],
  ['Jacksonville Jaguars', 'JAX'], ['Kansas City Chiefs', 'KC'],
  ['Las Vegas Raiders', 'LV'], ['Los Angeles Chargers', 'LAC'],
  ['Los Angeles Rams', 'LAR'], ['Miami Dolphins', 'MIA'],
  ['Minnesota Vikings', 'MIN'], ['New England Patriots', 'NE'],
  ['New Orleans Saints', 'NO'], ['New York Giants', 'NYG'],
  ['New York Jets', 'NYJ'], ['Philadelphia Eagles', 'PHI'],
  ['Pittsburgh Steelers', 'PIT'], ['San Francisco 49ers', 'SF'],
  ['Seattle Seahawks', 'SEA'], ['Tampa Bay Buccaneers', 'TB'],
  ['Tennessee Titans', 'TEN'], ['Washington Commanders', 'WSH'],
];

// Deliberately includes the three abbreviations that broke homeSpread(): a
// mock season is the cheapest place to keep that regression honest.
const CFB_TEAMS = [
  ['Alabama Crimson Tide', 'ALA'], ['Georgia Bulldogs', 'UGA'],
  ['Ohio State Buckeyes', 'OSU'], ['Michigan Wolverines', 'MICH'],
  ['Texas Longhorns', 'TEX'], ['Texas A&M Aggies', 'TA&M'],
  ['Miami Hurricanes', 'MIA'], ['Miami (OH) RedHawks', 'M-OH'],
  ['Oregon Ducks', 'ORE'], ['Penn State Nittany Lions', 'PSU'],
  ['Notre Dame Fighting Irish', 'ND'], ['LSU Tigers', 'LSU'],
  ['Clemson Tigers', 'CLEM'], ['Florida State Seminoles', 'FSU'],
  ['Oklahoma Sooners', 'OU'], ['Tennessee Volunteers', 'TENN'],
  ['William & Mary Tribe', 'W&M'], ['Army Black Knights', 'ARMY'],
];

const LEAGUES = {
  'football/nfl': { id: 'nfl', teams: NFL_TEAMS, regularWeeks: 18, postseason: false },
  'football/college-football': {
    id: 'cfb', teams: CFB_TEAMS, regularWeeks: 16, postseason: true,
  },
};

/* ----------------------------------------------------------- determinism */

// Everything derived — pairings, lines, scores — comes from a hash of the
// game's identity, so the same season replays identically and a bug found at
// week 12 can be reproduced.
function seeded(key, min, max) {
  const digest = createHash('sha256').update(key).digest();
  const value = digest.readUInt32BE(0) / 0xffffffff;
  return min + Math.floor(value * (max - min + 1));
}

// Rotates the pairing each week so no two teams meet every time.
function weekPairings(league, week) {
  const teams = league.teams;
  const half = Math.floor(teams.length / 2);
  const rotated = [
    teams[0],
    ...teams.slice(1).slice(-((week - 1) % (teams.length - 1))),
    ...teams.slice(1).slice(0, teams.length - 1 - ((week - 1) % (teams.length - 1))),
  ];
  return Array.from({ length: half }, (_, i) => ({
    home: rotated[i],
    away: rotated[teams.length - 1 - i],
  }));
}

/* -------------------------------------------------------------- the clock */

// Games in a week are staggered across its first half so they do not all lock
// at once — the board should have a mix of open and closed fixtures, which is
// what makes the kickoff lock worth testing.
function kickoffFor(week, index, gamesInWeek) {
  const weekStart = SEASON_START + (week - 1) * WEEK_SECONDS * 1000;
  const spread = (WEEK_SECONDS * 1000) / 2;
  return weekStart + Math.round((index / Math.max(1, gamesInWeek)) * spread);
}

function stateFor(kickoffMs, now) {
  if (now < kickoffMs) return 'pre';
  if (now < kickoffMs + GAME_SECONDS * 1000) return 'in';
  return 'post';
}

/* ---------------------------------------------------------------- payload */

function buildEvents(leaguePath, season, seasontype, week) {
  const league = LEAGUES[leaguePath];
  if (!league) return [];

  // The postseason is one week's worth of fixtures, mirroring how ESPN packs
  // every bowl into seasontype=3 week 1.
  if (seasontype === 3) {
    if (!league.postseason || week !== 1) return [];
  } else if (seasontype !== 2 || week < 1 || week > league.regularWeeks) {
    return [];
  }

  // A postseason slate lands after the regular season on the same clock.
  const timelineWeek = seasontype === 3 ? league.regularWeeks + 1 : week;
  const pairings = weekPairings(league, seasontype === 3 ? 1 : week);
  const now = Date.now();

  return pairings.map((pair, index) => {
    const id = `${league.id}${season}${seasontype}${String(week).padStart(2, '0')}${String(index).padStart(2, '0')}`;
    const kickoffMs = kickoffFor(timelineWeek, index, pairings.length);
    const state = stateFor(kickoffMs, now);

    const [homeName, homeAbbrev] = pair.home;
    const [awayName, awayAbbrev] = pair.away;

    // Half-point lines only, so nothing pushes on the spread unless the total
    // does — a push is worth testing deliberately rather than by accident.
    const spread = seeded(`${id}:spread`, -14, 14) + 0.5;
    const total = seeded(`${id}:total`, 38, 54) + 0.5;
    const favourite = spread < 0 ? homeAbbrev : awayAbbrev;

    // Scores are built *from* the market rather than drawn independently, so
    // the final lands near the line: a favourite covers about half the time
    // and totals go over about half the time. Independent scores make every
    // favourite a losing bet and every total a coin flip on the wrong axis,
    // which is a poor rehearsal for settlement, leaderboards and busts.
    //
    // margin is the home team's winning margin. -spread is what the market
    // expects it to be; the noise is what makes the bet a bet.
    const margin = -spread + seeded(`${id}:margin`, -13, 13) + 0.5;
    const points = total + seeded(`${id}:points`, -10, 10) + 0.5;

    // One score is rounded and the other derived, so the two always sum to
    // exactly `points`. Rounding both halves independently pushes the sum a
    // point high whenever it splits oddly, which quietly biased totals over.
    const homeScore = Math.max(0, Math.round((points + margin) / 2));
    const awayScore = Math.max(0, points - homeScore);

    return {
      id,
      uid: `s:mock~e:${id}`,
      date: new Date(kickoffMs).toISOString(),
      name: `${awayName} at ${homeName}`,
      shortName: `${awayAbbrev} @ ${homeAbbrev}`,
      season: { year: season, type: seasontype },
      week: { number: week },
      competitions: [{
        id,
        date: new Date(kickoffMs).toISOString(),
        status: {
          type: {
            state,
            completed: state === 'post',
            description: { pre: 'Scheduled', in: 'In Progress', post: 'Final' }[state],
          },
        },
        odds: [{
          details: `${favourite} ${-Math.abs(spread)}`,
          overUnder: total,
          spread,
        }],
        competitors: [
          {
            homeAway: 'home',
            team: { displayName: homeName, abbreviation: homeAbbrev },
            score: state === 'pre' ? '0' : String(homeScore),
          },
          {
            homeAway: 'away',
            team: { displayName: awayName, abbreviation: awayAbbrev },
            score: state === 'pre' ? '0' : String(awayScore),
          },
        ],
      }],
    };
  });
}

/* ----------------------------------------------------------------- server */

function seasonPosition() {
  const elapsed = (Date.now() - SEASON_START) / 1000;
  return {
    season_start: new Date(SEASON_START).toISOString(),
    week_seconds: WEEK_SECONDS,
    game_seconds: GAME_SECONDS,
    elapsed_seconds: Math.round(elapsed),
    // Which week the clock is in. Below 1 during the lead-in, past the last
    // week once the season has played out.
    current_week: Math.floor(elapsed / WEEK_SECONDS) + 1,
    seconds_until_first_kickoff: Math.max(0, Math.round(-elapsed)),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // Where is the season up to? Useful on its own, and the readiness probe.
  if (url.pathname === '/status') return json(200, seasonPosition());

  const match = url.pathname.match(
    /^\/apis\/site\/v2\/sports\/(.+)\/scoreboard$/,
  );
  if (!match) return json(404, { error: 'Not found' });

  const leaguePath = match[1];
  const season = Number(url.searchParams.get('dates')) || new Date().getFullYear();
  const seasontype = Number(url.searchParams.get('seasontype') || 2);
  const week = Number(url.searchParams.get('week') || 1);

  const events = buildEvents(leaguePath, season, seasontype, week);

  console.log(
    `[mock-espn] ${leaguePath} season=${season} type=${seasontype} `
    + `week=${week} -> ${events.length} events`,
  );

  return json(200, {
    season: { year: season, type: seasontype },
    week: { number: week },
    events,
  });
});

server.listen(PORT, () => {
  const pos = seasonPosition();
  console.log(`[mock-espn] listening on ${PORT}`);
  console.log(
    `[mock-espn] week 1 kicks off ${pos.season_start} `
    + `(${pos.seconds_until_first_kickoff}s from now — bet before then)`,
  );
  console.log(
    `[mock-espn] a week lasts ${WEEK_SECONDS}s, a game runs ${GAME_SECONDS}s `
    + `— 18 weeks in ${Math.round((18 * WEEK_SECONDS) / 60)} minutes`,
  );
});
