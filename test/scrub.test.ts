import { describe, expect, it } from 'vitest';
import { scrub } from '../src/util/scrub';

describe('scrub', () => {
  it('removes ?t= values', () => {
    const out = scrub('http://h/config?t=abc123&x=1');
    expect(out).not.toContain('abc123');
    expect(out).toContain('x=1');
  });
  it('removes &t= values', () => {
    expect(scrub('http://h/config?a=1&t=abc123')).not.toContain('abc123');
  });
  it('removes Bearer values', () => {
    expect(scrub('Authorization: Bearer abc.def')).not.toContain('abc.def');
    expect(scrub('bearer abc.def')).not.toContain('abc.def');
  });
  it('removes ?token= and &token= values', () => {
    expect(scrub('ws://h/ws?token=zzz')).not.toContain('zzz');
    expect(scrub('ws://h/ws?a=1&token=zzz&b=2')).not.toContain('zzz');
    expect(scrub('ws://h/ws?a=1&token=zzz&b=2')).toContain('b=2');
  });
  it('leaves harmless text alone', () => {
    expect(scrub('GET /api/state -> HTTP 500')).toBe('GET /api/state -> HTTP 500');
  });
});
