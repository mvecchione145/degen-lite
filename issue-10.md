
10. Login rate-limit gives one account two buckets

Labels: security, api

rate-limit.js:50 keys loginAccountLimiter on the submitted login string, lowercased. The comment correctly notes that case must not buy a fresh allowance.

But /login accepts a username or an email for the same account (routes/auth.js:92 matches on either). michael and michael@example.com therefore hash to different buckets, and an attacker alternating between them gets AUTH_MAX_PER_ACCOUNT attempts twice over. The IP limiter still applies, so this is a widening rather than a hole — but it is exactly the distributed case the account limiter exists to catch.

Suggested fix

Resolve the login to a user id before the limiter counts it, and key on that. That means a lookup on every attempt; alternatively key on the account row's id in a post-hoc penalty rather than a pre-request limiter. Simplest partial fix, if the lookup is unwanted: normalize an email to its local part when it matches a known user, or key both forms into one bucket by canonicalizing at the route.
