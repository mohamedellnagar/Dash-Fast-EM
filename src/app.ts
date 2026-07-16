import path from 'path';
import express, { Express, NextFunction, Request, Response } from 'express';
import session from 'express-session';
import { PrismaSessionStore } from '@quixo3/prisma-session-store';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { v4 as uuid } from 'uuid';
import { env } from './config/env';
import { prisma } from './db/prisma';
import { logger } from './lib/logger';
import { attachPrincipal } from './middleware/auth';
import { getAcademicYears } from './services/academic-years';
import { authRouter } from './routes/auth.routes';
import { dashboardRouter } from './routes/dashboard.routes';
import { apiRouter } from './routes/api.routes';
import { importRouter } from './routes/import.routes';
import { adminRouter } from './routes/admin.routes';
import { exportRouter } from './routes/export.routes';
import { healthRouter } from './routes/health.routes';
import { dashboardApiRouter } from './routes/dashboard-api.routes';
import { savedViewsRouter } from './routes/saved-views.routes';
import { attentionRouter } from './routes/attention.routes';
import { syncAdminRouter } from './routes/sync-admin.routes';
import { syncControlRouter } from './routes/sync-control.routes';
import { verifyRouter } from './routes/verify.routes';
import { usersRouter } from './routes/users.routes';
import { metricsRouter } from './routes/metrics.routes';

export function createApp(): Express {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1);

  // Correlation id per request for structured logs / tracing.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const cid = (req.headers['x-correlation-id'] as string) || uuid();
    res.setHeader('x-correlation-id', cid);
    (req as any).correlationId = cid;
    next();
  });

  app.use(pinoHttp({ logger, genReqId: (req) => (req as any).correlationId }));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"], // inline chart bootstrap only
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
        },
      },
    }),
  );
  app.use(compression());
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser(env.sessionSecret));

  app.use(
    session({
      name: 'ftsid',
      secret: env.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      // Durable DB-backed store: sessions survive process restarts / dev respawns
      // instead of being lost with the default in-memory MemoryStore.
      store: new PrismaSessionStore(prisma as any, {
        checkPeriod: 10 * 60 * 1000, // prune expired sessions every 10 min
        dbRecordIdIsSessionId: true,
      }),
      cookie: {
        httpOnly: true,
        secure: env.sessionSecureCookie,
        sameSite: 'lax',
        maxAge: env.sessionMaxAgeMs,
      },
    }),
  );

  // Global rate limit (per IP) to blunt abuse; login has a stricter limiter.
  app.use(
    rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }),
  );

  app.use(express.static(path.join(__dirname, 'public')));
  app.use(attachPrincipal);

  // Global Academic Year filter: apply the session-selected year to every page
  // (unless the request overrides it via ?academicYear=). Exposes the year list
  // + selection to all views for the nav selector.
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const session = (req as any).session;
    if (!req.query.academicYear && session?.academicYear) req.query.academicYear = session.academicYear;
    if (!req.query.programType && session?.programType) req.query.programType = session.programType;
    res.locals.selectedYear = (req.query.academicYear as string) || '';
    res.locals.selectedProgram = (req.query.programType as string) || '';
    res.locals.programTypes = ['SPA', 'ABA'];
    try {
      res.locals.academicYears = await getAcademicYears();
    } catch {
      res.locals.academicYears = [];
    }
    next();
  });

  // Set / clear the global Academic Year and return to the previous page.
  app.get('/prefs/academic-year', (req: Request, res: Response) => {
    const y = String(req.query.year ?? '').trim();
    (req as any).session.academicYear = y || undefined;
    res.redirect(req.get('referer') || '/monitoring');
  });

  // Set / clear the global Program (SPA/ABA) filter.
  app.get('/prefs/program', (req: Request, res: Response) => {
    const p = String(req.query.program ?? '').trim().toUpperCase();
    (req as any).session.programType = ['SPA', 'ABA'].includes(p) ? p : undefined;
    res.redirect(req.get('referer') || '/monitoring');
  });

  // Health checks (no auth) + token-gated metrics
  app.use('/', healthRouter);
  app.use('/', metricsRouter);

  // Auth pages
  app.use('/', authRouter);

  // JSON API
  app.use('/api', apiRouter);
  app.use('/api/dashboard', dashboardApiRouter);
  app.use('/api/saved-views', savedViewsRouter);

  // Mixed page + API routers (attention/export register their own /api paths)
  app.use('/', attentionRouter);
  app.use('/', exportRouter);
  app.use('/', syncAdminRouter);
  app.use('/', syncControlRouter);
  app.use('/', verifyRouter);

  // Server-rendered pages
  app.use('/', importRouter);
  app.use('/', adminRouter);
  app.use('/', usersRouter);
  app.use('/', dashboardRouter);

  // 404
  app.use((req: Request, res: Response) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    res.status(404).render('error', { title: 'Not found', message: 'Page not found', principal: req.principal ?? null });
  });

  // Error handler
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message, stack: err.stack, cid: (req as any).correlationId }, 'unhandled error');
    if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Internal server error' });
    res.status(500).render('error', { title: 'Error', message: 'An unexpected error occurred', principal: req.principal ?? null });
  });

  return app;
}
