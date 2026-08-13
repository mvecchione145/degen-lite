// Lines and prices.
//
// Lines are synthetic today — generated with the demo season — but a sportsbook
// odds API is the intended source. Everything that needs a line reads it through
// here, and every bet copies the line onto itself at placement, so swapping the
// provider can never disturb settled history.

// Every market is priced -110. While that is true the price is code, not data,
// but it is still recorded on each bet so varying prices later become a pricing
// change rather than a migration.
export const STANDARD_PRICE = -110;

export const MARKETS = {
  SPREAD: { selections: ['HOME', 'AWAY'] },
  TOTAL: { selections: ['OVER', 'UNDER'] },
};

export function lineFor(game, market) {
  return market === 'SPREAD' ? game.spread : game.total;
}

// Profit on a winning stake at American odds, rounded to the nearest cent —
// the same rule as bet_profit() in SQL. Used only for previews; every stored
// figure is computed by the database in exact NUMERIC arithmetic.
export function previewProfit(stake, price = STANDARD_PRICE) {
  const raw = price < 0 ? (stake * 100) / Math.abs(price) : (stake * price) / 100;
  return Math.round(raw * 100) / 100;
}

export function formatLine(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 'PK';
  return n > 0 ? `+${n}` : `${n}`;
}

// "Bills -3.5" / "Over 47.5" — the label a member sees when confirming a bet.
export function describeSelection(game, market, selection) {
  if (market === 'TOTAL') {
    return `${selection === 'OVER' ? 'Over' : 'Under'} ${game.total}`;
  }
  const team = selection === 'HOME' ? game.home_team : game.away_team;
  const line = selection === 'HOME' ? game.spread : -game.spread;
  return `${team} ${formatLine(line)}`;
}
