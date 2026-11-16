import { afterEach, describe, expect, it } from 'vitest';
import { LampClient } from '../src/lamp/client';
import { LampHttpError, LampUnreachable } from '../src/lamp/errors';
import { startFakeLamp } from './fakeLamp';

type Fake = Awaited<ReturnType<typeof startFakeLamp>>;
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });

async function setup(opts: Partial<Parameters<typeof startFakeLamp>[0]> = {}, timeoutMs?: number, useToken = true) {
  const lamp: Fake = await startFakeLamp({ deviceId: 'aabbccddeeff', name: 'Test', ...opts });
  const client = new LampClient({ host: '127.0.0.1', port: lamp.port, token: useToken ? lamp.token : undefined }, { timeoutMs });
  cleanup.push(() => client.destroy(), () => lamp.close());
  return { lamp, client };
}

describe('LampClient', () => {
  it('GET /api returns the deviceId', async () => {
    const { client } = await setup({ role: 'ai', perms: [] }, undefined, false);
    const info = await client.get<{ deviceId: string }>('/api');
    expect(info.deviceId).toBe('aabbccddeeff');
  });

  it('refuses a response body over 8 MB (and the next request still works)', async () => {
    const { client, lamp } = await setup({ role: 'admin' }, undefined, false);
    lamp.state.override = (_req, res, path) => {
      if (path !== '/api/big') return false;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const chunk = Buffer.alloc(1024 * 1024, 1);
      let n = 0;
      const pump = () => { while (n < 9) { n++; if (!res.write(chunk)) return res.once('drain', pump); } res.end(); };
      res.on('error', () => undefined);
      pump();
      return true;
    };
    const e = await client.getBinary('/api/big').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LampHttpError);
    expect((e as Error).message).toMatch(/larger than 8 MB/);
    const ok = await client.getBinary('/api').then((r) => r.data.length);
    expect(ok).toBeGreaterThan(0);
  });

  it('POST power works with the token', async () => {
    const { client, lamp } = await setup({ role: 'ai', perms: ['control'] });
    await client.send('POST', '/api/power', { on: true });
    expect(lamp.state.on).toBe(true);
    expect((await client.get<{ on: boolean }>('/api/state')).on).toBe(true);
  });

  it('wraps a 403 in LampHttpError with the firmware text', async () => {
    const { client } = await setup({ role: 'ai', perms: ['effects'] });
    const e = await client.send<any>('POST', '/api/power', { on: true }).catch((x: any) => x);
    expect(e).toBeInstanceOf(LampHttpError);
    expect(e.status).toBe(403);
    expect(e.message).toBe('not permitted for this AI key');
  });

  it('unwraps JSON message/error bodies', async () => {
    const { client } = await setup({ role: 'admin', grid: { w: 4, h: 2 } });
    const e = await client.sendBinary<any>('POST', '/api/frame', Buffer.alloc(5)).catch((x: any) => x);
    expect(e).toBeInstanceOf(LampHttpError);
    expect(e.status).toBe(400);
    expect(e.message).toBe('expected 24 bytes (4x2x3)');
  });

  it('round-trips a binary frame', async () => {
    const { client } = await setup({ role: 'ai', perms: ['images'], grid: { w: 4, h: 2 } });
    const frame = Buffer.from(Array.from({ length: 24 }, (_, i) => i * 3));
    await client.sendBinary('POST', '/api/frame', frame);
    const got = await client.getBinary('/api/frame');
    expect(got.data.equals(frame)).toBe(true);
    expect(got.headers['x-frame-w']).toBe('4');
    expect(got.headers['x-frame-h']).toBe('2');
  });

  it('rejects with LampUnreachable when the lamp hangs', async () => {
    const { client } = await setup({ hang: true, role: 'admin' }, 300);
    const t0 = Date.now();
    await expect(client.get('/api')).rejects.toBeInstanceOf(LampUnreachable);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('rejects with LampUnreachable when nothing listens', async () => {
    const lamp = await startFakeLamp({ deviceId: 'x', name: 'x' });
    const port = lamp.port;
    await lamp.close();
    const client = new LampClient({ host: '127.0.0.1', port }, { timeoutMs: 500 });
    cleanup.push(() => client.destroy());
    await expect(client.get('/api')).rejects.toBeInstanceOf(LampUnreachable);
  });

  it('never leaks the token into error text', async () => {
    const { client, lamp } = await setup({ role: 'admin' });
    lamp.state.echoAuthOn500 = true;
    const e = await client.get<any>('/api/state').catch((x: any) => x);
    expect(e).toBeInstanceOf(LampHttpError);
    expect(e.status).toBe(500);
    expect(lamp.state.lastAuthorization).toContain(lamp.token); // the fake did echo it
    expect(e.message).not.toContain(lamp.token);
    expect(e.body).not.toContain(lamp.token);
    expect(String(e.stack)).not.toContain(lamp.token);
  });

  it('never leaks the token from a ?t= path in an unreachable error', async () => {
    const client = new LampClient({ host: '127.0.0.1', port: 1, token: 'SECRETTOKEN' }, { timeoutMs: 300 });
    cleanup.push(() => client.destroy());
    const e = await client.get<any>('/config?t=SECRETTOKEN').catch((x: any) => x);
    expect(e).toBeInstanceOf(LampUnreachable);
    expect(e.message).not.toContain('SECRETTOKEN');
  });

  it('serves concurrent calls one after another', async () => {
    const { client, lamp } = await setup({ role: 'admin' });
    lamp.state.delayMs = 40;
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => client.get('/api/state').then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3, 4]);
    expect(lamp.state.maxConcurrency).toBe(1);
  });

  it('keeps working after a failed call in the queue', async () => {
    const { client } = await setup({ role: 'ai', perms: [] });
    const results = await Promise.allSettled([
      client.send('POST', '/api/power', { on: true }),
      client.get('/api/state'),
    ]);
    expect(results[0]!.status).toBe('rejected');
    expect(results[1]!.status).toBe('fulfilled');
  });

  it('updateEndpoint points later requests at the new port', async () => {
    const a = await startFakeLamp({ deviceId: 'a', name: 'A' });
    const b = await startFakeLamp({ deviceId: 'b', name: 'B' });
    const client = new LampClient({ host: '127.0.0.1', port: a.port });
    cleanup.push(() => client.destroy(), () => a.close(), () => b.close());
    expect((await client.get<{ deviceId: string }>('/api')).deviceId).toBe('a');
    client.updateEndpoint('127.0.0.1', b.port);
    expect((await client.get<{ deviceId: string }>('/api')).deviceId).toBe('b');
  });
});
