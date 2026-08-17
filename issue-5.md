
5. README describes an NFL-only first boot; the default is now NFL + college

Labels: docs

README.md:22 says first boot pulls the current NFL regular season, "272 games across 18 weeks", and to give it about a minute.

config.js now defaults INGEST_LEAGUES to NFL,NCAAF. Per api/src/leagues.js, college adds 16 regular-season slates of up to 99 games each plus the postseason filed as week 17, so a default first boot ingests several times what the README describes and takes correspondingly longer.

.env.example documents the new default correctly and even explains how to narrow it back to NFL. The README was not updated to match.

While in there: the data-source table lower down says ESPN provides scores and SharpAPI provides lines, which is right, but does not mention that sharpPricing is false for NCAAF — college lines come from ESPN regardless of whether a key is present.
