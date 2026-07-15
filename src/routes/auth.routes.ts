import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../services/auth.service';
import { audit } from '../services/audit.service';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

authRouter.get('/login', (req, res) => {
  if (req.principal) return res.redirect('/monitoring');
  res.render('login', { title: 'Sign in', error: null, principal: null });
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).render('login', { title: 'Sign in', error: 'Invalid input', principal: null });
  }
  const { email, password } = parsed.data;
  const result = await authenticate(email, password);
  if (!result.ok) {
    await audit({ actorEmail: email, action: 'LOGIN_FAILED', ipAddress: req.ip, detail: result.reason });
    return res.status(401).render('login', { title: 'Sign in', error: 'Invalid credentials', principal: null });
  }
  req.session.userId = result.userId;
  await audit({ userId: result.userId, actorEmail: email, action: 'LOGIN', ipAddress: req.ip });
  res.redirect('/monitoring');
});

authRouter.post('/logout', async (req, res) => {
  const email = req.principal?.email;
  const userId = req.principal?.userId;
  req.session.destroy(async () => {
    await audit({ userId, actorEmail: email, action: 'LOGOUT', ipAddress: req.ip });
    res.redirect('/login');
  });
});
