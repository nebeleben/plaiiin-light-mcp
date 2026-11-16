import { afterEach, describe, expect, it, vi } from 'vitest';
import { Confirmations } from '../src/tools/confirm';

afterEach(() => { vi.useRealTimers(); });

describe('Confirmations', () => {
  it('returns a request with summary and an 8-char token', () => {
    const c = new Confirmations();
    const r = c.request('effect_delete', { lamp: 'a', name: 'rain' }, 'Delete rain on a');
    expect(r.needsConfirmation).toBe(true);
    expect(r.summary).toBe('Delete rain on a');
    expect(r.confirm).toMatch(/^[A-Za-z0-9]{8}$/);
  });

  it('a token works once', () => {
    const c = new Confirmations();
    const { confirm } = c.request('effect_delete', { lamp: 'a', name: 'rain' }, 's');
    expect(c.consume('effect_delete', { lamp: 'a', name: 'rain', confirm }, confirm)).toBe(true);
    expect(c.consume('effect_delete', { lamp: 'a', name: 'rain', confirm }, confirm)).toBe(false);
  });

  it('ignores argument key order and the confirm argument itself', () => {
    const c = new Confirmations();
    const { confirm } = c.request('t', { b: 1, a: { y: 2, x: 1 } }, 's');
    expect(c.consume('t', { a: { x: 1, y: 2 }, b: 1, confirm }, confirm)).toBe(true);
  });

  it('expires after 120 s', () => {
    vi.useFakeTimers();
    const c = new Confirmations();
    const { confirm } = c.request('t', { lamp: 'a' }, 's');
    vi.advanceTimersByTime(119_000);
    const c2 = c.request('t', { lamp: 'b' }, 's');
    expect(c.consume('t', { lamp: 'b' }, c2.confirm)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(c.consume('t', { lamp: 'a' }, confirm)).toBe(false);
  });

  it('Review Focus 4: a token for rain is refused for fire', () => {
    const c = new Confirmations();
    const { confirm } = c.request('effect_delete', { lamp: 'a', name: 'rain' }, 's');
    expect(c.consume('effect_delete', { lamp: 'a', name: 'fire' }, confirm)).toBe(false);
    expect(c.consume('effect_upload', { lamp: 'a', name: 'rain' }, confirm)).toBe(false);
    expect(c.consume('effect_delete', { lamp: 'a', name: 'rain' }, 'XXXXXXXX')).toBe(false);
  });
});
