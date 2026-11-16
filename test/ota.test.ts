import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assetName, isNewer, latestRelease } from '../src/ota/releases';
import { makeHarness, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const API = 'https://api.github.com/repos/nebeleben/plaiiin-light/releases';
const dl = (tag: string, name: string) => `https://github.com/nebeleben/plaiiin-light/releases/download/${tag}/${name}`;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const BIN = Buffer.from('fake firmware image for display/esp32 '.repeat(50));
const BIN_C3 = Buffer.from('c3 image '.repeat(20));

interface Asset { body: Buffer; length?: number }
interface Rel { tag_name: string; draft?: boolean; prerelease?: boolean; assets: Array<{ name: string; browser_download_url: string }> }

function release(tag: string, files: Record<string, Buffer>, sums = true): { rel: Rel; assets: Record<string, Asset> } {
  const assets: Record<string, Asset> = {};
  const list = Object.entries(files).map(([name, body]) => { assets[dl(tag, name)] = { body }; return { name, browser_download_url: dl(tag, name) }; });
  if (sums) {
    const text = Buffer.from(Object.entries(files).map(([n, b]) => `${sha(b)}  ${n}`).join('\n') + '\n');
    assets[dl(tag, 'SHA256SUMS')] = { body: text };
    list.push({ name: 'SHA256SUMS', browser_download_url: dl(tag, 'SHA256SUMS') });
  }
  return { rel: { tag_name: tag, assets: list }, assets };
}

/** A fake GitHub: the releases list plus asset downloads; records every URL fetched. */
function github(releases: Rel[], assets: Record<string, Asset>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith(API)) return new Response(JSON.stringify(releases), { status: 200, headers: { 'content-type': 'application/json' } });
    const a = assets[url];
    if (!a) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(a.body), { status: 200, headers: { 'content-length': String(a.length ?? a.body.length) } });
  }) as typeof fetch;
  return { fetchImpl, calls, downloads: () => calls.filter((u) => !u.startsWith(API)) };
}

const std = () => {
  const r = release('v2.8.0', { 'display-app.bin': BIN, 'display-esp32c3-app.bin': BIN_C3 });
  return { releases: [r.rel], assets: r.assets };
};

describe('releases', () => {
  it('asset names follow the form and chip target', () => {
    expect(assetName('tower', 'esp32')).toBe('tower-app.bin');
    expect(assetName('tower', 'esp32c3')).toBe('tower-esp32c3-app.bin');
  });

  it('only bare vX.Y.Z tags count; the newest wins; drafts and prereleases are skipped', async () => {
    const g = github([
      { tag_name: 'ha-v0.2.0', assets: [] },
      { tag_name: 'mac-v2.4.0', assets: [] },
      { tag_name: 'android-v2.9.0', assets: [] },
      { tag_name: 'v9.0.0', draft: true, assets: [] },
      { tag_name: 'v3.0.0', prerelease: true, assets: [] },
      { tag_name: 'v2.7.1', assets: [] },
      { tag_name: 'v2.8.0', assets: [{ name: 'display-app.bin', browser_download_url: dl('v2.8.0', 'display-app.bin') }] },
      { tag_name: 'vnext', assets: [] },
    ], {});
    const r = await latestRelease(g.fetchImpl);
    expect(r).toEqual({ version: '2.8.0', assets: { 'display-app.bin': dl('v2.8.0', 'display-app.bin') } });
    expect(g.calls[0]).toMatch(/^https:\/\/api\.github\.com\/repos\/nebeleben\/plaiiin-light\/releases\?per_page=100$/);
  });

  it('no firmware release at all is an error', async () => {
    const g = github([{ tag_name: 'ha-v0.2.0', assets: [] }], {});
    await expect(latestRelease(g.fetchImpl)).rejects.toThrow(/no firmware release/);
  });

  it('version comparison is numeric and fails closed on a junk remote', () => {
    expect(isNewer('2.10.0', '2.9.9')).toBe(true);
    expect(isNewer('2.8.0', '2.8.0')).toBe(false);
    expect(isNewer('2.7.9', '2.8.0')).toBe(false);
    expect(isNewer('2.8.x', '1.0.0')).toBe(false);
  });
});

