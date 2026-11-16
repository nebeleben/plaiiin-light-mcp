import { describe, expect, it, vi } from 'vitest';
import { makeLanLookup } from '../src/lamp/lookup';

type Cb = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;

describe('makeLanLookup', () => {
  it('resolves .local names IPv4-only, so no 5 s wait for a missing AAAA answer', async () => {
    const base = vi.fn((_h: string, o: { family?: number; all?: boolean }, cb: Cb) =>
      o.all ? cb(null, [{ address: '192.168.1.5', family: 4 }]) : cb(null, '192.168.1.5', 4));
    const lookup = makeLanLookup(base as never);
    const got = await new Promise((res) => lookup('tower.local', { all: true }, (e, a) => res([e, a])));
    expect(got).toEqual([null, [{ address: '192.168.1.5', family: 4 }]]);
    expect(base).toHaveBeenCalledTimes(1);
    expect(base.mock.calls[0]![1]).toMatchObject({ family: 4, all: true });
  });

  it('falls back to a normal lookup when a .local name has no IPv4 address', async () => {
    const base = vi.fn((_h: string, o: { family?: number }, cb: Cb) =>
      o.family === 4 ? cb(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })) : cb(null, 'fe80::1', 6));
    const lookup = makeLanLookup(base as never);
    const got = await new Promise((res) => lookup('tower.local', {}, (e, a, f) => res([e, a, f])));
    expect(got).toEqual([null, 'fe80::1', 6]);
    expect(base).toHaveBeenCalledTimes(2);
    expect(base.mock.calls[1]![1]).toEqual({});
  });

  it('leaves other names to the normal lookup', async () => {
    const base = vi.fn((_h: string, _o: unknown, cb: Cb) => cb(null, '10.0.0.2', 4));
    const lookup = makeLanLookup(base as never);
    await new Promise((res) => lookup('lamp.example', { family: 0 }, () => res(null)));
    expect(base.mock.calls[0]![1]).toEqual({ family: 0 });
  });
});
