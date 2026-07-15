import { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wrap an async route handler so a rejected promise is forwarded to Express's
 * error-handling middleware instead of becoming an unhandled rejection (which
 * would crash the whole process). Every async handler should be wrapped in this.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