describe('firmware_check', () => {
  it('reports current, latest and the asset, or why there is no build', async () => {
    const s = std();
    const g = github(s.releases, s.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', firmware: '2.7.0' });
    await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', firmware: '2.7.0', form: 'cube' });
    await t.addFake({ deviceId: 'cccccccccccc', name: 'Gamma', firmware: '2.8.0', target: 'esp32c3' });
    const r = await t.call('firmware_check', { lamps: 'all' });
    expect(r.latest).toBe('2.8.0');
    expect(r.results[0]).toMatchObject({ lamp: 'Alpha', ok: true, current: '2.7.0', latest: '2.8.0', update: true, asset: 'display-app.bin' });
    expect(r.results[1]).toMatchObject({ lamp: 'Beta', ok: true, update: false, reason: 'no build for cube/esp32' });
    expect(r.results[2]).toMatchObject({ lamp: 'Gamma', ok: true, update: false, upToDate: true });
    expect(g.downloads()).toEqual([]);
  });
});

describe('firmware_update', () => {
  it('asks first, then uploads, waits for the new version and reports it', async () => {
    const s = std();
    const g = github(s.releases, s.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', firmware: '2.7.0' });
    a.state.otaNextVersion = '2.8.0';
    const ask = await t.call('firmware_update', { lamps: 'Alpha' });
    expect(ask.needsConfirmation).toBe(true);
    expect(ask.summary).toContain('Alpha: 2.7.0 → 2.8.0');
    expect(a.state.otaReceived).toBeNull();
    expect(g.downloads()).toEqual([]);

    const r = await t.call('firmware_update', { lamps: 'Alpha', confirm: ask.confirm });
    expect(r.version).toBe('2.8.0');
    expect(r.results[0]).toMatchObject({ lamp: 'Alpha', ok: true, from: '2.7.0', to: '2.8.0', asset: 'display-app.bin', verified: 'sha256' });
    expect(a.state.otaReceived!.equals(BIN)).toBe(true);
    expect(g.downloads().filter((u) => u.endsWith('display-app.bin'))).toHaveLength(1);
    expect(t.fleet.get('aaaaaaaaaaaa')!.firmware).toBe('2.8.0');
  });

  it('downloads each asset once; stops at the first failure and skips the rest', async () => {
    const s = std();
    const g = github(s.releases, s.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    const lamps = await Promise.all(['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'].map((id, i) =>
      t.addFake({ deviceId: id, name: ['Alpha', 'Beta', 'Gamma'][i]!, firmware: '2.7.0' })));
    for (const l of lamps) l.state.otaNextVersion = '2.8.0';
    lamps[1]!.state.override = (req, res, path) => {
      if (req.method !== 'POST' || path !== '/api/ota') return false;
      res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('flash write failed'); return true;
    };
    const args = { lamps: ['Alpha', 'Beta', 'Gamma'] };
    const ask = await t.call('firmware_update', args);
    expect(ask.summary).toMatch(/Alpha: 2\.7\.0 → 2\.8\.0[\s\S]*Beta: 2\.7\.0 → 2\.8\.0[\s\S]*Gamma: 2\.7\.0 → 2\.8\.0/);
    const r = await t.call('firmware_update', { ...args, confirm: ask.confirm });
    expect(r.results[0]).toMatchObject({ lamp: 'Alpha', ok: true });
    expect(r.results[1]).toMatchObject({ lamp: 'Beta', ok: false });
    expect(r.results[1].reason).toMatch(/flash write failed/);
    expect(r.results[2]).toMatchObject({ lamp: 'Gamma', ok: false, skipped: true });
    expect(lamps[2]!.state.otaReceived).toBeNull();
    expect(g.downloads().filter((u) => u.endsWith('display-app.bin'))).toHaveLength(1);
  });

  it('a lamp that never reports the new version fails the update', async () => {
    const s = std();
    const g = github(s.releases, s.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    t.ctx.otaRebootTimeoutMs = 200;
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', firmware: '2.7.0' }); // stays on 2.7.0
    const ask = await t.call('firmware_update', { lamps: 'Alpha' });
    const r = await t.call('firmware_update', { lamps: 'Alpha', confirm: ask.confirm });
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].reason).toMatch(/still reports 2\.7\.0/);
  });

  it('an AI key without `ota` is refused before anything is downloaded', async () => {
    const s = std();
    const g = github(s.releases, s.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', role: 'ai', perms: ['control'], firmware: '2.7.0' });
    const r = await t.call('firmware_update', { lamps: 'Alpha' });
    expect(r.results[0]).toMatchObject({ ok: false, skipped: true, reason: "not permitted by this lamp's AI key (needs ota)" });
    expect(g.calls).toEqual([]);
    expect(a.state.otaReceived).toBeNull();
  });

  it('a creator key is refused too; an AI key with `ota` may update', async () => {
    const s = std();
    const g = github(s.releases, s.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', role: 'creator', firmware: '2.7.0' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', role: 'ai', perms: ['ota'], firmware: '2.7.0' });
    b.state.otaNextVersion = '2.8.0';
    const ask = await t.call('firmware_update', { lamps: 'all' });
    expect(ask.summary).toContain('Beta: 2.7.0 → 2.8.0');
    expect(ask.summary).not.toContain('Alpha: 2.7.0');
    const r = await t.call('firmware_update', { lamps: 'all', confirm: ask.confirm });
    expect(r.results[0]).toMatchObject({ lamp: 'Alpha', ok: false, skipped: true });
    expect(r.results[0].reason).toMatch(/needs admin access/);
    expect(r.results[1]).toMatchObject({ lamp: 'Beta', ok: true, to: '2.8.0' });
  });

  it('a hash mismatch stops before the upload', async () => {
    const s = std();
    s.assets[dl('v2.8.0', 'SHA256SUMS')] = { body: Buffer.from(`${'0'.repeat(64)}  display-app.bin\n`) };
    const g = github(s.releases, s.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', firmware: '2.7.0' });
    const ask = await t.call('firmware_update', { lamps: 'Alpha' });
    const r = await t.call('firmware_update', { lamps: 'Alpha', confirm: ask.confirm });
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].reason).toMatch(/SHA-256/);
    expect(a.state.otaReceived).toBeNull();
  });

  it('a release without SHA256SUMS is refused before any download or confirmation', async () => {
    const r0 = release('v2.8.0', { 'display-app.bin': BIN }, false);
    const g = github([r0.rel], r0.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', firmware: '2.7.0' });
    a.state.otaNextVersion = '2.8.0';
    const r = await t.call('firmware_update', { lamps: 'Alpha' });
    expect(r.needsConfirmation).toBeUndefined();
    expect(r.results[0]).toMatchObject({ lamp: 'Alpha', ok: false, reason: 'the release has no SHA256SUMS — not flashing unverified firmware' });
    expect(JSON.stringify(r)).not.toMatch(/size only/);
    expect(g.downloads()).toEqual([]);
    expect(a.state.otaReceived).toBeNull();
  });

  it('a download shorter than its Content-Length fails', async () => {
    const s = std();
    s.assets[dl('v2.8.0', 'display-app.bin')] = { body: BIN, length: BIN.length + 10 };
    const g = github(s.releases, s.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', firmware: '2.7.0' });
    const ask = await t.call('firmware_update', { lamps: 'Alpha' });
    const r = await t.call('firmware_update', { lamps: 'Alpha', confirm: ask.confirm });
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].reason).toMatch(/Content-Length|incomplete/);
    expect(a.state.otaReceived).toBeNull();
  });

  it('an asset larger than 8 MB is refused', async () => {
    const s = std();
    s.assets[dl('v2.8.0', 'display-app.bin')] = { body: Buffer.alloc(9 * 1024 * 1024) };
    const g = github(s.releases, s.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', firmware: '2.7.0' });
    const ask = await t.call('firmware_update', { lamps: 'Alpha' });
    const r = await t.call('firmware_update', { lamps: 'Alpha', confirm: ask.confirm });
    expect(r.results[0].reason).toMatch(/8 MB/);
    expect(a.state.otaReceived).toBeNull();
  });

  it('a token issued for one release does not apply once a newer one is out', async () => {
    const s = std();
    const releases = [...s.releases];
    const g = github(releases, s.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', firmware: '2.7.0' });
    const ask = await t.call('firmware_update', { lamps: 'Alpha' });
    const n = release('v2.8.1', { 'display-app.bin': BIN });
    releases.unshift(n.rel);
    Object.assign(s.assets, n.assets);
    t.ctx.releaseCacheMs = 0;
    const r = await t.call('firmware_update', { lamps: 'Alpha', confirm: ask.confirm });
    expect(r.needsConfirmation).toBe(true);
    expect(r.refused).toBeDefined();
    expect(r.summary).toContain('Alpha: 2.7.0 → 2.8.1');
    expect(a.state.otaReceived).toBeNull();
  });

  it('lamps already up to date need no confirmation', async () => {
    const s = std();
    const g = github(s.releases, s.assets);
    const t = (h = await makeHarness({ fetchImpl: g.fetchImpl }));
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', firmware: '2.8.0' });
    const r = await t.call('firmware_update', { lamps: 'Alpha' });
    expect(r.needsConfirmation).toBeUndefined();
    expect(r.results[0]).toMatchObject({ ok: true, upToDate: true });
  });
});
