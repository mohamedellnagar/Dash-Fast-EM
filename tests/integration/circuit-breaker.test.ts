import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { canRequest, recordFailure, recordSuccess, getCircuitState } from '../../src/services/sync/circuit-breaker.service';
import { ERROR_CATEGORY } from '../../src/lib/enums';
import { env } from '../../src/config/env';

let wsId: string;

beforeAll(async () => {
  wsId = (await prisma.fastTestWorkspace.create({ data: { workspaceName: 'CB WS', subjectCode: 'CBWS', baseUrl: 'https://x.test/api' } })).id;
});
beforeEach(async () => {
  await prisma.workspaceCircuitBreaker.deleteMany({ where: { workspaceId: wsId } });
});

describe('Circuit breaker', () => {
  it('starts CLOSED and allows requests', async () => {
    const d = await canRequest(wsId);
    expect(d.allowed).toBe(true);
    expect(d.state).toBe('CLOSED');
  });

  it('opens after the failure threshold and blocks requests', async () => {
    for (let i = 0; i < env.circuit.failureThreshold; i++) {
      await recordFailure(wsId, ERROR_CATEGORY.FASTTEST_INTERNAL_ERROR);
    }
    expect(await getCircuitState(wsId)).toBe('OPEN');
    const d = await canRequest(wsId, () => Date.now());
    expect(d.allowed).toBe(false);
  });

  it('opens faster on repeated auth failures', async () => {
    for (let i = 0; i < env.circuit.authFailThreshold; i++) {
      await recordFailure(wsId, ERROR_CATEGORY.AUTHENTICATION);
    }
    expect(await getCircuitState(wsId)).toBe('OPEN');
  });

  it('transitions to HALF_OPEN after the open window, then closes on probe successes', async () => {
    for (let i = 0; i < env.circuit.failureThreshold; i++) await recordFailure(wsId, ERROR_CATEGORY.TIMEOUT);
    const openAt = Date.now();
    // Before probe window: blocked.
    expect((await canRequest(wsId, () => openAt + 1000)).allowed).toBe(false);
    // After window: HALF_OPEN probe allowed.
    const probe = await canRequest(wsId, () => openAt + env.circuit.openMs + 1000);
    expect(probe.state).toBe('HALF_OPEN');
    expect(probe.probe).toBe(true);
    // Enough probe successes → CLOSED.
    for (let i = 0; i < env.circuit.halfOpenProbes; i++) await recordSuccess(wsId);
    expect(await getCircuitState(wsId)).toBe('CLOSED');
  });

  it('re-opens if a half-open probe fails', async () => {
    for (let i = 0; i < env.circuit.failureThreshold; i++) await recordFailure(wsId, ERROR_CATEGORY.TIMEOUT);
    const openAt = Date.now();
    await canRequest(wsId, () => openAt + env.circuit.openMs + 1000); // → HALF_OPEN
    await recordFailure(wsId, ERROR_CATEGORY.TIMEOUT); // probe fails
    expect(await getCircuitState(wsId)).toBe('OPEN');
  });
});
