import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { hashPassword } from '../../src/services/auth.service';
import * as sv from '../../src/services/saved-views.service';

let userA: string;
let userB: string;

beforeAll(async () => {
  userA = (await prisma.user.create({ data: { email: `sva-${Date.now()}@t.local`, passwordHash: await hashPassword('x'), fullName: 'A' } })).id;
  userB = (await prisma.user.create({ data: { email: `svb-${Date.now()}@t.local`, passwordHash: await hashPassword('x'), fullName: 'B' } })).id;
});

describe('Saved views', () => {
  it('creates a view and sanitizes unknown columns', async () => {
    const v = await sv.createView(userA, { name: 'My View', pageType: 'registrations', filters: { status: 'COMPLETED' }, columns: ['StudentId', 'BOGUS', 'RawScore'], pageSize: 50, isDefault: false, isShared: false } as any, false);
    const h = sv.hydrateView(v);
    expect(h.columns).toEqual(['StudentId', 'RawScore']);
    expect(h.filters.status).toBe('COMPLETED');
    expect(h.pageSize).toBe(50);
  });

  it('keeps views private to their owner unless shared', async () => {
    const v = await sv.createView(userA, { name: 'Private', pageType: 'registrations', filters: {}, columns: [], pageSize: 25, isDefault: false, isShared: false } as any, false);
    expect(await sv.getView(v.id, userB)).toBeNull(); // other user cannot read
    expect(await sv.getView(v.id, userA)).not.toBeNull();
  });

  it('only allows sharing with the share permission', async () => {
    const noPerm = await sv.createView(userA, { name: 'TryShare', pageType: 'registrations', filters: {}, columns: [], pageSize: 25, isDefault: false, isShared: true } as any, false);
    expect(noPerm.isShared).toBe(false); // suppressed
    const withPerm = await sv.createView(userA, { name: 'Shared', pageType: 'registrations', filters: {}, columns: [], pageSize: 25, isDefault: false, isShared: true } as any, true);
    expect(withPerm.isShared).toBe(true);
    // userB can now see the shared view in the list
    const list = await sv.listViews(userB, 'registrations');
    expect(list.some((x) => x.id === withPerm.id)).toBe(true);
  });

  it('enforces a single default per user/page', async () => {
    const v1 = await sv.createView(userB, { name: 'D1', pageType: 'schools', filters: {}, columns: [], pageSize: 25, isDefault: true, isShared: false } as any, false);
    const v2 = await sv.createView(userB, { name: 'D2', pageType: 'schools', filters: {}, columns: [], pageSize: 25, isDefault: true, isShared: false } as any, false);
    const reloaded1 = await prisma.savedView.findUnique({ where: { id: v1.id } });
    expect(reloaded1!.isDefault).toBe(false); // superseded
    const def = await sv.getDefaultView(userB, 'schools');
    expect(def!.id).toBe(v2.id);
  });

  it('duplicates and soft-deletes a view', async () => {
    const v = await sv.createView(userA, { name: 'Dup', pageType: 'registrations', filters: { grade: '5' }, columns: ['StudentId'], pageSize: 25, isDefault: false, isShared: false } as any, false);
    const dup = await sv.duplicateView(v.id, userA);
    expect(dup!.name).toBe('Dup (copy)');
    await sv.deleteView(v.id, userA);
    expect(await sv.getView(v.id, userA)).toBeNull(); // soft-deleted, hidden
  });

  it('cannot edit another user\'s view', async () => {
    const v = await sv.createView(userA, { name: 'Owned', pageType: 'registrations', filters: {}, columns: [], pageSize: 25, isDefault: false, isShared: false } as any, false);
    expect(await sv.updateView(v.id, userB, { name: 'Hijack' }, false)).toBeNull();
  });
});
