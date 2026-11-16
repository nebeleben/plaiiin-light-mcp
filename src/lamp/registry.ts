import { LampClient } from './client';
import { LampHttpError, LampUnreachable } from './errors';
import { allows, refusal, SWARM_READ, type Need } from './access';
import { resolveDevice, type Discovered } from './discovery';
import type { ShareLink } from './shareLink';
import type { FleetLamp, FleetRole, FleetStore } from '../store/fleet';
import type { Secrets } from '../store/secrets';

interface Whoami { role?: string; paired?: boolean; perms?: unknown; maxBrightness?: unknown; onlyWhenOn?: unknown }
interface ApiInfo { deviceId?: string; nodeName?: string; firmwareVersion?: string; lampForm?: string; logicalW?: number; logicalH?: number }
interface OtaInfo { form?: string; target?: string }
interface Swarm { member?: boolean; id?: string }

const ROLES: readonly FleetRole[] = ['admin', 'creator', 'user', 'ai'];

/** Access fields from `GET /api/whoami`. `perms` etc. only for AI keys; old firmware omits them (→ ladder). */
function accessFrom(w: Whoami): Pick<FleetLamp, 'role' | 'perms' | 'maxBrightness' | 'onlyWhenOn'> {
  const role = ROLES.includes(w.role as FleetRole) ? (w.role as FleetRole) : 'user';
  if (role !== 'ai') return { role, perms: undefined, maxBrightness: undefined, onlyWhenOn: undefined };
  return {
    role,
    perms: Array.isArray(w.perms) ? w.perms.filter((p): p is string => typeof p === 'string') : undefined,
    maxBrightness: typeof w.maxBrightness === 'number' ? w.maxBrightness : null,
    onlyWhenOn: w.onlyWhenOn === true,
  };
}

const now = () => new Date().toISOString();

/** Fleet + secrets + clients: the only way tools reach a lamp. One LampClient per deviceId. */
export class Registry {
  private readonly clients = new Map<string, { client: LampClient; token?: string }>();
  /** Secrets read once per deviceId (a Keychain read spawns `security`); dropped on every write here. */
  private readonly secretCache = new Map<string, string | undefined>();
  private readonly timeoutMs?: number;

  constructor(
    private readonly fleet: FleetStore,
    private readonly secrets: Secrets,
    private readonly resolve: (deviceId: string) => Promise<Discovered | undefined> = (id) => resolveDevice(id),
    opts: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs;
  }

  /** All fleet entries. */
  list(): FleetLamp[] {
    return this.fleet.list();
  }

  /**
   * One lamp by exact deviceId, else by name (case-insensitive). Throws `unknown lamp: X`, or — when a
   * name matches more than one lamp — `"X" matches several lamps — use the deviceId`.
   */
  lookup(idOrName: string): FleetLamp {
    const want = idOrName.trim();
    const all = this.fleet.list();
    const byId = all.find((l) => l.deviceId === want);
    if (byId) return byId;
    const byName = all.filter((l) => l.name.toLowerCase() === want.toLowerCase());
    if (byName.length > 1) throw new Error(`"${idOrName}" matches several lamps — use the deviceId`);
    if (!byName[0]) throw new Error(`unknown lamp: ${idOrName}`);
    return byName[0];
  }

  /** Save changed fleet fields (e.g. a new name). */
  update(l: FleetLamp): void {
    this.fleet.upsert(l);
  }

  /**
   * Remove a lamp from this computer: fleet entry first, then the open client and the stored secret.
   * The lamp is not touched. A failed secret delete is reported, but the lamp stays forgotten.
   */
  async forget(deviceId: string): Promise<{ secretError?: string }> {
    this.fleet.remove(deviceId);
    this.clients.get(deviceId)?.client.destroy();
    this.clients.delete(deviceId);
    this.secretCache.delete(deviceId);
    try {
      await this.secrets.delete(deviceId);
      return {};
    } catch (e) {
      return { secretError: e instanceof Error ? e.message : String(e) };
    }
  }

