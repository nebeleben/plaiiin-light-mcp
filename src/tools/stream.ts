import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { z } from 'zod';
import WebSocket from 'ws';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Need } from '../lamp/access';
import { CLEAR_FRAME, encodeColorFrame, prepareSource, type FrameSource, type PreparedSource, type StreamSource } from '../stream/sources';
import { scrub } from '../util/scrub';
import { errorText, explain, failure, guard, lampsArg, normLamps, result, type ToolContext } from './context';
import { gridOf } from './images';
import { lanLookup } from '../lamp/lookup';

/** `/ws` (firmware docs/sharing-api.md): any share key with user access; AI keys need `stream`. */
const STREAM: Need = { perm: 'stream', minRole: 'user' };
/** A lamp refuses a stream by completing the upgrade and closing at once (no HTTP 403 on /ws). */
const REFUSE_GRACE_MS = 250;
const CONNECT_TIMEOUT_MS = 5000;
/** Frames waiting in a socket's send buffer before further frames are dropped (slow Wi-Fi). */
const MAX_QUEUED_FRAMES = 3;
const RECENT = 5;
/** A lamp that doesn't take the closing clear frame within this is cut off (a stop must never hang). */
const CLEAR_TIMEOUT_MS = 1500;

type ConnState = 'streaming' | 'ended' | 'stopped' | 'replaced' | 'closed by the lamp' | 'failed';

interface Conn {
  lamp: string; deviceId: string; grid: { w: number; h: number };
  ws: WebSocket; src: FrameSource; abort: AbortController;
  sent: number; dropped: number; state: ConnState; reason?: string;
  done?: Promise<void>;
}

interface Stream {
  id: string; fps: number; seconds: number; source: string;
  startedAt: number; endsAt: number; conns: Conn[];
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted || ms <= 0) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done);
});

/** What a source is, for listings (file names only, never a script body). */
function describeSource(src: StreamSource): string {
  if ('gifPath' in src) return `GIF ${basename(src.gifPath)}`;
  if ('pngPaths' in src) return src.pngPaths.length === 1 ? `PNG ${basename(src.pngPaths[0]!)}` : `${src.pngPaths.length} PNG frames`;
  return 'script';
}

/**
 * Open `ws://host:port/ws?token=…` and wait until the lamp has kept it open for a moment. The URL
 * carries the key: it never leaves this function, and errors are scrubbed (and the token masked).
 */
function openSocket(host: string, port: number, token: string | undefined): Promise<WebSocket> {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = `ws://${h}:${port}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const clean = (s: string) => scrub(token ? s.split(token).join('***').split(encodeURIComponent(token)).join('***') : s);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS, perMessageDeflate: false, lookup: lanLookup as never });
    let settled = false;
    const fail = (why: string) => { if (!settled) { settled = true; ws.terminate(); reject(new Error(clean(why))); } };
    ws.on('error', (e) => fail(`can't open the stream to ${host}:${port}: ${e.message}`));
    ws.once('close', () => fail(
      'the lamp closed the stream right after connecting — its key may lack the `stream` permission, or the lamp is off and the key only works while it is on',
    ));
    ws.once('open', () => setTimeout(() => {
      if (settled || ws.readyState !== WebSocket.OPEN) return;
      settled = true;
      resolve(ws);
    }, REFUSE_GRACE_MS));
  });
}

/** Live streams of this server process. One connection per lamp; a lamp is only ever in one stream. */
export class StreamManager {
  private readonly active = new Map<string, Stream>();
  private readonly recent: unknown[] = [];
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * Hold the start lock of every lamp in `ids` (taken in sorted order, so two starts can't deadlock)
   * until the returned release is called: two concurrent stream_starts to one lamp can't both open sockets.
   */
  async lock(ids: string[]): Promise<() => void> {
    const releases: Array<() => void> = [];
    for (const id of [...new Set(ids)].sort()) {
      const prev = this.locks.get(id) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => { release = r; });
      const chained = prev.then(() => mine);
      this.locks.set(id, chained);
      await prev;
      releases.push(() => { release(); if (this.locks.get(id) === chained) this.locks.delete(id); });
    }
    return () => { for (const r of releases) r(); };
  }

  list() {
    return { streams: [...this.active.values()].map((s) => this.describe(s)), recent: [...this.recent] };
  }

  /** Stop one stream, or all of them. Each lamp gets a clear frame before its socket closes. */
  async stop(id?: string): Promise<string[]> {
    const ids = id === undefined ? [...this.active.keys()] : this.active.has(id) ? [id] : [];
    await Promise.all(ids.map(async (sid) => {
      const s = this.active.get(sid)!;
      for (const c of s.conns) if (c.state === 'streaming') { c.state = 'stopped'; c.abort.abort(); }
      await Promise.all(s.conns.map((c) => c.done));
    }));
    return ids;
  }

