
11. Orphaned comment and an inconsistent member count

Labels: chore

Two small things, fine to fold into one PR:

db/init/01-schema.sql:193 — the comment explaining why the games index is (league, season, week) rather than (season, week) was separated from that index by the pool_events block, and now reads as a preamble to the table. Move it back down to games_league_season_week_idx.
services/pools.js:108 — listPoolsForUser counts every pool_members row for member_count, including withdrawn ones, while wagerStandings and pickStandings both filter on withdrawn_at IS NULL. A pool card saying "8 members" over a leaderboard listing 7 is a small but repeatable contradiction. listMembers returns withdrawn members deliberately, with an ordering that puts them last — that one is correct as is.