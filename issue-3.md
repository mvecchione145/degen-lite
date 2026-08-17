
3. GET /pools/public is documented but does not exist

Labels: docs

docs/mvp.md:216 lists:

| GET | /pools/public | Public pools the caller has not joined |

There is no such route in api/src/routes/pools.js, no service function behind it, and no is_public column or equivalent in db/init/01-schema.sql. Pools are joined by invite code only.

Either the endpoint was planned and cut, or it belongs in the roadmap section rather than the API reference. Remove it from the table, or move it under "Not built yet".