  async client(idOrName: string): Promise<{ lamp: FleetLamp; client: LampClient }> {
    const lamp = this.lookup(idOrName);
    const token = await this.secretOf(lamp.deviceId);
    let entry = this.clients.get(lamp.deviceId);
    if (entry && entry.token !== token) { entry.client.destroy(); entry = undefined; }
    if (!entry) {
      entry = { client: new LampClient({ host: lamp.host, port: lamp.port, token }, { timeoutMs: this.timeoutMs }), token };
      this.clients.set(lamp.deviceId, entry);
    } else {
      entry.client.updateEndpoint(lamp.host, lamp.port);
    }
    return { lamp, client: entry.client };
  }

  /**
   * Where a lamp is and the key it takes, for connections LampClient doesn't make (the `/ws` stream).
   * The token is a secret: callers must never put it (or a URL carrying it) in a result, error or log.
   */
  async endpoint(idOrName: string): Promise<{ lamp: FleetLamp; host: string; port: number; token?: string }> {
    const lamp = this.lookup(idOrName);
    return { lamp, host: lamp.host, port: lamp.port, token: await this.secretOf(lamp.deviceId) };
  }

  private async secretOf(deviceId: string): Promise<string | undefined> {
    if (this.secretCache.has(deviceId)) return this.secretCache.get(deviceId);
    const v = await this.secrets.get(deviceId);
    this.secretCache.set(deviceId, v);
    return v;
  }

  /** Does the lamp at host:port say it is `deviceId`? Open `GET /api`, no token sent. */
  private async isDevice(deviceId: string, host: string, port: number): Promise<boolean> {
    const c = new LampClient({ host, port }, { timeoutMs: this.timeoutMs });
    try {
      return (await c.get<ApiInfo>('/api')).deviceId === deviceId;
    } catch {
      return false;
    } finally {
      c.destroy();
    }
  }

  /**
   * A known lamp was seen at a new address (mDNS). The address is saved only after the new host
   * reports the same deviceId on the open `GET /api`, so the stored key never goes to another device.
   */
  async relocate(deviceId: string, host: string, port: number): Promise<boolean> {
    const lamp = this.fleet.get(deviceId);
    if (!lamp || lamp.deviceId !== deviceId) return false;
    if (lamp.host === host && lamp.port === port) return true;
    if (!(await this.isDevice(deviceId, host, port))) return false;
    this.fleet.upsert({ ...lamp, host, port, lastSeen: now() });
    this.clients.get(deviceId)?.client.updateEndpoint(host, port);
    return true;
  }

  /** Run `fn` against a lamp. If it is unreachable, re-resolve it by deviceId once; if it moved, save and retry. */
  async call<T>(idOrName: string, fn: (c: LampClient, l: FleetLamp) => Promise<T>): Promise<T> {
    const { lamp, client } = await this.client(idOrName);
    try {
      return await fn(client, lamp);
    } catch (e) {
      // The owner may have changed this AI key in the app: re-read it so later checks are current.
      if (e instanceof LampHttpError && e.status === 403 && lamp.role === 'ai') await this.refreshOne(lamp.deviceId);
      if (!(e instanceof LampUnreachable)) throw e;
      const d = await this.resolve(lamp.deviceId).catch(() => undefined);
      if (!d || (d.host === lamp.host && d.port === lamp.port)) throw e;
      // mDNS answers are unauthenticated: check the new host is this lamp before it gets our key.
      if (!(await this.isDevice(lamp.deviceId, d.host, d.port))) throw e;
      const moved: FleetLamp = { ...lamp, host: d.host, port: d.port, lastSeen: now() };
      this.fleet.upsert(moved);
      client.updateEndpoint(d.host, d.port);
      return await fn(client, moved);
    }
  }

  /** Add (or re-add) a lamp from a share link: whoami + /api (+ /api/swarm when readable) → fleet + secret. */
  async addShared(link: ShareLink): Promise<FleetLamp> {
    const c = new LampClient({ host: link.host, port: link.port, token: link.key }, { timeoutMs: this.timeoutMs });
    try {
      const who = await c.get<Whoami>('/api/whoami');
      const lamp = await this.describe(c, link.host, link.port, accessFrom(who), true);
      this.secretCache.delete(lamp.deviceId);
      await this.secrets.set(lamp.deviceId, link.key);
      this.secretCache.delete(lamp.deviceId);
      this.fleet.upsert(lamp);
      return lamp;
    } finally {
      c.destroy();
    }
  }

