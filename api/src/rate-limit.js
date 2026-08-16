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
  skip: (req) => !req.body?.login,
  handler: (req, res) => tooMany(
    res,
    'Too many failed attempts for this account. Wait a few minutes and try again.',
  ),
});
