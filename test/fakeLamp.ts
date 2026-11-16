/**
 * In-memory fake PlaiiinLight lamp for tests. Real HTTP server on 127.0.0.1 (random port) plus /ws.
 * Enforces the role ladder and the AI-key permission table from the firmware's docs/sharing-api.md and
 * answers with firmware-style errors (plain text for 400/403, JSON for frame/image errors).
 * Extend by adding a ROUTES entry or by using the `state` hooks (`delayMs`, `echoAuthOn500`, `override`).
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

export type Role = 'admin' | 'creator' | 'user' | 'ai';

export interface FakeLampOpts {
  deviceId: string; name: string;
  role?: Role; perms?: string[];
  grid?: { w: number; h: number };
  firmware?: string; form?: string; target?: string; swarmId?: string;
  hang?: boolean;
  maxBrightness?: number | null; onlyWhenOn?: boolean;
}

export interface FakeScene { [k: string]: unknown }

export interface FakeLampState {
  deviceId: string; name: string; role: Role; perms: string[];
  w: number; h: number; firmware: string; form: string; target: string;
  maxBrightness: number | null; onlyWhenOn: boolean;
  on: boolean; color: [number, number, number]; mode: 'api' | 'js' | 'stream' | 'frame';
  brightness: number; current: string | null; scene: string | null; fps: number;
  effects: Map<string, string>;               // name -> source (hardcoded ones have source '')
  hardcoded: Set<string>;
  params: Map<string, Record<string, unknown>>;
  formPrompt: string | null;
  frame: Buffer | null;
  /** Every frame POSTed to /api/frame, in order (copyImage: [new, previous]). */
  frames: Buffer[];
  images: Map<string, { w: number; h: number; label?: string; data: Buffer }>;
  scenes: Map<string, FakeScene>;
  swarm: { member: boolean; id: string; enabled: boolean; channel: number } | null; // null => 404
  whoamiPerms: boolean;                       // false: emulate old firmware (no perms in whoami)
  otaReceived: Buffer | null;
  /** When set, a received OTA image "reboots" the fake into this firmware version. */
  otaNextVersion: string | null;
  wsFrames: Buffer[];
  wsConnections: number; wsRefused: number;
  // test hooks / instrumentation
  requests: Array<{ method: string; path: string; auth: string | undefined }>;
  inFlight: number; maxConcurrency: number;
  delayMs: number;
  echoAuthOn500: boolean;
  lastAuthorization: string | undefined;
  /** Return true after writing a response to take over a request (checked before auth). */
  override?: (req: IncomingMessage, res: ServerResponse, path: string, body: Buffer) => boolean;
}

export interface FakeLamp { port: number; token: string; state: FakeLampState; close(): Promise<void> }

const LADDER: Record<string, number> = { user: 1, creator: 2, admin: 3 };
const AI_PERMS = ['control', 'effects', 'images', 'scenes', 'stream', 'ota', 'rename', 'swarm'];

type Min = 'open' | 'user' | 'creator' | 'admin';
interface Route { method: string; re: RegExp; min: Min; aiPerm?: string; handle: (c: Ctx) => void }
interface Ctx { s: FakeLampState; m: RegExpMatchArray; body: Buffer; res: ServerResponse; req: IncomingMessage; query: URLSearchParams }

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, ...headers });
    res.end(body);
  } else if (typeof body === 'string') {
    res.writeHead(status, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  } else {
    const t = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(t), ...headers });
    res.end(t);
  }
}
const ok = (res: ServerResponse, extra: object = {}) => send(res, 200, { status: 'ok', ...extra });
const json = (c: Ctx): any => { try { return JSON.parse(c.body.toString('utf8') || '{}'); } catch { return {}; } };

