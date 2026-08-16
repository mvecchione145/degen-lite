import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDevTools } from '../src/config.js';

// resolveDevTools decides whether /api/admin is mounted and whether the
// Simulate results button is offered. Those routes fabricate final scores and
// force settlement, gated by nothing more than a valid login, so this is a
// security boundary rather than a convenience toggle.

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
