import pino from 'pino';
import { env } from '../config/env';

// Fields that must never appear in logs. Values are redacted by pino.
const REDACT_PATHS = [
  'password',
  'pwd',
  'apiKey',
  'restApiKey',
  'apiToken',
  'token',
  'accessToken',
  'passwordHash',
  '*.password',
  '*.pwd',
  '*.apiKey',
  '*.apiToken',
  'req.headers.authorization',
  'req.headers.cookie',
];

export const logger = pino({
  level: env.logLevel,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: { service: 'fasttest-dashboard' },
  transport: env.isProd
    ? undefined
    : { target: 'pino/file', options: { destination: 1 } }, // stdout, no pretty dep required
});

export type Logger = typeof logger;
