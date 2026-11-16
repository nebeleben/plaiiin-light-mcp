import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type FleetRole = 'admin' | 'creator' | 'user' | 'ai';

/** One known lamp. Identity is `deviceId`; host/port are a cache. Never holds a secret. */
export interface FleetLamp {
  deviceId: string; name: string; host: string; port: number;
  role: FleetRole; perms?: string[]; maxBrightness?: number | null; onlyWhenOn?: boolean;
  form?: string; target?: string; grid?: { w: number; h: number }; firmware?: string;
  swarmId?: string | null; shared: boolean; lastSeen: string;
}

const FIELDS: ReadonlyArray<keyof FleetLamp> = [
  'deviceId', 'name', 'host', 'port', 'role', 'perms', 'maxBrightness', 'onlyWhenOn',
  'form', 'target', 'grid', 'firmware', 'swarmId', 'shared', 'lastSeen',
];

/** Only the known fields survive, so a secret passed by mistake is never written. */
function clean(l: FleetLamp): FleetLamp {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) if (l[k] !== undefined) out[k] = l[k];
  return out as unknown as FleetLamp;
}

/** `<dir>/fleet.json` — `{ "lamps": [...] }`, rewritten atomically (tmp file + rename). */
export class FleetStore {
  private readonly file: string;
  private lamps: FleetLamp[];
  /** Set when fleet.json exists but couldn't be read or moved aside: saving would destroy it. */
  private locked: string | null = null;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'fleet.json');
    this.lamps = this.load();
  }

  list(): FleetLamp[] {
    return this.lamps.map((l) => ({ ...l }));
  }

  /** By exact deviceId, else by name (case-insensitive). */
  get(idOrName: string): FleetLamp | undefined {
    const want = idOrName.trim();
    const l = this.lamps.find((x) => x.deviceId === want)
      ?? this.lamps.find((x) => x.name.toLowerCase() === want.toLowerCase());
    return l ? { ...l } : undefined;
  }

  upsert(l: FleetLamp): void {
    const c = clean(l);
    const i = this.lamps.findIndex((x) => x.deviceId === c.deviceId);
    if (i >= 0) this.lamps[i] = c; else this.lamps.push(c);
    this.save();
  }

  remove(deviceId: string): void {
    const n = this.lamps.length;
    this.lamps = this.lamps.filter((x) => x.deviceId !== deviceId);
    if (this.lamps.length !== n) this.save();
  }

  /**
   * Missing file → empty. A file that exists but can't be read (permissions, I/O error) → empty and
   * locked: saves throw, so the file on disk is never replaced by a partial list. Unparsable JSON, or
   * JSON without a `lamps` list → moved aside to `fleet.json.bad-<ms>` and start empty (locked
   * instead if the move fails). One stderr line either way, so the server still comes up. Entries
   * without a deviceId or name are dropped.
   */
  private load(): FleetLamp[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      return this.lock(`can't read ${this.file} (${code ?? String(e)})`);
    }
    let j: unknown;
    try { j = JSON.parse(text); } catch { return this.moveAside('is not valid JSON'); }
    const lamps = (j as { lamps?: unknown } | null)?.lamps;
    if (!Array.isArray(lamps)) return this.moveAside('has no "lamps" list');
    return lamps
      .filter((l): l is FleetLamp => !!l && typeof l === 'object'
        && typeof (l as FleetLamp).deviceId === 'string' && !!(l as FleetLamp).deviceId
        && typeof (l as FleetLamp).name === 'string' && !!(l as FleetLamp).name)
      .map(clean);
  }

  private moveAside(why: string): FleetLamp[] {
    const bad = `${this.file}.bad-${Date.now()}`;
    try {
      renameSync(this.file, bad);
    } catch (e) {
      return this.lock(`${this.file} ${why} and couldn't be moved aside (${(e as NodeJS.ErrnoException).code ?? String(e)})`);
    }
    process.stderr.write(`plaiiin-lamps: ${this.file} ${why}; moved it to ${bad} and started with no lamps\n`);
    return [];
  }

  private lock(why: string): FleetLamp[] {
    this.locked = why;
    process.stderr.write(`plaiiin-lamps: ${why}; started with no lamps and won't save until it is fixed\n`);
    return [];
  }

  private save(): void {
    if (this.locked) {
      throw new Error(`${this.locked}; not overwriting it — fix the file (or move it away) and restart the assistant`);
    }
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lamps: this.lamps }, null, 2) + '\n');
    renameSync(tmp, this.file);
  }
}
