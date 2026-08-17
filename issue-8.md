
8. /pools/:id/pending gives the commissioner the exposure #19 was written to hide

Labels: design, api

#19 removed at_risk from the standings payload, and services/leaderboard.js:52 explains why: a stake leaves the balance when placed, so publishing balances tells everyone how much a rival has committed before kickoff — "the other half of the same secret" the reveal rule protects. The field is dropped from the payload rather than hidden in the UI, on the grounds that anyone can read the API.

listPendingForCommissioner in services/bets.js withholds selection and line until kickoff, but returns username, stake, market, and the fixture for every live wager in the pool. The commissioner is a competitor — that is the stated premise of the whole pool_events audit trail — so this hands one player per-member exposure on every upcoming game, which is most of what #19 decided should not be visible.

Smaller version of the same thing: wagerStandings still returns a per-member pending count (leaderboard.js:42), which leaks how many wagers a rival has live even though the amount is now hidden.

Not obviously wrong — a commissioner may genuinely need this to act on a complaint — but it is worth deciding deliberately. Options:

Withhold stake until kickoff too, leaving the commissioner a list of who has live action on which fixture, which is enough to receive a complaint about it.
Or keep it and record the read in pool_events, so using the privilege is itself visible to the pool.
Drop pending from standings, or round it away.