  /** Take a lamp out of whatever stream it is in (a new stream to it replaces the old one). */
  async release(deviceId: string): Promise<string | undefined> {
    for (const s of this.active.values()) {
      const c = s.conns.find((x) => x.deviceId === deviceId && x.state === 'streaming');
      if (c) { c.state = 'replaced'; c.abort.abort(); await c.done; return s.id; }
    }
    return undefined;
  }

  start(conns: Conn[], fps: number, seconds: number, source: string): Stream {
    let id: string;
    do id = `s-${randomBytes(4).toString('hex')}`; while (this.active.has(id));
    const now = Date.now();
    const s: Stream = { id, fps, seconds, source, startedAt: now, endsAt: now + seconds * 1000, conns };
    this.active.set(id, s);
    for (const c of conns) c.done = this.run(s, c);
    void Promise.all(conns.map((c) => c.done)).then(() => {
      this.active.delete(id);
      this.recent.unshift({ ...this.describe(s), endedAt: new Date().toISOString() });
      this.recent.length = Math.min(this.recent.length, RECENT);
    });
    return s;
  }

  closeAll(): void {
    for (const s of this.active.values()) for (const c of s.conns) { c.abort.abort(); c.ws.terminate(); }
  }

  private describe(s: Stream) {
    return {
      streamId: s.id, source: s.source, fps: s.fps, seconds: s.seconds,
      startedAt: new Date(s.startedAt).toISOString(), endsAt: new Date(s.endsAt).toISOString(),
      lamps: s.conns.map((c) => ({
        lamp: c.lamp, deviceId: c.deviceId, grid: c.grid, state: c.state, framesSent: c.sent,
        ...(c.dropped ? { framesDropped: c.dropped } : {}), ...(c.reason ? { reason: c.reason } : {}),
      })),
    };
  }

  /** Frame i is due at start + i/fps; a slow source delays frames rather than skipping them. */
  private async run(s: Stream, c: Conn): Promise<void> {
    const signal = c.abort.signal;
    c.ws.on('close', (code) => {
      if (c.state === 'streaming') { c.state = 'closed by the lamp'; c.reason = `the lamp closed the stream (code ${code})`; c.abort.abort(); }
    });
    const frameBytes = 3 + c.grid.w * c.grid.h * 3;
    // One abort promise per connection (not a listener per frame): a stop during a batch render returns at once.
    const aborted = new Promise<undefined>((r) => {
      if (signal.aborted) r(undefined); else signal.addEventListener('abort', () => r(undefined), { once: true });
    });
    try {
      for (let i = 0; ; i++) {
        const due = s.startedAt + (i * 1000) / s.fps;
        if (due >= s.endsAt) break;
        await sleep(due - Date.now(), signal);
        if (signal.aborted) break;
        let frame: Uint8Array | undefined;
        try {
          // The render finishes in the background after a stop.
          frame = await Promise.race([c.src(i), aborted]);
        } catch (e) {
          c.state = 'failed'; c.reason = errorText(e); break;
        }
        if (!frame || signal.aborted || c.ws.readyState !== WebSocket.OPEN) break;
        if (c.ws.bufferedAmount > MAX_QUEUED_FRAMES * frameBytes) { c.dropped++; continue; }
        c.ws.send(encodeColorFrame(frame));
        c.sent++;
      }
    } finally {
      if (c.state === 'streaming') c.state = 'ended';
      if (c.ws.readyState === WebSocket.OPEN) {
        let timer: NodeJS.Timeout | undefined;
        const sent = await Promise.race([
          new Promise<boolean>((r) => c.ws.send(CLEAR_FRAME, (e) => r(!e))),
          new Promise<boolean>((r) => { timer = setTimeout(() => r(false), CLEAR_TIMEOUT_MS); }),
        ]);
        clearTimeout(timer);
        if (sent) c.ws.close(1000); else c.ws.terminate();
      }
    }
  }
}

