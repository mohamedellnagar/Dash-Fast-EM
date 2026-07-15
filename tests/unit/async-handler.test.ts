import { describe, it, expect, vi } from 'vitest';
import { asyncHandler } from '../../src/middleware/async-handler';

describe('asyncHandler', () => {
  it('forwards a rejected promise to next() instead of throwing', async () => {
    const boom = new Error('db is full');
    const handler = asyncHandler(async () => { throw boom; });
    const next = vi.fn();
    await handler({} as any, {} as any, next);
    // Give the caught promise a tick to settle.
    await new Promise((r) => setImmediate(r));
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('does not call next() on success', async () => {
    const handler = asyncHandler(async (_req, res: any) => { res.json({ ok: true }); });
    const next = vi.fn();
    const res = { json: vi.fn() } as any;
    await handler({} as any, res, next);
    await new Promise((r) => setImmediate(r));
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });
});
