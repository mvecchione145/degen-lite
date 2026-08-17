import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, conflict, unauthorized } from '../http.js';
import {
  hashPassword, requireAuth, revokeSessions, signToken, verifyPassword,
} from '../auth.js';
import { authIpLimiter, loginAccountLimiter } from '../rate-limit.js';
import { cacheDel, leaderboardKey } from '../cache.js';

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

// What other members see. Free text, unlike the username, which stays the login
// handle and keeps its character restrictions — a display name is allowed
// spaces and punctuation because it is a name, not an identifier.
//
// It is not unique: two people may both be Mike. Taking a name that is already
// somebody else's *username* is refused though, because the commissioner log
// and the standings name people, and a member who renames themselves to another
// account's handle is impersonating them rather than colliding with them.
const displayNameSchema = z.string().trim().min(1).max(50)
  // Control characters would let a name break the line it renders on, and a
  // name that is only whitespace reads as blank while not being null.
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'That is not a usable name')
  .nullable()
  .transform((v) => (v === '' ? null : v));

const profileSchema = z.object({
  display_name: displayNameSchema.optional(),
  avatar_emoji: z.string().trim().max(24).nullable()
    .refine((v) => v === null || v === '' || EMOJI_ONLY.test(v),
      'Pick a single emoji')
    // A lone digit or '#' is Emoji_Component and would otherwise pass; a
    // keycap needs its combining mark to actually be one.
    .refine((v) => !v || /\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F/u.test(v),
      'Pick a single emoji')
    .transform((v) => (v === '' ? null : v))
    .optional(),
});

const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  email: user.email,
  // Raw, so the editor can tell "not set" from "set to my username". Every
  // display surface gets the resolved name from its own query instead.
  display_name: user.display_name ?? null,
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

// How this member appears to the rest of a pool: the name beside their result,
// and the emoji beside that. One endpoint because they are one dialog, and
// because a caller that sends neither should not be a special case.
//
// Absent means "leave alone" and null means "clear", which is why the fields
// are optional *and* nullable rather than one or the other.
router.post('/profile', requireAuth, asyncHandler(async (req, res) => {
  const body = profileSchema.parse(req.body ?? {});

  if (body.display_name) {
    const { rows: taken } = await query(
      'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2',
      [body.display_name, req.user.id],
    );
    if (taken.length > 0) {
      throw conflict('That is another member\'s username. Pick a different name.');
    }
  }

  const { rows } = await query(
    `UPDATE users
        SET display_name = CASE WHEN $2::BOOLEAN THEN $3 ELSE display_name END,
            avatar_emoji = CASE WHEN $4::BOOLEAN THEN $5 ELSE avatar_emoji END
      WHERE id = $1
      RETURNING *`,
    [
      req.user.id,
      'display_name' in body, body.display_name ?? null,
      'avatar_emoji' in body, body.avatar_emoji ?? null,
    ],
  );
  // Standings are cached for 30 seconds and carry the resolved name and emoji,
  // so without this a member who renames themselves keeps their old name in
  // front of the pool until the entry expires. Every pool they belong to is
  // affected, not just the one they happen to be looking at.
  const { rows: pools } = await query(
    'SELECT pool_id FROM pool_members WHERE user_id = $1',
    [req.user.id],
  );
  await cacheDel(...pools.map((p) => leaderboardKey(p.pool_id)));

  res.json({ user: publicUser(rows[0]) });
}));

export default router;
