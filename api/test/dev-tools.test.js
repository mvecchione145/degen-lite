import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDevTools } from '../src/config.js';

// resolveDevTools decides whether /api/admin is mounted, whether the Simulate
// results button is offered, and whether the auth rate limits apply. Those
// routes fabricate final scores and force settlement, gated by nothing more
// than a valid login, and the limits are what stand between an attacker and an
// unlimited password guessing rate — so this is a security boundary rather than
// a convenience toggle.

test('production wins over DEV_TOOLS, however it is set', () => {
  // The case that matters: a stray DEV_TOOLS=true in a server .env.
  assert.equal(resolveDevTools({ NODE_ENV: 'production', DEV_TOOLS: 'true' }), false);
  assert.equal(resolveDevTools({ NODE_ENV: 'production', DEV_TOOLS: '1' }), false);
  assert.equal(resolveDevTools({ NODE_ENV: 'production' }), false);
});

test('outside production DEV_TOOLS decides, defaulting on', () => {
  assert.equal(resolveDevTools({}), true);
  assert.equal(resolveDevTools({ NODE_ENV: 'development' }), true);
  assert.equal(resolveDevTools({ NODE_ENV: 'development', DEV_TOOLS: 'false' }), false);
  assert.equal(resolveDevTools({ NODE_ENV: 'test', DEV_TOOLS: 'true' }), true);
});

test('an unset compose variable arrives as empty and means the default', () => {
  // docker compose substitutes an unset ${VAR} as '', not as absent.
  assert.equal(resolveDevTools({ DEV_TOOLS: '' }), true);
  assert.equal(resolveDevTools({ NODE_ENV: '', DEV_TOOLS: '' }), true);
});

test('only an exact production value counts', () => {
  // Guards against a loose startsWith or truthiness check creeping in.
  assert.equal(resolveDevTools({ NODE_ENV: 'production-like', DEV_TOOLS: 'true' }), true);
  assert.equal(resolveDevTools({ NODE_ENV: 'Production', DEV_TOOLS: 'true' }), true);
});

// The auth rate limits skip on config.devTools (api/src/rate-limit.js), so
// every case above is also a statement about whether login can be brute
// forced. Pinned separately: someone reading resolveDevTools as "is the admin
// router mounted" could reasonably widen it, and the blast radius is larger
// than that name suggests.
test('rate limiting is on wherever dev tools are off', () => {
  const throttles = (env) => !resolveDevTools(env);

  // Production, by every route into it.
  assert.equal(throttles({ NODE_ENV: 'production' }), true);
  assert.equal(throttles({ NODE_ENV: 'production', DEV_TOOLS: 'true' }), true);

  // And a non-production deployment that asked for the limits explicitly.
  assert.equal(throttles({ NODE_ENV: 'staging', DEV_TOOLS: 'false' }), true);

  // A development stack does not throttle: smoke-test.mjs and season-test.mjs
  // both register a cast of accounts faster than any human, and a developer
  // reloading the login screen should not lock themselves out for 15 minutes.
  assert.equal(throttles({}), false);
  assert.equal(throttles({ NODE_ENV: 'development' }), false);
});
