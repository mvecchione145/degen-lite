import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { query } from './db.js';
import { unauthorized } from './http.js';

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export function signToken(user) {
  return jwt.sign(
    // tv is the account's token_version at the moment of signing. requireAuth
    // compares it against the current row, which is what makes a session
    // endable — a signed token cannot otherwise be withdrawn.
    { sub: user.id, username: user.username, tv: user.token_version ?? 0 },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

function readToken(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

// Verifying the signature is not enough on its own: it proves the token was
// issued, not that it is still meant to work. The extra lookup is one indexed
// primary-key read per authenticated request, which buys a session that can
// actually be ended — after a password change, or a leak.
export async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return next(unauthorized());

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(unauthorized('Invalid or expired token'));
  }

  try {
    const { rows } = await query(
      'SELECT token_version FROM users WHERE id = $1',
      [payload.sub],
    );
    if (!rows[0]) return next(unauthorized('User no longer exists'));

    // A token minted before the last bump is refused. Tokens signed before
    // this claim existed carry no tv and are treated as version 0, so the
    // upgrade does not sign everyone out on deploy.
    if ((payload.tv ?? 0) !== rows[0].token_version) {
      return next(unauthorized('Session ended, please sign in again'));
    }

    req.user = { id: payload.sub, username: payload.username };
    return next();
  } catch (err) {
    return next(err);
  }
}

// Ends every session for an account, including the one asking. Returns the new
// version so a caller can mint a replacement token if it wants to stay in.
export async function revokeSessions(userId) {
  const { rows } = await query(
    `UPDATE users SET token_version = token_version + 1
      WHERE id = $1 RETURNING token_version`,
    [userId],
  );
  return rows[0]?.token_version ?? null;
}
