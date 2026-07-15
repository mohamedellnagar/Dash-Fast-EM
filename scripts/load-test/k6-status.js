// FastTest status-endpoint load test (k6).
//
// SAFETY: This is DISABLED unless you explicitly opt in. It refuses to run
// unless LOAD_TEST_CONFIRM=I_HAVE_AUTHORIZATION is set. NEVER run high-volume
// tests against production FastTest without written authorization.
//
// Usage (controlled tiers): pick VUS/ITER to match a tier (10/50/100/500/1000):
//   LOAD_TEST_CONFIRM=I_HAVE_AUTHORIZATION \
//   BASE_URL=https://staging.example/FastTest/api \
//   API_TOKEN=... TEST_CODES=FUJ290263565,ABU111222333 \
//   k6 run -e VUS=10 -e ITER=100 scripts/load-test/k6-status.js
//
// Metrics captured: total/success/failed requests, avg/med/p95/p99/min/max
// response time, RPS, timeouts, 401/404/500 counts.

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const confirm = __ENV.LOAD_TEST_CONFIRM;
if (confirm !== 'I_HAVE_AUTHORIZATION') {
  throw new Error('Refusing to run: set LOAD_TEST_CONFIRM=I_HAVE_AUTHORIZATION and ensure you have written authorization.');
}

const BASE_URL = __ENV.BASE_URL;
const API_TOKEN = __ENV.API_TOKEN;
const TEST_CODES = (__ENV.TEST_CODES || '').split(',').map((s) => s.trim()).filter(Boolean);
const VUS = Number(__ENV.VUS || 10);
const ITER = Number(__ENV.ITER || 100);

if (!BASE_URL || !API_TOKEN || TEST_CODES.length === 0) {
  throw new Error('BASE_URL, API_TOKEN and TEST_CODES are required.');
}

export const options = {
  scenarios: {
    controlled: { executor: 'shared-iterations', vus: VUS, iterations: ITER, maxDuration: '10m' },
  },
  thresholds: {
    http_req_duration: ['p(95)<3000'],
    http_req_failed: ['rate<0.05'],
  },
};

const c401 = new Counter('status_401');
const c404 = new Counter('status_404');
const c500 = new Counter('status_500');
const cTimeout = new Counter('timeouts');
const respTrend = new Trend('resp_ms', true);

export default function () {
  const code = TEST_CODES[Math.floor(Math.random() * TEST_CODES.length)];
  const res = http.get(`${BASE_URL}/tests/registration/${code}/status`, {
    headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: 'application/json' },
    timeout: '15s',
  });
  respTrend.add(res.timings.duration);
  if (res.status === 401) c401.add(1);
  if (res.status === 404) c404.add(1);
  if (res.status >= 500) c500.add(1);
  if (res.error_code === 1050) cTimeout.add(1); // k6 request timeout
  check(res, { 'status is 2xx': (r) => r.status >= 200 && r.status < 300 });
}
