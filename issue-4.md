
4. Two live endpoints are missing from the API reference

Labels: docs

Present in the code, absent from the docs/mvp.md tables:

GET /pools/:poolId/history (routes/pools.js:300) — the paginated pool-wide bet history with filters, backed by listPoolBets. The board and bets endpoints are both documented; this one is not.
POST /auth/sign-out-everywhere (routes/auth.js:119) — worth documenting specifically because it is the only way to invalidate an issued JWT, and change-password.sh depends on the same mechanism.
