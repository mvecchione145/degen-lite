import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, conflict, unauthorized } from '../http.js';
import {
  hashPassword, requireAuth, revokeSessions, signToken, verifyPassword,
} from '../auth.js';
import { authIpLimiter, loginAccountLimiter } from '../rate-limit.js';

const router = Router();

// Applies to every route in this file, including the session endpoints below.
router.use(authIpLimiter);

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

const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  email: user.email,
  // Read straight from the row rather than the token: a grant or revoke has
  // to take effect on the next request, not when a week-long JWT expires.
  can_create_pools: user.can_create_pools,
  created_at: user.created_at,
});

router.post('/register', asyncHandler(async (req, res) => {
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

router.post('/login', loginAccountLimiter, asyncHandler(async (req, res) => {
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

export default router;
