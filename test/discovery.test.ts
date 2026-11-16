import { describe, expect, it } from 'vitest';
import { discover, resolveDevice, type BonjourLike, type ServiceLike } from '../src/lamp/discovery';

/** Fake Bonjour whose browser emits the given services right after `find`. */
function fakeBonjour(services: ServiceLike[], log: string[] = []): () => BonjourLike {
  return () => ({
    find(opts) {
      log.push(`find ${opts.type}/${opts.protocol}`);
      const handlers: Array<(s: ServiceLike) => void> = [];
      setTimeout(() => { for (const s of services) for (const h of handlers) h(s); }, 5);
      return {
        on(ev, cb) { if (ev === 'up') handlers.push(cb); },
        stop() { log.push('stop'); },
      };
    },
    destroy() { log.push('destroy'); },
  });
}

const svc = (o: Partial<ServiceLike>): ServiceLike => ({ name: 'x', port: 80, ...o });

describe('discover', () => {
  it('collects lamps with a TXT id, prefers IPv4, dedupes, and cleans up', async () => {
    const log: string[] = [];
    const found = await discover(50, fakeBonjour([
      svc({ name: 'kitchen', host: 'kitchen.local', addresses: ['fe80::1', '192.168.1.5'], txt: { id: 'aa', node: 'Kitchen', paired: '1' } }),
      svc({ name: 'kitchen', host: 'kitchen.local', addresses: ['192.168.1.5'], txt: { id: 'aa', node: 'Kitchen', paired: '1' } }),
      svc({ name: 'desk', host: 'desk.local', port: 8080, txt: { id: 'bb', paired: '0' } }),
      svc({ name: 'old', host: 'old.local', txt: {} }),
    ], log));
    expect(found).toEqual([
      { deviceId: 'aa', name: 'Kitchen', host: '192.168.1.5', port: 80, paired: true },
      { deviceId: 'bb', name: 'desk', host: 'desk.local', port: 8080, paired: false },
    ]);
    expect(log).toEqual(['find plaiiinlight/tcp', 'stop', 'destroy']);
  });

  it('resolveDevice returns as soon as the id shows up', async () => {
    const t0 = Date.now();
    const d = await resolveDevice('bb', 5000, fakeBonjour([svc({ host: 'h', txt: { id: 'bb' } })]));
    expect(d?.host).toBe('h');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await resolveDevice('zz', 30, fakeBonjour([svc({ host: 'h', txt: { id: 'bb' } })]))).toBeUndefined();
  });
});
