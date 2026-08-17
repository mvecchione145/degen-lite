
7. Config table omits six variables, including one used in its own example

Labels: docs

Missing from the docs/mvp.md configuration table:

INGEST_CRON — conspicuous, because the worked multi-cadence example immediately below the table is written in terms of it
INGEST_LEAGUES
ESPN_BASE — the hook for mock-espn/, referenced by docs/mock-season.md
TRUST_PROXY_HOPS — documented in docs/deploy-ec2.md:65 but not here, and getting it wrong silently collapses per-IP rate limiting into one bucket
AUTH_WINDOW_MS, AUTH_MAX_PER_IP, AUTH_MAX_PER_ACCOUNT
JWT_EXPIRES_IN

.env.example is also missing the auth and proxy variables, though it is otherwise current.
