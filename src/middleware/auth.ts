import { NextFunction, Request, Response } from 'express';
import { PermissionKey } from '../lib/enums';
import { AuthPrincipal, loadPrincipal } from '../services/rbac.service';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    academicYear?: string; // global Academic Year filter (project-wide)
    programType?: string; // global Program (SPA/ABA) filter (project-wide)
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: AuthPrincipal;
    }
  }
}

/** Populate req.principal from the session (if logged in). Non-blocking. */
export async function attachPrincipal(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (req.session?.userId) {
    const principal = await loadPrincipal(req.session.userId);
    if (principal) req.principal = principal;
    else req.session.destroy(() => undefined); // stale/disabled user
  }
  next();
}

function wantsJson(req: Request): boolean {
  // req.path is relative to the router mount; use originalUrl for the /api check.
  return req.originalUrl.startsWith('/api') || req.headers.accept?.includes('application/json') === true;
}

/** Require an authenticated session. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.principal) {
    if (wantsJson(req)) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    res.redirect('/login');
    return;
  }
  next();
}

/** Require a specific permission (implies auth). */
export function requirePermission(permission: PermissionKey) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.principal) {
      if (wantsJson(req)) res.status(401).json({ error: 'Authentication required' });
      else res.redirect('/login');
      return;
    }
    if (!req.principal.permissions.has(permission)) {
      if (wantsJson(req)) res.status(403).json({ error: 'Forbidden', required: permission });
      else res.status(403).render('error', { title: 'Forbidden', message: 'You do not have access to this page.', principal: req.principal });
      return;
    }
    next();
  };
}

/**
 * For school-scoped users, return the list of school ids they may see.
 * Returns undefined for unrestricted users (no school filter applied).
 */
export function schoolScopeFor(principal: AuthPrincipal): string[] | undefined {
  if (principal.isSchoolScoped) return principal.schoolScopeIds.length ? principal.schoolScopeIds : ['__none__'];
  return undefined;
}