  /** Add an unpaired lamp found on the LAN: it answers as admin without a token, so no secret is stored. */
  async addUnpaired(d: Discovered): Promise<FleetLamp> {
    const c = new LampClient({ host: d.host, port: d.port }, { timeoutMs: this.timeoutMs });
    try {
      let who: Whoami;
      try {
        who = await c.get<Whoami>('/api/whoami');
      } catch (e) {
        if (e instanceof LampHttpError && (e.status === 401 || e.status === 403)) throw new Error(`${d.name} is paired; add it with a share link or QR code from its owner`);
        throw e;
      }
      if (who.role !== 'admin') throw new Error(`${d.name} is paired; add it with a share link or QR code from its owner`);
      const lamp = await this.describe(c, d.host, d.port, { role: 'admin' }, false);
      this.secretCache.delete(lamp.deviceId);
      await this.secrets.delete(lamp.deviceId);
      this.secretCache.delete(lamp.deviceId);
      this.fleet.upsert(lamp);
      return lamp;
    } finally {
      c.destroy();
    }
  }

  /** Re-read one lamp's access (whoami) into the fleet. Undefined when it can't be read; the entry is kept. */
  async refreshOne(deviceId: string): Promise<FleetLamp | undefined> {
    try {
      const { lamp, client } = await this.client(deviceId);
      const who = await client.get<Whoami>('/api/whoami');
      const cur = this.fleet.get(lamp.deviceId) ?? lamp;
      const next = { ...cur, ...accessFrom(who), lastSeen: now() };
      this.fleet.upsert(next);
      return this.fleet.get(lamp.deviceId);
    } catch {
      return undefined;
    }
  }

  /**
   * `refusal()` with a second look for AI keys: the stored permissions may predate an edit in the
   * app, so a refusal is re-checked against a fresh whoami before it stands.
   */
  async refusalFresh(l: FleetLamp, need: Need): Promise<string | undefined> {
    const r = refusal(l, need);
    if (!r || l.role !== 'ai') return r;
    const fresh = await this.refreshOne(l.deviceId);
    return fresh ? refusal(fresh, need) : r;
  }

  /** Re-read whoami for every lamp (server start). Unreachable or refusing lamps keep their stored access. */
  async refreshAccess(): Promise<void> {
    await Promise.all(this.fleet.list().map(async (l) => {
      try {
        const who = await this.call(l.deviceId, (c) => c.get<Whoami>('/api/whoami'));
        const cur = this.fleet.get(l.deviceId) ?? l;
        this.fleet.upsert({ ...cur, ...accessFrom(who), lastSeen: now() });
      } catch { /* keep what we had; the tool call will report the lamp's state */ }
    }));
  }

  /** Names or deviceIds (or "all") → fleet entries, in order, deduped. Unknown names throw. */
  resolveTargets(lamps: string[] | 'all'): FleetLamp[] {
    if (lamps === 'all') return this.fleet.list();
    const out: FleetLamp[] = [];
    for (const n of lamps) {
      const l = this.lookup(n);
      if (!out.some((x) => x.deviceId === l.deviceId)) out.push(l);
    }
    return out;
  }

  close(): void {
    for (const e of this.clients.values()) e.client.destroy();
    this.clients.clear();
  }

  private async describe(c: LampClient, host: string, port: number, access: Pick<FleetLamp, 'role' | 'perms' | 'maxBrightness' | 'onlyWhenOn'>, shared: boolean): Promise<FleetLamp> {
    const info = await c.get<ApiInfo>('/api');
    if (!info.deviceId) throw new Error(`the lamp at ${host}:${port} reports no deviceId (firmware before 2.2.0); update it first`);
    const ota = await c.get<OtaInfo>('/api/ota/info').catch(() => ({}) as OtaInfo);
    const lamp: FleetLamp = {
      deviceId: info.deviceId, name: info.nodeName ?? info.deviceId, host, port,
      ...access,
      form: ota.form ?? info.lampForm, target: ota.target,
      grid: typeof info.logicalW === 'number' && typeof info.logicalH === 'number' ? { w: info.logicalW, h: info.logicalH } : undefined,
      firmware: info.firmwareVersion, swarmId: null, shared, lastSeen: now(),
    };
    if (allows(lamp, SWARM_READ)) {
      const sw = await c.get<Swarm>('/api/swarm').catch(() => undefined);
      lamp.swarmId = sw?.member && sw.id ? sw.id : null;
    }
    return lamp;
  }
}
