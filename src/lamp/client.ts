import { Agent, request as httpRequest } from 'node:http';
import { LampHttpError, LampUnreachable } from './errors';
import { lanLookup } from './lookup';
import { scrub } from '../util/scrub';

export interface LampEndpoint { host: string; port: number; token?: string }

interface RawResponse { status: number; headers: Record<string, string>; data: Buffer }

class TimeoutError extends Error {}

/** Largest response body read from a lamp (OTA info, images and script sources are far smaller). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * HTTP client for one lamp. One keep-alive socket (maxSockets 1: the ESP32 httpd has very few
 * slots) and a promise queue, so at most one request is ever in flight per lamp.
 * Errors never carry the token (scrubbed; the exact token string is also masked).
 */
export class LampClient {
  private ep: LampEndpoint;
  private readonly timeoutMs: number;
  private agent: Agent;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(ep: LampEndpoint, opts?: { timeoutMs?: number }) {
    this.ep = { ...ep };
    this.timeoutMs = opts?.timeoutMs ?? 5000;
    this.agent = makeAgent();
  }

  get<T>(path: string): Promise<T> {
    return this.json<T>('GET', path);
  }

  send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return this.json<T>(method, path, body);
  }

  sendBinary<T>(method: 'POST', path: string, body: Buffer, timeoutMs?: number): Promise<T> {
    return this.enqueue(async () => {
      const r = await this.exec(method, path, body, 'application/octet-stream', timeoutMs);
      return parseJson<T>(this.ok(r));
    });
  }

  getBinary(path: string): Promise<{ data: Buffer; headers: Record<string, string> }> {
    return this.enqueue(async () => {
      const r = await this.exec('GET', path);
      this.ok(r);
      return { data: r.data, headers: r.headers };
    });
  }

  /** A plain-text body (script source: `GET /api/js/<name>`). */
  async getText(path: string): Promise<string> {
    return (await this.getBinary(path)).data.toString('utf8');
  }

  /** A raw request body (script source as text/javascript); returns the raw response body. */
  sendRaw(method: 'POST' | 'PUT', path: string, body: Buffer | string, contentType: string): Promise<{ data: Buffer; headers: Record<string, string> }> {
    return this.enqueue(async () => {
      const r = await this.exec(method, path, typeof body === 'string' ? Buffer.from(body, 'utf8') : body, contentType);
      this.ok(r);
      return { data: r.data, headers: r.headers };
    });
  }

  /** The lamp moved (DHCP / mDNS re-resolve): later requests go to the new address on a fresh socket. */
  updateEndpoint(host: string, port: number): void {
    if (host === this.ep.host && port === this.ep.port) return;
    this.ep = { ...this.ep, host, port };
    this.agent.destroy();
    this.agent = makeAgent();
  }

  destroy(): void {
    this.agent.destroy();
  }

  private json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.enqueue(async () => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = await this.exec(method, path, payload, 'application/json');
      return parseJson<T>(this.ok(r));
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private ok(r: RawResponse): string {
    const text = r.data.toString('utf8');
    if (r.status >= 200 && r.status < 300) return text;
    throw new LampHttpError(r.status, this.clean(unwrapMessage(text, r.status)));
  }

  private clean(s: string): string {
    const t = this.ep.token;
    return scrub(t ? s.split(t).join('***') : s);
  }

  private async exec(method: string, path: string, body?: Buffer, contentType?: string, timeoutMs?: number): Promise<RawResponse> {
    try {
      try {
        return await this.once(method, path, body, contentType, timeoutMs);
      } catch (e) {
        // The lamp closed our kept-alive socket between requests: retry once on a fresh one.
        if ((e as { stale?: boolean }).stale) return await this.once(method, path, body, contentType, timeoutMs);
        throw e;
      }
    } catch (e) {
      if (e instanceof LampHttpError || e instanceof LampUnreachable) throw e;
      const reason = e instanceof TimeoutError ? e.message : (e as NodeJS.ErrnoException).code ?? (e as Error).message;
      throw new LampUnreachable(this.clean(`${this.ep.host}:${this.ep.port} unreachable (${method} ${path}): ${reason}`));
    }
  }

  private once(method: string, path: string, body: Buffer | undefined, contentType: string | undefined, timeoutMs?: number): Promise<RawResponse> {
    const limit = timeoutMs ?? this.timeoutMs;
    return new Promise<RawResponse>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (body) {
        headers['Content-Type'] = contentType ?? 'application/octet-stream';
        headers['Content-Length'] = String(body.length);
      }
      if (this.ep.token) headers['Authorization'] = `Bearer ${this.ep.token}`;

      let timer: NodeJS.Timeout | undefined;
      const done = (fn: () => void) => { clearTimeout(timer); fn(); };
      const req = httpRequest(
        { host: this.ep.host, port: this.ep.port, path, method, headers, agent: this.agent, lookup: lanLookup as never },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size <= MAX_BODY_BYTES) { chunks.push(c); return; }
            // Stop reading and drop the socket: a lamp never sends this much.
            done(() => reject(new LampHttpError(502, `the lamp's response is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB`)));
            req.destroy();
          });
          res.on('end', () => done(() => {
            const h: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
            resolve({ status: res.statusCode ?? 0, headers: h, data: Buffer.concat(chunks) });
          }));
          res.on('error', (e) => done(() => reject(e)));
        },
      );
      timer = setTimeout(() => req.destroy(new TimeoutError(`timed out after ${limit}ms`)), limit);
      req.on('error', (e: NodeJS.ErrnoException) => done(() => {
        const err = e as NodeJS.ErrnoException & { stale?: boolean };
        if (req.reusedSocket && (e.code === 'ECONNRESET' || e.code === 'EPIPE')) err.stale = true;
        reject(err);
      }));
      if (body) req.write(body);
      req.end();
    });
  }
}

function makeAgent(): Agent {
  return new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
}

/** Firmware errors are plain text, or JSON `{status:"error", message|error}`. */
function unwrapMessage(text: string, status: number): string {
  const t = text.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { message?: unknown; error?: unknown };
      if (typeof j.message === 'string' && j.message) return j.message;
      if (typeof j.error === 'string' && j.error) return j.error;
    } catch { /* fall through to the raw text */ }
  }
  return t || `HTTP ${status}`;
}

function parseJson<T>(text: string): T {
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LampHttpError(502, 'lamp returned invalid JSON');
  }
}
