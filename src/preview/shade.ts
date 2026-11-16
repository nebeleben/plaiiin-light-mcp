import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Byte-identical copy of the firmware's portal/shade-runtime.js (scripts/check-vendor.mjs), bundled as text
// and handed to the worker over stdin.
import RUNTIME from '../../vendor/shade-runtime.js?raw';

export interface Rgb { r: number; g: number; b: number }
export interface RenderOpts {
  w: number; h: number; frames: number; fps: number;
  params?: Record<string, number>; base?: Rgb;
  /** First frame number (default 0): frames start..start+frames-1 are rendered (time = frame·1000/fps). */
  start?: number;
  /** Budget for running the script (default 3000 ms); the worker is killed shortly after. */
  timeoutMs?: number;
}
export interface ParamInfo { name: string; min: number; max: number; def: number; desc: string; type: 'range' | 'switch' }
export interface ScriptInfo {
  params: ParamInfo[];
  frameState: Array<{ name: string; def: number }>;
  pixelState: Array<{ name: string; def: number }>;
  mode: 'strip' | 'mirror' | null;
  modeSwitch: boolean;
}

export const MAX_PIXELS = 16384;
export const MAX_FRAMES = 60;
export const WORKER_HEAP_MB = 128;
/** Defence in depth: the worker's resident size is polled and it is killed above this. */
export const WORKER_RSS_MB = 512;
export const MAX_WIDTH = 4096;
const RSS_POLL_MS = 150;
/** Node startup + JSON transfer on top of the script budget before the watchdog kills the worker. */
const STARTUP_MS = 2000;
const MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * The worker ships next to this module: src/preview/preview-worker.mjs in tests, and
 * plugin/dist/preview-worker.mjs in the bundle (second esbuild entry, see esbuild.mjs).
 */
const WORKER = fileURLToPath(new URL('./preview-worker.mjs', import.meta.url));
const PERMISSION = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';

interface Job { op: 'inspect' | 'render'; source: string; w?: number; h?: number; frames?: number; fps?: number; start?: number; params?: Record<string, number>; base?: Rgb }
interface WorkerOut { info: ScriptInfo; frames?: string[] }

/**
 * Run one job in a fresh Node process: permission model on (it may read only its own file — no
 * fs writes, child processes, workers or addons), a 128 MB heap, an empty environment, and a
 * wall-clock watchdog that SIGKILLs it. The script itself runs in a vm context inside it. This
 * process only parses the worker's JSON output, never touches objects the script made.
 */
function runWorker(job: Job, timeoutMs: number): Promise<WorkerOut> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      PERMISSION, `--allow-fs-read=${WORKER}`, `--max-old-space-size=${WORKER_HEAP_MB}`, WORKER,
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: {}, windowsHide: true });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    let why: string | undefined;
    const kill = (reason: string) => { why ??= reason; child.kill('SIGKILL'); };
    const watchdog = setTimeout(() => kill(`script timed out after ${timeoutMs} ms (endless loop?)`), timeoutMs + STARTUP_MS);
    const rss = process.platform === 'win32' ? undefined : setInterval(() => {
      if (child.pid === undefined || child.exitCode !== null) return;
      execFile('ps', ['-o', 'rss=', '-p', String(child.pid)], (e, out) => {
        const kb = Number(String(out).trim());
        if (!e && kb > WORKER_RSS_MB * 1024) kill(`script ran out of memory (preview limit ${WORKER_RSS_MB} MB resident)`);
      });
    }, RSS_POLL_MS);
    child.stdout.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen > MAX_OUTPUT) kill('preview output too large'); else out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => { if (err.length < 8192) err += d.toString('utf8'); });
    child.stdin.on('error', () => { /* the worker died early; reported on close */ });
    child.on('error', (e) => { clearTimeout(watchdog); clearInterval(rss); reject(new Error(`preview worker failed to start: ${e.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(watchdog);
      clearInterval(rss);
      if (why) return reject(new Error(why));
      let res: { ok?: WorkerOut; error?: unknown } | undefined;
      try { res = JSON.parse(Buffer.concat(out).toString('utf8')) as typeof res; } catch { res = undefined; }
      if (res && typeof res.error === 'string') {
        return reject(new Error(res.error === 'timeout' ? `script timed out after ${timeoutMs} ms (endless loop?)` : res.error));
      }
      if (res?.ok && code === 0) return resolve(res.ok);
      if (/heap out of memory|Allocation failed/i.test(err) || signal === 'SIGABRT' || code === 134) {
        return reject(new Error(`script ran out of memory (preview limit ${WORKER_HEAP_MB} MB)`));
      }
      reject(new Error(`preview worker failed (${signal ?? `exit ${code}`})`));
    });
    child.stdin.end(JSON.stringify({ runtime: RUNTIME, timeoutMs, req: job }));
  });
}

function checkGrid(o: RenderOpts): void {
  const { w, h, frames, fps } = o;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > MAX_PIXELS || w > MAX_WIDTH) throw new Error(`grid must be at least 1×1, at most ${MAX_WIDTH} wide and at most ${MAX_PIXELS} pixels`);
  if (!Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES) throw new Error(`frames must be 1–${MAX_FRAMES}`);
  if (!(fps > 0)) throw new Error('fps must be > 0');
  if (o.start !== undefined && (!Number.isInteger(o.start) || o.start < 0)) throw new Error('start must be a whole number ≥ 0');
}

/** The script's `// @param`, `// @state`, `// @mode` annotations, as the lamp reads them. */
export async function inspectScript(source: string): Promise<ScriptInfo> {
  return (await runWorker({ op: 'inspect', source }, 1000)).info;
}

/**
 * Render a script's first frames with the lamp's own runtime (vendored shade-runtime.js) in a
 * sandboxed worker process, plus its annotations. Frame f (from `start`, default 0) runs at time f·1000/fps ms; each frame is
 * w·h·3 bytes (RGB, row-major). Rejects with the script's error, a timeout or out-of-memory.
 */
export async function previewScript(source: string, opts: RenderOpts): Promise<{ info: ScriptInfo; frames: Uint8Array[] }> {
  checkGrid(opts);
  const { w, h, frames, fps } = opts;
  const r = await runWorker(
    { op: 'render', source, w, h, frames, fps, ...(opts.start ? { start: opts.start } : {}), params: opts.params ?? {}, ...(opts.base ? { base: opts.base } : {}) },
    opts.timeoutMs ?? 3000,
  );
  const n = w * h * 3;
  const out = (r.frames ?? []).map((b) => new Uint8Array(Buffer.from(b, 'base64')));
  if (out.length !== frames || out.some((f) => f.length !== n)) throw new Error('preview worker returned malformed frames');
  return { info: r.info, frames: out };
}

export async function renderFrames(source: string, opts: RenderOpts): Promise<Uint8Array[]> {
  return (await previewScript(source, opts)).frames;
}
