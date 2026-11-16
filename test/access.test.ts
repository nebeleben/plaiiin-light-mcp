import { describe, expect, it } from 'vitest';
import { allows, refusal } from '../src/lamp/access';
import type { FleetLamp } from '../src/store/fleet';

const L = (o: Partial<FleetLamp>): FleetLamp => ({
  deviceId: 'aa', name: 'A', host: 'h', port: 80, role: 'user', shared: true, lastSeen: '', ...o,
});

describe('allows', () => {
  it('admin may do everything', () => {
    expect(allows(L({ role: 'admin' }), { perm: 'ota', minRole: 'admin' })).toBe(true);
    expect(allows(L({ role: 'admin' }), { minRole: 'user' })).toBe(true);
  });

  it('AI key: by permission list', () => {
    const ai = L({ role: 'ai', perms: ['control'] });
    expect(allows(ai, { perm: 'control', minRole: 'user' })).toBe(true);
    expect(allows(ai, { perm: 'ota', minRole: 'admin' })).toBe(false);
    expect(allows(ai, { perm: 'effects', minRole: 'creator' })).toBe(false);
  });

  it('AI key: reads (no perm) only when a user may read', () => {
    const ai = L({ role: 'ai', perms: [] });
    expect(allows(ai, { minRole: 'user' })).toBe(true);
    expect(allows(ai, { minRole: 'creator' })).toBe(false);
    expect(allows(ai, { minRole: 'admin' })).toBe(false);
  });

  it('AI key without perms (whoami lacked them) refuses writes without throwing', () => {
    const ai = L({ role: 'ai' });
    expect(allows(ai, { perm: 'control', minRole: 'user' })).toBe(false);
    expect(allows(ai, { minRole: 'user' })).toBe(true);
  });

  it('user/creator: role ladder, perm ignored', () => {
    expect(allows(L({ role: 'creator' }), { perm: 'effects', minRole: 'creator' })).toBe(true);
    expect(allows(L({ role: 'creator' }), { perm: 'rename', minRole: 'admin' })).toBe(false);
    expect(allows(L({ role: 'user' }), { perm: 'effects', minRole: 'creator' })).toBe(false);
    expect(allows(L({ role: 'user' }), { perm: 'control', minRole: 'user' })).toBe(true);
  });

  it('Review Focus 5: creator from old firmware (no perms) works by ladder', () => {
    const creator = L({ role: 'creator', perms: undefined });
    expect(allows(creator, { perm: 'scenes', minRole: 'creator' })).toBe(true);
    expect(allows(creator, { perm: 'ota', minRole: 'admin' })).toBe(false);
  });
});

describe('refusal', () => {
  it('AI refusal names the missing permission', () => {
    expect(refusal(L({ role: 'ai', perms: [] }), { perm: 'control', minRole: 'user' }))
      .toBe("not permitted by this lamp's AI key (needs control)");
  });
  it('ladder refusal names the role', () => {
    expect(refusal(L({ role: 'user' }), { perm: 'effects', minRole: 'creator' }))
      .toBe("not permitted: needs creator access, this lamp's key is user");
  });
});
