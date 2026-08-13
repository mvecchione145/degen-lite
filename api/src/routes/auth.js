import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, conflict, unauthorized } from '../http.js';
import { hashPassword, requireAuth, signToken, verifyPassword } from '../auth.js';

const router = Router();

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

router.post('/login', asyncHandler(async (req, res) => {
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

export default router;