const ROUTES: Route[] = [
  { method: 'GET', re: /^\/api$/, min: 'open', handle: ({ s, res }) => send(res, 200, {
    vendor: 'plaiiin', apiVersion: '1', firmwareVersion: s.firmware, nodeName: s.name, deviceId: s.deviceId,
    ledCount: s.w * s.h, ledType: 'ws2812', lampType: s.form, lampForm: s.form, modelName: s.form, modelVersion: 'v1',
    physicalW: s.w, physicalH: s.h, logicalW: s.w, logicalH: s.h, pixelGroupW: 1, pixelGroupH: 1,
  }) },
  { method: 'GET', re: /^\/api\/state$/, min: 'user', handle: ({ s, res }) => send(res, 200, {
    on: s.on, color: s.color, mode: s.mode, brightness: s.brightness, current: s.current, fps: s.fps, scene: s.scene,
  }) },
  { method: 'GET', re: /^\/api\/whoami$/, min: 'user', handle: ({ s, res }) => {
    if (s.role === 'ai' && s.whoamiPerms) send(res, 200, { role: 'ai', paired: true, perms: s.perms, maxBrightness: s.maxBrightness, onlyWhenOn: s.onlyWhenOn });
    else send(res, 200, { role: s.role, paired: s.role !== 'admin' });
  } },
  // control
  { method: 'POST', re: /^\/api\/power$/, min: 'user', aiPerm: 'control', handle: (c) => { c.s.on = !!json(c).on; ok(c.res); } },
  { method: 'POST', re: /^\/api\/color$/, min: 'user', aiPerm: 'control', handle: (c) => {
    const b = json(c); const first = b.color ?? b.colors?.[0];
    if (!Array.isArray(first)) return send(c.res, 400, 'bad color');
    c.s.color = first as FakeLampState["color"]; ok(c.res);
  } },
  { method: 'POST', re: /^\/api\/brightness$/, min: 'user', aiPerm: 'control', handle: (c) => {
    let v = Math.max(0, Math.min(255, Number(json(c).brightness)));
    if (c.s.role === 'ai' && c.s.maxBrightness !== null) v = Math.min(v, c.s.maxBrightness);
    c.s.brightness = v; ok(c.res, { brightness: v });
  } },
  { method: 'GET', re: /^\/api\/brightness$/, min: 'user', handle: ({ s, res }) => send(res, 200, { brightness: s.brightness }) },
  { method: 'POST', re: /^\/api\/mode$/, min: 'user', aiPerm: 'control', handle: (c) => modeSet(c) },
  { method: 'PUT', re: /^\/api\/mode$/, min: 'user', aiPerm: 'control', handle: (c) => modeSet(c) },
  { method: 'POST', re: /^\/api\/play$/, min: 'user', aiPerm: 'control', handle: (c) => {
    const f = json(c).file;
    if (!c.s.effects.has(f)) return send(c.res, 404, 'no such effect');
    c.s.current = f; c.s.mode = 'js'; c.s.scene = null; ok(c.res);
  } },
  { method: 'POST', re: /^\/api\/play\/(next|prev)$/, min: 'user', aiPerm: 'control', handle: (c) => {
    const names = [...c.s.effects.keys()]; if (!names.length) return ok(c.res);
    const i = names.indexOf(c.s.current ?? '');
    c.s.current = names[(i + (c.m[1] === 'next' ? 1 : names.length - 1) + (i < 0 ? 1 : 0)) % names.length]!;
    c.s.mode = 'js'; c.s.scene = null; ok(c.res);
  } },
  { method: 'GET', re: /^\/api\/play\/current$/, min: 'user', handle: ({ s, res }) => send(res, 200, {
    current: s.current, playing: s.mode === 'js' ? s.current : null }) },
  { method: 'POST', re: /^\/api\/stop$/, min: 'user', aiPerm: 'control', handle: (c) => { c.s.current = null; ok(c.res); } },
  { method: 'POST', re: /^\/api\/fade$/, min: 'creator', aiPerm: 'control', handle: (c) => ok(c.res) },
  { method: 'POST', re: /^\/api\/name$/, min: 'admin', aiPerm: 'rename', handle: (c) => {
    const n = json(c).name;
    if (typeof n !== 'string' || !n || Buffer.byteLength(n) > 32 || /["\\\x00-\x1f]/.test(n)) return send(c.res, 400, 'bad name');
    c.s.name = n; ok(c.res, { rebooting: true });
  } },
  // effects
  { method: 'GET', re: /^\/api\/js$/, min: 'user', handle: ({ s, res }) => {
    const names = [...s.effects.keys()];
    send(res, 200, { scripts: names, playing: s.current, effects: names.map((name) => ({
      name, description: '', tags: [], source: s.hardcoded.has(name) ? 'hardcoded' : 'script' })) });
  } },
  { method: 'POST', re: /^\/api\/js\/validate$/, min: 'creator', aiPerm: 'effects', handle: (c) => validate(c) },
  { method: 'POST', re: /^\/api\/js\/compile$/, min: 'creator', aiPerm: 'effects', handle: (c) => {
    if (/SYNTAXERR/.test(c.body.toString('utf8'))) return send(c.res, 400, { status: 'error', message: 'script error: SyntaxError' });
    send(c.res, 200, Buffer.from([0x50, 0x4c, 0x42, 0x43]));                                // 4 bytes of "bytecode"
  } },
  { method: 'GET', re: /^\/api\/js\/([\w-]+)\/params$/, min: 'user', handle: ({ s, m, res }) => {
    if (!s.effects.has(m[1]!)) return send(res, 404, { status: 'error', message: 'not found' });
    send(res, 200, paramSchema(s, m[1]!));
  } },
  { method: 'PUT', re: /^\/api\/js\/([\w-]+)\/params$/, min: 'user', aiPerm: 'effects', handle: (c) => {
    if (!c.s.effects.has(c.m[1]!)) return send(c.res, 404, { status: 'error', message: 'not found' });
    c.s.params.set(c.m[1]!, { ...(c.s.params.get(c.m[1]!) ?? {}), ...json(c) });
    send(c.res, 200, paramSchema(c.s, c.m[1]!));
  } },
  { method: 'GET', re: /^\/api\/js\/([\w-]+)$/, min: 'user', handle: ({ s, m, res }) => {
    const src = s.effects.get(m[1]!);
    if (src === undefined) return send(res, 404, { status: 'error', message: 'not found' });
    if (s.hardcoded.has(m[1]!)) return send(res, 404, { status: 'error', message: 'no source (hardcoded effect)' });
    send(res, 200, src, { 'Content-Type': 'application/javascript' });
  } },
  { method: 'PUT', re: /^\/api\/js\/([\w-]+)$/, min: 'creator', aiPerm: 'effects', handle: (c) => {
    const src = c.body.toString('utf8');
    if (c.s.hardcoded.has(c.m[1]!)) return send(c.res, 409, { status: 'error', message: 'name reserved (hardcoded effect)' });
    if (/SYNTAXERR/.test(src)) return send(c.res, 400, { status: 'error', message: 'script error: SyntaxError' });
    c.s.effects.set(c.m[1]!, src); ok(c.res, { name: c.m[1] });
  } },
  { method: 'DELETE', re: /^\/api\/js\/([\w-]+)$/, min: 'creator', aiPerm: 'effects', handle: (c) => {
    if (c.s.hardcoded.has(c.m[1]!)) return send(c.res, 409, { status: 'error', message: 'name reserved (hardcoded effect)' });
    if (!c.s.effects.delete(c.m[1]!)) return send(c.res, 404, { status: 'error', message: 'not found' });
    c.s.params.delete(c.m[1]!);
    if (c.s.current === c.m[1]) c.s.current = null;
    ok(c.res);
  } },
  { method: 'GET', re: /^\/api\/form-prompt$/, min: 'user', handle: ({ s, res }) => {
    const def = `A ${s.w}×${s.h} ${s.form}.`;
    send(res, 200, { form: s.form, default: def, effective: s.formPrompt ?? def, hasOverride: s.formPrompt !== null, ...(s.formPrompt !== null ? { override: s.formPrompt } : {}) });
  } },
  { method: 'PUT', re: /^\/api\/form-prompt$/, min: 'creator', handle: (c) => { c.s.formPrompt = c.body.toString('utf8'); ok(c.res); } },
  { method: 'DELETE', re: /^\/api\/form-prompt$/, min: 'creator', handle: (c) => { c.s.formPrompt = null; ok(c.res); } },
  // frame + images
  { method: 'POST', re: /^\/api\/frame$/, min: 'creator', aiPerm: 'images', handle: (c) => {
    const n = c.s.w * c.s.h * 3;
    if (c.body.length !== n) return send(c.res, 400, { status: 'error', message: `expected ${n} bytes (${c.s.w}x${c.s.h}x3)` });
    c.s.frame = Buffer.from(c.body); c.s.frames.push(Buffer.from(c.body)); ok(c.res, { w: c.s.w, h: c.s.h });
  } },
  { method: 'GET', re: /^\/api\/frame$/, min: 'user', handle: ({ s, res }) => {
    if (!s.frame) return send(res, 404, { status: 'error', message: 'no frame stored' });
    send(res, 200, s.frame, { 'X-Frame-W': String(s.w), 'X-Frame-H': String(s.h) });
  } },
  { method: 'GET', re: /^\/api\/images$/, min: 'user', handle: ({ s, res }) => {
    const images = [...s.images].map(([name, i]) => ({ name, w: i.w, h: i.h, ...(i.label ? { label: i.label } : {}) }));
    send(res, 200, { status: 'ok', images, count: images.length, max: 30 });
  } },
  { method: 'POST', re: /^\/api\/images$/, min: 'creator', aiPerm: 'images', handle: (c) => {
    if (!c.s.frame) return send(c.res, 404, { status: 'error', message: 'no frame stored' });
    if (c.s.images.size >= 30) return send(c.res, 409, { status: 'error', message: 'image store full' });
    const label = json(c).label;
    if (label !== undefined && label !== null && (typeof label !== 'string' || Buffer.byteLength(label) > 32)) return send(c.res, 400, { status: 'error', message: 'bad label' });
    let n = 1; while (c.s.images.has(`img-${String(n).padStart(3, '0')}`)) n++;
    const name = `img-${String(n).padStart(3, '0')}`;
    c.s.images.set(name, { w: c.s.w, h: c.s.h, label: label || undefined, data: Buffer.from(c.s.frame) });
    ok(c.res, { name });
  } },
  { method: 'GET', re: /^\/api\/images\/([\w-]+)$/, min: 'user', handle: ({ s, m, res }) => {
    const i = s.images.get(m[1]!);
    if (!i) return send(res, 404, { status: 'error', message: 'no such image' });
    send(res, 200, i.data, { 'X-Frame-W': String(i.w), 'X-Frame-H': String(i.h) });
  } },
  { method: 'POST', re: /^\/api\/images\/([\w-]+)\/show$/, min: 'creator', aiPerm: 'images', handle: (c) => {
    const i = c.s.images.get(c.m[1]!);
    if (!i) return send(c.res, 404, { status: 'error', message: 'no such image' });
    if (i.w !== c.s.w || i.h !== c.s.h) return send(c.res, 400, { status: 'error', message: 'geometry mismatch' });
    c.s.frame = Buffer.from(i.data); c.s.mode = 'frame'; c.s.scene = null; ok(c.res);
  } },
  { method: 'POST', re: /^\/api\/images\/([\w-]+)\/label$/, min: 'creator', aiPerm: 'images', handle: (c) => {
    const i = c.s.images.get(c.m[1]!);
    if (!i) return send(c.res, 404, { status: 'error', message: 'no such image' });
    const label = json(c).label;
    if (label !== undefined && label !== null && (typeof label !== 'string' || Buffer.byteLength(label) > 32 || /[\x00-\x1f\x7f]/.test(label))) return send(c.res, 400, { status: 'error', message: 'bad label' });
    i.label = label || undefined; ok(c.res);
  } },
  { method: 'DELETE', re: /^\/api\/images\/([\w-]+)$/, min: 'creator', aiPerm: 'images', handle: (c) => {
    if (!c.s.images.delete(c.m[1]!)) return send(c.res, 404, { status: 'error', message: 'no such image' });
    ok(c.res);
  } },
  // scenes
  { method: 'GET', re: /^\/api\/scenes$/, min: 'user', handle: ({ s, res }) => send(res, 200, { scenes: [...s.scenes].map(([name, scene]) => ({ name, scene })) }) },
  { method: 'GET', re: /^\/api\/scenes\/([\w-]+)$/, min: 'user', handle: ({ s, m, res }) => {
    const sc = s.scenes.get(m[1]!); if (!sc) return send(res, 404, 'no such scene'); send(res, 200, sc);
  } },
  { method: 'PUT', re: /^\/api\/scenes\/([\w-]{1,32})$/, min: 'creator', aiPerm: 'scenes', handle: (c) => {
    if (!c.s.scenes.has(c.m[1]!) && c.s.scenes.size >= 32) return send(c.res, 507, 'scene store full');
    c.s.scenes.set(c.m[1]!, json(c)); ok(c.res);
  } },
  { method: 'DELETE', re: /^\/api\/scenes\/([\w-]+)$/, min: 'creator', aiPerm: 'scenes', handle: (c) => {
    if (!c.s.scenes.delete(c.m[1]!)) return send(c.res, 404, 'no such scene');
    if (c.s.scene === c.m[1]) c.s.scene = null;
    ok(c.res);
  } },
  { method: 'POST', re: /^\/api\/scenes\/([\w-]+)\/capture$/, min: 'creator', aiPerm: 'scenes', handle: (c) => {
    const s = c.s;
    const doc: FakeScene = s.mode === 'js' && s.current ? { script: s.current, params: s.params.get(s.current) ?? {} }
      : s.mode === 'frame' ? { mode: 'frame' } : { mode: 'api', color: s.color };
    doc.brightness = s.brightness;
    s.scenes.set(c.m[1]!, doc); ok(c.res, { name: c.m[1], scene: doc });
  } },
  { method: 'POST', re: /^\/api\/scenes\/([\w-]+)\/activate$/, min: 'user', aiPerm: 'control', handle: (c) => {
    const s = c.s; const sc = s.scenes.get(c.m[1]!);
    if (!sc) return send(c.res, 404, 'no such scene');
    if (typeof sc.script === 'string') {
      if (!s.effects.has(sc.script)) return send(c.res, 404, 'no such script');
      s.current = sc.script; s.mode = 'js';
      if (sc.params) s.params.set(sc.script, { ...(s.params.get(sc.script) ?? {}), ...(sc.params as object) });
    } else if (typeof sc.image === 'string') {
      const i = s.images.get(sc.image);
      if (!i) return send(c.res, 404, 'no such image');
      s.frame = Buffer.from(i.data); s.mode = 'frame';
    } else if (typeof sc.mode === 'string') s.mode = sc.mode as FakeLampState['mode'];
    if (Array.isArray(sc.color)) s.color = sc.color as FakeLampState['color'];
    if (typeof sc.brightness === 'number') s.brightness = sc.brightness;
    if (typeof sc.on === 'boolean') s.on = sc.on;
    s.scene = c.m[1]!;
    ok(c.res, { scene: sc });
  } },
  // system
  { method: 'GET', re: /^\/api\/swarm$/, min: 'admin', aiPerm: 'swarm', handle: ({ s, res }) => s.swarm ? send(res, 200, s.swarm) : send(res, 404, 'not applicable') },
  { method: 'GET', re: /^\/api\/swarm\/stats$/, min: 'admin', aiPerm: 'swarm', handle: ({ res }) => send(res, 200, {
    tx: 0, rx: 0, txFail: 0, lastFrom: '00:00:00:00:00:00', dropAuth: 0, dropReplay: 0, relayed: 0, applied: 0, stackFree: 0 }) },
  { method: 'GET', re: /^\/api\/ota\/info$/, min: 'user', handle: ({ s, res }) => send(res, 200, {
    version: s.firmware, date: 'Jan  1 2026', time: '00:00:00', partition: 'ota_0', idf: 'v5.3.2', form: s.form, target: s.target }) },
  { method: 'POST', re: /^\/api\/ota$/, min: 'admin', aiPerm: 'ota', handle: (c) => {
    c.s.otaReceived = Buffer.from(c.body);
    if (c.s.otaNextVersion) c.s.firmware = c.s.otaNextVersion;
    ok(c.res);
  } },
];

function modeSet(c: Ctx): void {
  const m = json(c).mode;
  if (!['stream', 'api', 'js', 'frame'].includes(m)) return send(c.res, 400, 'bad mode');
  c.s.mode = m; c.s.scene = null; ok(c.res);
}
function validate(c: Ctx): void {
  const src = c.body.toString('utf8');
  if (/SYNTAXERR/.test(src)) return send(c.res, 400, { status: 'error', message: 'script error: SyntaxError' });
  ok(c.res);
}

/** Built-in effects' params (the firmware serves them from the effect descriptor). */
const BUILTIN_PARAMS: Record<string, Array<{ name: string; min: number; max: number; default: number; description: string }>> = {
  rainbow: [{ name: 'speed', min: 0, max: 10, default: 1, description: 'cycle speed' }],
  carousel: [],
};
const PARAM_RE = /^\s*\/\/\s*@param\s+([A-Za-z_]\w*)\s+(-?[\d.eE+]+)\s*\.\.\s*(-?[\d.eE+]+)\s*=\s*(-?[\d.eE+]+)\s*(.*)$/;

/** `GET /api/js/<n>/params`: `{items:[{name,min,max,default,value,description}]}` from @param lines (or the built-in table) + stored values. */
function paramSchema(s: FakeLampState, name: string): { items: Array<Record<string, unknown>> } {
  const defs = s.hardcoded.has(name) ? (BUILTIN_PARAMS[name] ?? []) : (s.effects.get(name) ?? '').split('\n').flatMap((l) => {
    const m = PARAM_RE.exec(l);
    return m ? [{ name: m[1]!, min: Number(m[2]), max: Number(m[3]), default: Number(m[4]), description: m[5]!.trim() }] : [];
  });
  const vals = s.params.get(name) ?? {};
  const items: Array<Record<string, unknown>> = defs.map((d) => ({ ...d, value: typeof vals[d.name] === 'number' ? vals[d.name] : d.default }));
  for (const [k, v] of Object.entries(vals)) if (!defs.some((d) => d.name === k)) items.push({ name: k, min: 0, max: 255, default: 0, value: v, description: '' });
  return { items };
}

/** Role for a bearer token (admin when the lamp is "unpaired": role admin and no token sent). */
function resolveRole(s: FakeLampState, token: string, auth: string | undefined): Role | null {
  if (auth === `Bearer ${token}`) return s.role;
  if (!auth && s.role === 'admin') return 'admin';
  return null;
}

/** null = allowed, else the 403 text. */
function deny(s: FakeLampState, role: Role, r: Route): string | null {
  if (r.min === 'open') return null;
  if (role === 'ai') {
    if (r.method === 'GET' && r.min === 'user' && !r.aiPerm) return null;                       // plain user reads
    if (!r.aiPerm) return 'insufficient role';                                                  // never grantable
    if (!s.perms.includes(r.aiPerm)) return 'not permitted for this AI key';
    if (r.method === 'GET') return null;                                                        // reads are exempt from only-while-on
    if (s.onlyWhenOn && !s.on && r.method + r.re.source !== 'POST' + /^\/api\/power$/.source) return 'lamp is off';
    return null;
  }
  return (LADDER[role] ?? 0) >= LADDER[r.min]! ? null : 'insufficient role';
}

export function startFakeLamp(opts: FakeLampOpts): Promise<FakeLamp> {
  const token = `tok-${opts.deviceId}-${Math.random().toString(36).slice(2, 10)}`;
  const role = opts.role ?? 'admin';
  const w = opts.grid?.w ?? 8, h = opts.grid?.h ?? 8;
  const s: FakeLampState = {
    deviceId: opts.deviceId, name: opts.name, role,
    perms: role === 'ai' ? (opts.perms ?? []).filter((p) => AI_PERMS.includes(p)) : [],
    w, h, firmware: opts.firmware ?? '2.8.0', form: opts.form ?? 'display', target: opts.target ?? 'esp32',
    maxBrightness: opts.maxBrightness ?? null, onlyWhenOn: opts.onlyWhenOn ?? false,
    on: false, color: [255, 255, 255], mode: 'api', brightness: 128, current: null, scene: null, fps: 30,
    effects: new Map([['rainbow', ''], ['carousel', '']]), hardcoded: new Set(['rainbow', 'carousel']),
    params: new Map(), formPrompt: null, frame: null, frames: [], images: new Map(), scenes: new Map(),
    swarm: opts.swarmId ? { member: true, id: opts.swarmId, enabled: true, channel: 1 } : { member: false, id: '', enabled: false, channel: 1 },
    whoamiPerms: true, otaReceived: null, otaNextVersion: null, wsFrames: [], wsConnections: 0, wsRefused: 0,
    requests: [], inFlight: 0, maxConcurrency: 0, delayMs: 0, echoAuthOn500: false, lastAuthorization: undefined,
  };

  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((req, res) => {
    if (opts.hang) return;                                  // accept, never answer
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      s.inFlight++; s.maxConcurrency = Math.max(s.maxConcurrency, s.inFlight);
      try {
        if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
        handle(req, res, Buffer.concat(chunks));
      } finally { s.inFlight--; }
    });
  });
  server.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });

  function handle(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const auth = req.headers.authorization;
    s.lastAuthorization = auth;
    s.requests.push({ method: req.method ?? '', path, auth });
    if (s.override?.(req, res, path, body)) return;
    if (s.echoAuthOn500) return send(res, 500, `internal error; request was ${req.method} ${req.url} Authorization: ${auth ?? ''}`);
    const route = ROUTES.find((r) => r.method === req.method && r.re.test(path));
    if (!route) return send(res, 404, 'not found');
    if (route.min !== 'open') {
      const who = resolveRole(s, token, auth);
      if (!who) return send(res, 401, 'unauthorized');
      const d = deny(s, who, route);
      if (d) return send(res, 403, d);
    }
    route.handle({ s, m: path.match(route.re)!, body, res, req, query: url.searchParams });
  }

  // /ws: record binary frames. A refusal completes the upgrade, then closes (no HTTP 403).
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (opts.hang) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const t = url.searchParams.get('token');
    const who = resolveRole(s, token, t ? `Bearer ${t}` : req.headers.authorization);
    const allowed = who !== null && (who !== 'ai' || s.perms.includes('stream')) && !(who === 'ai' && s.onlyWhenOn && !s.on);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!allowed) { s.wsRefused++; ws.close(); return; }
      s.wsConnections++;
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const b = Buffer.from(data as Buffer);
        s.wsFrames.push(b);
        if (b[0] === 0x02) s.on = b[1] === 1;
        if (b[0] === 0x01) s.mode = 'stream';
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port, token, state: s,
        close: () => new Promise<void>((r) => {
          for (const c of wss.clients) c.terminate();
          for (const sock of sockets) sock.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}
