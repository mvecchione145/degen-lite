
2. docs/mvp.md states the wrong default for INGEST_ENABLED

Labels: docs

docs/mvp.md:282 says:

| INGEST_ENABLED | false | Pull the real NFL schedule and scores from ESPN |

api/src/config.js has bool(process.env.INGEST_ENABLED, true), with a comment noting there is no synthetic fallback any more so it is on by default. The README and .env.example both agree it is on. Only this table says otherwise.

Consequential rather than cosmetic: a reader who trusts the table concludes the app ships with no games and goes looking for the switch that turns them on.
