import { describe, it, expect } from 'vitest';
import { ROLE_PERMISSIONS } from '../../src/services/rbac.service';
import { ROLE, PERMISSION } from '../../src/lib/enums';

describe('RBAC role → permission grants', () => {
  it('administrator has every permission', () => {
    const all = Object.values(PERMISSION);
    expect(ROLE_PERMISSIONS[ROLE.ADMINISTRATOR].sort()).toEqual([...all].sort());
  });
  it('viewer is read-only (no import/sync/integration)', () => {
    const v = ROLE_PERMISSIONS[ROLE.VIEWER];
    expect(v).not.toContain(PERMISSION.IMPORT_RUN);
    expect(v).not.toContain(PERMISSION.MANUAL_SYNC);
    expect(v).not.toContain(PERMISSION.INTEGRATION_MANAGE);
    expect(v).toContain(PERMISSION.DASHBOARD_VIEW);
  });
  it('operations can manual-sync and export but not manage integration', () => {
    const o = ROLE_PERMISSIONS[ROLE.OPERATIONS];
    expect(o).toContain(PERMISSION.MANUAL_SYNC);
    expect(o).toContain(PERMISSION.EXPORT_RUN);
    expect(o).not.toContain(PERMISSION.INTEGRATION_MANAGE);
  });
  it('assessment team sees results but cannot manually sync', () => {
    const a = ROLE_PERMISSIONS[ROLE.ASSESSMENT_TEAM];
    expect(a).toContain(PERMISSION.RESULTS_VIEW);
    expect(a).not.toContain(PERMISSION.MANUAL_SYNC);
  });
  it('only administrator can view raw API responses', () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      if (role === ROLE.ADMINISTRATOR) expect(perms).toContain(PERMISSION.RAW_RESPONSE_VIEW);
      else expect(perms).not.toContain(PERMISSION.RAW_RESPONSE_VIEW);
    }
  });
});