export function registerStreamTools(server: McpServer, ctx: ToolContext): StreamManager {
  const streams = new StreamManager();
  const prev = server.server.onclose;
  server.server.onclose = () => { streams.closeAll(); prev?.(); };

  server.registerTool('stream_start', {
    title: 'Stream frames to lamps',
    description:
      'Stream an animation live to lamps over their WebSocket (`/ws`) for `seconds` (default 30, at most 600) at `fps` ' +
      '(1–30, default 20). `source` is one of: `{gifPath}` — an animated GIF on this computer (≤ 16 MB, ≤ 4096×4096, ' +
      '≤ 1000 frames; its own frame delays are kept); `{pngPaths}` — PNG files played in order, one per frame; ' +
      '`{script, params?}` — a `shade()` effect script rendered on this computer in a sandbox (as effect_preview; ' +
      '@state values restart every 2 s batch). Every frame is resized to each lamp\'s logical grid and the source loops. ' +
      'Returns at once with a `streamId`; nothing is saved on the lamp, and it goes back to what it showed when the ' +
      'stream ends (stream_stop, or the time is up). A lamp already streaming is taken over. Needs the `stream` ' +
      'permission on AI keys (a stream can also switch the lamp on), any share key otherwise. ' +
      'Returns `{streamId, results}` with one result per lamp: `{lamp, ok: true, grid}` or `{lamp, ok: false, skipped?, reason}`.',
    inputSchema: {
      lamps: lampsArg,
      source: z.union([
        z.object({ gifPath: z.string().min(1).describe('Absolute path of an animated GIF') }).strict(),
        z.object({ pngPaths: z.array(z.string().min(1)).min(1).max(1000).describe('Absolute paths of PNG frames, in order') }).strict(),
        z.object({
          script: z.string().min(1).max(32768).describe('JavaScript defining `function shade(x, y, idx, frame, base, params)`'),
          params: z.record(z.string(), z.number()).optional().describe('Tune values by param name'),
        }).strict(),
      ]).describe('What to stream: {gifPath} | {pngPaths} | {script, params?}'),
      fps: z.number().int().min(1).max(30).default(20).describe('Frames per second (1–30, default 20)'),
      seconds: z.number().positive().max(600).default(30).describe('How long to stream (default 30, at most 600)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(async () => {
    const targets = ctx.registry.resolveTargets(normLamps(args.lamps));
    const src = args.source as StreamSource;
    let prepared: PreparedSource;
    try { prepared = prepareSource(src); } catch (e) { return failure(errorText(e)); }
    const byGrid = new Map<string, FrameSource>();
    const sourceFor = (w: number, h: number) => {
      const k = `${w}x${h}`;
      let f = byGrid.get(k);
      if (!f) { f = prepared.forGrid(w, h, args.fps); byGrid.set(k, f); }
      return f;
    };
    const conns: Conn[] = [];
    const refusals = new Map(await Promise.all(targets.map(async (l) => [l.deviceId, await ctx.registry.refusalFresh(l, STREAM)] as const)));
    const unlock = await streams.lock(targets.filter((l) => !refusals.get(l.deviceId)).map((l) => l.deviceId));
    try {
      const results = await Promise.all(targets.map(async (l) => {
        const base = { lamp: l.name, deviceId: l.deviceId };
        const refused = refusals.get(l.deviceId);
        if (refused) return { ...base, ok: false as const, skipped: true as const, reason: refused };
        try {
          const grid = await ctx.registry.call(l.deviceId, (c, fl) => gridOf(c, fl));
          const frames = sourceFor(grid.w, grid.h);
          await frames(0); // a broken script fails here, before the lamp is touched
          const replaced = await streams.release(l.deviceId);
          const ep = await ctx.registry.endpoint(l.deviceId);
          const ws = await openSocket(ep.host, ep.port, ep.token);
          ws.on('error', () => { /* reported through 'close' */ });
          conns.push({ lamp: l.name, deviceId: l.deviceId, grid, ws, src: frames, abort: new AbortController(), sent: 0, dropped: 0, state: 'streaming' });
          return { ...base, ok: true as const, grid, ...(replaced ? { replaced } : {}) };
        } catch (e) {
          return { ...base, ok: false as const, reason: explain(e, l, STREAM) };
        }
      }));
      if (!conns.length) return result({ results }, true);
      // Keep target order for the connections (Promise.all above finishes in any order).
      conns.sort((a, b) => targets.findIndex((t) => t.deviceId === a.deviceId) - targets.findIndex((t) => t.deviceId === b.deviceId));
      const s = streams.start(conns, args.fps, args.seconds, describeSource(src));
      return result({ streamId: s.id, fps: s.fps, seconds: s.seconds, endsAt: new Date(s.endsAt).toISOString(), results });
    } finally {
      unlock();
    }
  }));

  server.registerTool('stream_stop', {
    title: 'Stop streaming',
    description:
      'Stop a stream started by stream_start (or every stream when `streamId` is omitted). Each lamp gets a clear frame, ' +
      'then its connection closes and the lamp goes back to what it showed before. Returns the stopped stream ids.',
    inputSchema: { streamId: z.string().min(1).optional().describe('Stream id from stream_start; omit to stop all') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ streamId }) => guard(async () => {
    const stopped = await streams.stop(streamId);
    return result({ stopped, ...(streamId !== undefined && !stopped.length ? { note: `no running stream ${scrub(streamId)} (it may have ended already)` } : {}) });
  }));

  server.registerTool('streams_list', {
    title: 'List streams',
    description: 'Running streams of this session (id, source, fps, end time, and per lamp: state and frames sent), plus the last few that ended and why. Read-only.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => guard(async () => result(streams.list())));

  return streams;
}
