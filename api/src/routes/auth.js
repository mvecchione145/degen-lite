import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, conflict, unauthorized } from '../http.js';
import {
  hashPassword, requireAuth, revokeSessions, signToken, verifyPassword,
} from '../auth.js';
import { authIpLimiter, loginAccountLimiter } from '../rate-limit.js';

const router = Router();

// Applied per route rather than with router.use, because it guards a specific
// thing: a password being checked. bcrypt at cost 10 is the only cost an
// attacker pays on /register and /login, so those two are throttled hard.
//
// The rest of this file already requires a valid JWT — /me, /avatar and
// /sign-out-everywhere are not guessing surfaces, and putting them on the same
// budget was actively harmful. /me runs on every page load, so a default of 20
// per 15 minutes locked members out of their own account for browsing, and any
// authenticated endpoint added here inherited the same trap.

const registerSchema = z.object({
  username: z.string().trim().min(3).max(50).regex(
    /^[A-Za-z0-9_.-]+$/,
    'Username may only contain letters, numbers, and . _ -',
  ),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  login: z.string().trim().min(1),
  password: z.string().min(1),
});

// One emoji, or null to clear it.
//
// Validated rather than taken as free text: the column renders straight into
// other members' leaderboards, so anything that is not an emoji — a username,
// a sentence, markup — would be someone writing arbitrary content into a row
// that is not theirs. The shape of an emoji is awkward to pin down: a flag is
// two regional indicators, a family is several pictographs joined by
// zero-width joiners, and a skin tone is a modifier. So the test is that the
// string is built *only* from the code points emoji are made of, and is short.
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|\u200d|\uFE0F)+$/u;

const avatarSchema = z.object({
  avatar_emoji: z.string().trim().max(24).nullable()
    .refine((v) => v === null || v === '' || EMOJI_ONLY.test(v),
      'Pick a single emoji')
    // A lone digit or '#' is Emoji_Component and would otherwise pass; a
    // keycap needs its combining mark to actually be one.
    .refine((v) => !v || /\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F/u.test(v),
      'Pick a single emoji')
    .transform((v) => (v === '' ? null : v)),
});

const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  email: user.email,
  avatar_emoji: user.avatar_emoji ?? null,
  // Read straight from the row rather than the token: a grant or revoke has
  // to take effect on the next request, not when a week-long JWT expires.
  can_create_pools: user.can_create_pools,
  created_at: user.created_at,
});

router.post('/register', authIpLimiter, asyncHandler(async (req, res) => {
  const { username, email, password } = registerSchema.parse(req.body);

  const { rows: existing } = await query(
    'SELECT 1 FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($2)',
    [username, email],
  );
  if (existing.length > 0) {
    throw conflict('That username or email is already registered');
  }

  const { rows } = await query(
    `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, $3) RETURNING *`,
    [username, email.toLowerCase(), await hashPassword(password)],
  );

  const user = rows[0];
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

router.post('/login', authIpLimiter, loginAccountLimiter, asyncHandler(async (req, res) => {
  const { login, password } = loginSchema.parse(req.body);

  const { rows } = await query(
    'SELECT * FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)',
    [login],
  );
  const user = rows[0];

  // Same message either way so the endpoint does not confirm which usernames exist.
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw unauthorized('Invalid credentials');
  }

  res.json({ token: signToken(user), user: publicUser(user) });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) throw unauthorized('User no longer exists');
  res.json({ user: publicUser(rows[0]) });
}));

// Ends every session for the account, this one included. There is no way to
// withdraw a signed token, so the account's token_version is bumped and every
// JWT carrying the old one stops verifying on its next request.
//
// Used by scripts/change-password.sh too, which bumps the same column: a
// password change should not leave a stolen session alive.
router.post('/sign-out-everywhere', requireAuth, asyncHandler(async (req, res) => {
  await revokeSessions(req.user.id);
  res.json({ signed_out: true });
}));

// Set or clear the emoji shown beside this member's name on leaderboards.
router.post('/avatar', requireAuth, asyncHandler(async (req, res) => {
  const { avatar_emoji: emoji } = avatarSchema.parse(req.body ?? {});

  const { rows } = await query(
    'UPDATE users SET avatar_emoji = $2 WHERE id = $1 RETURNING *',
    [req.user.id, emoji],
  );
  res.json({ user: publicUser(rows[0]) });
}));

export default router;
