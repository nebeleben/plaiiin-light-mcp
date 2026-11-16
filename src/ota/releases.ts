/**
 * Firmware releases on the public firmware repo, chosen exactly as the PlaiiinLight Mac app
 * chooses them (same asset naming, same "is newer" comparison).
 */
const REPO = 'nebeleben/plaiiin-light';
export const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
/** Asset downloads are only ever fetched from here (GitHub then redirects to its CDN). */
export const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_SUMS_BYTES = 64 * 1024;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const LIST_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const HEADERS = { 'User-Agent': 'plaiiin-lamp-mcp', Accept: 'application/vnd.github+json' };
const FIRMWARE_TAG = /^v\d+\.\d+\.\d+$/;
const ASSET_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export interface FirmwareRelease { version: string; assets: Record<string, string> }

/** esp32 keeps the bare form stem; every other SoC carries a `-<target>` infix. */
export function assetName(form: string, target: string): string {
  return target === 'esp32' ? `${form}-app.bin` : `${form}-${target}-app.bin`;
}

/** Numeric dotted compare; a junk remote never counts as newer, junk local parts count as 0. */
export function isNewer(remote: string, local: string): boolean {
  const parts = (s: string) => s.replace(/^v/, '').split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  const r = parts(remote), l = parts(local);
  if (r.includes(-1)) return false;
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] ?? 0, lv = Math.max(l[i] ?? 0, 0);
    if (rv !== lv) return rv > lv;
  }
  return false;
}

/** Read a response body, refusing more than `max` bytes. */
async function readCapped(res: Response, max: number, what: string): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${what} is larger than ${max >= 1024 * 1024 ? `${max / (1024 * 1024)} MB` : `${max / 1024} KB`}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

interface ApiRelease { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: Array<{ name?: unknown; browser_download_url?: unknown }> }

/**
 * The newest published firmware release (tag `vX.Y.Z`; `ha-v*`, `mac-v*`, `android-v*`, drafts and
 * prereleases are ignored) from the releases list — not `/releases/latest`, which may be another product.
 * Only assets downloadable from the repo's own release URLs are kept.
 */
export async function latestRelease(fetchImpl: typeof fetch = fetch): Promise<FirmwareRelease> {
  const res = await fetchImpl(RELEASES_URL, { headers: HEADERS, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for the firmware release list`);
  let list: unknown;
  try {
    list = JSON.parse((await readCapped(res, MAX_LIST_BYTES, 'the release list')).toString('utf8'));
  } catch (e) {
    throw new Error(`can't read the firmware release list: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(list)) throw new Error('the firmware release list is not a list');
  let best: { version: string; rel: ApiRelease } | undefined;
  for (const r of list as ApiRelease[]) {
    if (!r || typeof r.tag_name !== 'string' || r.draft === true || r.prerelease === true || !FIRMWARE_TAG.test(r.tag_name)) continue;
    const version = r.tag_name.slice(1);
    if (!best || isNewer(version, best.version)) best = { version, rel: r };
  }
  if (!best) throw new Error('no firmware release found');
  const assets: Record<string, string> = {};
  const prefix = `${DOWNLOAD_PREFIX}v${best.version}/`;
  for (const a of best.rel.assets ?? []) {
    if (typeof a?.name !== 'string' || typeof a.browser_download_url !== 'string' || !ASSET_NAME.test(a.name)) continue;
    if (a.browser_download_url !== `${prefix}${a.name}`) continue;
    assets[a.name] = a.browser_download_url;
  }
  return { version: best.version, assets };
}

/**
 * Download one release asset: only from the firmware repo's release URLs, at most `max` bytes, and the
 * body must be exactly the announced Content-Length.
 */
export async function downloadAsset(fetchImpl: typeof fetch, name: string, url: string, max = MAX_ASSET_BYTES): Promise<Buffer> {
  if (!url.startsWith(DOWNLOAD_PREFIX)) throw new Error(`${name}: not a download from the firmware repo`);
  const res = await fetchImpl(url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download of ${name} failed: HTTP ${res.status}`);
  const header = res.headers.get('content-length');
  const announced = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : undefined;
  if (announced === undefined) throw new Error(`download of ${name} has no Content-Length`);
  const label = `${name} (${announced} bytes)`;
  if (announced > max) throw new Error(`${label} is larger than ${max / (1024 * 1024)} MB`);
  const data = await readCapped(res, max, name);
  if (data.length !== announced) throw new Error(`download of ${name} is incomplete: got ${data.length} of Content-Length ${announced} bytes`);
  return data;
}

/** `<64-hex>  <filename>` per line → filename → lowercase hex (blank / odd lines ignored). */
export function parseSha256Sums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && /^[0-9a-fA-F]{64}$/.test(parts[0]!)) out[parts[1]!.replace(/^\*/, '')] = parts[0]!.toLowerCase();
  }
  return out;
}
