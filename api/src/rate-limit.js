import rateLimit from 'express-rate-limit';
import { config } from './config.js';

// Throttles on the authentication routes. bcrypt at cost 10 is otherwise the
// only thing between an attacker and an unlimited guessing rate.
//
// Two limiters, because they catch different shapes of attack:
//
//   by IP        one machine working through a wordlist against any account
//   by username  a botnet spreading the same guesses for one account across
//                many addresses, where no single IP ever looks busy
//
// Neither replaces the other, and both are needed for the second to be worth
// having.

// Dev tools and rate limiting are switched by the same gate, deliberately.
//
// The limits exist to slow a password guesser down, and a development stack has
// nobody to guess against — while the things that get run against one all look
// like an attack: scripts/smoke-test.mjs registers a cast of accounts in
// seconds, scripts/season-test.mjs drives a whole season, and a page reloaded
// enough times while working on the login screen will exhaust a 20-attempt
// budget and lock the developer out of their own stack for fifteen minutes.
//
// This rides on config.devTools rather than a switch of its own because that
// gate is already the one that cannot be turned on in production: resolveDevTools
// returns false whenever NODE_ENV=production, whatever the environment asks for.
// A deployment therefore always throttles, and there is no new variable anyone
// can set on a server to disable it — which is exactly the mistake a separate
// RATE_LIMIT=false would invite.
const throttlingOff = () => config.devTools;

function tooMany(res, message) {
  // Matches the shape every other error takes, so the client's api() helper
  // surfaces it like any other failure.
  res.status(429).json({ error: message });
}

// Applied to /register and /login only — the two routes that check a password.
// The authenticated routes in that file (/me, /avatar, /sign-out-everywhere)
// deliberately do not share this budget: /me runs on every page load, so
// putting reads on a brute-force allowance locks members out of their own
// account for ordinary use.
export const authIpLimiter = rateLimit({
  windowMs: config.auth.windowMs,
  limit: config.auth.maxPerIp,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: throttlingOff,
  handler: (req, res) => tooMany(
    res,
    'Too many attempts from this address. Wait a few minutes and try again.',
  ),
});

// Keyed on the account being attempted rather than on where it comes from.
//
// Only failures count (skipSuccessfulRequests), which matters: a member typing
// their own password correctly all day never touches this, so the limit can
// stay tight without turning into a way to lock someone out of their account
// by burning their budget for them.
export const loginAccountLimiter = rateLimit({
  windowMs: config.auth.windowMs,
  limit: config.auth.maxPerAccount,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const login = typeof req.body?.login === 'string' ? req.body.login : '';
    // Lowercased so LOGIN and login share a bucket; usernames are
    // case-sensitive but an attacker should not get a fresh allowance by
    // changing the case.
    return `account:${login.trim().toLowerCase()}`;
  },
  // A request with no login in the body cannot be attributed to an account;
  // the IP limiter above still covers it.
  skip: (req) => throttlingOff() || !req.body?.login,
  handler: (req, res) => tooMany(
    res,
    'Too many failed attempts for this account. Wait a few minutes and try again.',
  ),
});
