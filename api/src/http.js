export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new ApiError(400, msg, details);
export const unauthorized = (msg = 'Authentication required') => new ApiError(401, msg);
export const forbidden = (msg = 'Not allowed') => new ApiError(403, msg);
export const notFoundError = (msg = 'Not found') => new ApiError(404, msg);
export const conflict = (msg) => new ApiError(409, msg);

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
  if (err?.name === 'ZodError') {
    return res.status(400).json({
      error: 'Invalid request body',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err?.code === '23505') {
    return res.status(409).json({ error: 'That value is already taken' });
  }
  console.error('[api] unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error' });
}
