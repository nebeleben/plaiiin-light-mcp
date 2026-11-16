/**
 * Pins the fake lamp's permission table and role ladder against the firmware's docs/sharing-api.md,
 * so later tasks can rely on the fake answering like the firmware does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { startFakeLamp, type FakeLamp, type Role } from './fakeLamp';

interface Row {
  role: Role; perms?: string[]; onlyWhenOn?: boolean; on?: boolean;
  method: string; path: string; body?: unknown;
  status: number; text?: string;
}

const W = (o: Partial<Row> & Pick<Row, 'role' | 'method' | 'path' | 'status'>): Row => o;

const ROWS: Row[] = [
  // ladder
  W({ role: 'user', method: 'GET', path: '/api/state', status: 200 }),
  W({ role: 'user', method: 'POST', path: '/api/color', body: { color: [1, 2, 3] }, status: 200 }),
  W({ role: 'user', method: 'PUT', path: '/api/js/x', body: 'x', status: 403, text: 'insufficient role' }),
  W({ role: 'creator', method: 'PUT', path: '/api/js/x', body: 'x', status: 200 }),
  W({ role: 'creator', method: 'POST', path: '/api/name', body: { name: 'n' }, status: 403, text: 'insufficient role' }),
  W({ role: 'admin', method: 'POST', path: '/api/name', body: { name: 'n' }, status: 200 }),
  W({ role: 'creator', method: 'POST', path: '/api/ota', body: 'x', status: 403 }),
  W({ role: 'user', method: 'GET', path: '/api/swarm', status: 403, text: 'insufficient role' }),
  W({ role: 'creator', method: 'GET', path: '/api/swarm', status: 403, text: 'insufficient role' }),
  W({ role: 'admin', method: 'GET', path: '/api/swarm', status: 200 }),
  W({ role: 'creator', method: 'GET', path: '/api/swarm/stats', status: 403, text: 'insufficient role' }),
  W({ role: 'admin', method: 'GET', path: '/api/swarm/stats', status: 200 }),
  // AI keys: reads need no permission
  W({ role: 'ai', perms: [], method: 'GET', path: '/api/state', status: 200 }),
  W({ role: 'ai', perms: [], method: 'GET', path: '/api/js', status: 200 }),
  W({ role: 'ai', perms: [], method: 'GET', path: '/api/scenes', status: 200 }),
  W({ role: 'ai', perms: [], method: 'GET', path: '/api/ota/info', status: 200 }),
  // AI keys: each permission
  W({ role: 'ai', perms: [], method: 'POST', path: '/api/color', body: { color: [1, 2, 3] }, status: 403, text: 'not permitted for this AI key' }),
  W({ role: 'ai', perms: ['control'], method: 'POST', path: '/api/color', body: { color: [1, 2, 3] }, status: 200 }),
  W({ role: 'ai', perms: ['control'], method: 'PUT', path: '/api/js/x', body: 'x', status: 403, text: 'not permitted for this AI key' }),
  W({ role: 'ai', perms: ['effects'], method: 'PUT', path: '/api/js/x', body: 'x', status: 200 }),
  W({ role: 'ai', perms: ['scenes'], method: 'PUT', path: '/api/scenes/s', body: { mode: 'api' }, status: 200 }),
  W({ role: 'ai', perms: ['rename'], method: 'POST', path: '/api/name', body: { name: 'n' }, status: 200 }),
  W({ role: 'ai', perms: ['ota'], method: 'POST', path: '/api/ota', body: 'x', status: 200 }),
  W({ role: 'ai', perms: [], method: 'GET', path: '/api/swarm', status: 403, text: 'not permitted for this AI key' }),
  W({ role: 'ai', perms: ['swarm'], method: 'GET', path: '/api/swarm', status: 200 }),
  W({ role: 'ai', perms: [], method: 'GET', path: '/api/swarm/stats', status: 403, text: 'not permitted for this AI key' }),
  W({ role: 'ai', perms: ['swarm'], method: 'GET', path: '/api/swarm/stats', status: 200 }),
  // AI keys: never grantable
  W({ role: 'ai', perms: ['control', 'effects', 'images', 'scenes', 'stream', 'ota', 'rename', 'swarm'], method: 'PUT', path: '/api/form-prompt', body: 'x', status: 403, text: 'insufficient role' }),
  // AI keys: only-while-on — writes refused while off, reads (incl. permission-gated ones) and power allowed
  W({ role: 'ai', perms: ['control'], onlyWhenOn: true, on: false, method: 'POST', path: '/api/color', body: { color: [1, 2, 3] }, status: 403, text: 'lamp is off' }),
  W({ role: 'ai', perms: ['control'], onlyWhenOn: true, on: true, method: 'POST', path: '/api/color', body: { color: [1, 2, 3] }, status: 200 }),
  W({ role: 'ai', perms: ['control'], onlyWhenOn: true, on: false, method: 'POST', path: '/api/power', body: { on: true }, status: 200 }),
  W({ role: 'ai', perms: [], onlyWhenOn: true, on: false, method: 'GET', path: '/api/state', status: 200 }),
  W({ role: 'ai', perms: ['swarm'], onlyWhenOn: true, on: false, method: 'GET', path: '/api/swarm', status: 200 }),
  W({ role: 'ai', perms: ['swarm'], onlyWhenOn: true, on: false, method: 'GET', path: '/api/swarm/stats', status: 200 }),
  W({ role: 'ai', perms: [], onlyWhenOn: true, on: false, method: 'GET', path: '/api/swarm', status: 403, text: 'not permitted for this AI key' }),
];

function call(port: number, token: string, r: Row): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const body = r.body === undefined ? undefined : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    const req = request({ host: '127.0.0.1', port, method: r.method, path: r.path,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Length': String(body.length) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('fake lamp permission table (sharing-api.md)', () => {
  let lamp: FakeLamp | undefined;
  afterEach(async () => { await lamp?.close(); lamp = undefined; });

  it.each(ROWS.map((r) => [`${r.role}${r.perms ? `[${r.perms.join(',')}]` : ''}${r.onlyWhenOn ? ` onlyWhenOn on=${r.on}` : ''} ${r.method} ${r.path} → ${r.status}`, r] as const))('%s', async (_n, r) => {
    lamp = await startFakeLamp({ deviceId: 'aa', name: 'A', role: r.role, perms: r.perms, onlyWhenOn: r.onlyWhenOn, swarmId: 'sw1' });
    if (r.on !== undefined) lamp.state.on = r.on;
    const res = await call(lamp.port, lamp.token, r);
    expect(res.status).toBe(r.status);
    if (r.text) expect(res.text).toBe(r.text);
  });
});
