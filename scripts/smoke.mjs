#!/usr/bin/env node
// Live smoke test of the built plugin server against one real, UNPAIRED lamp on the LAN.
//
//   npm run build && node scripts/smoke.mjs <lamp-ip>
//
// Spawns plugin/dist/index.js over stdio with a temporary PLAIIIN_LAMPS_DIR and runs read-only tools
// plus one brightness change that is restored at the end. It never uploads, deletes, pairs, renames,
// streams or updates firmware. Exits 1 on the first failed check, 2 when the lamp isn't reachable.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { presentTargets } from './targets.mjs';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ip = process.argv[2];
if (!ip) { console.error('usage: node scripts/smoke.mjs <lamp-ip>'); process.exit(64); }

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// whichever packaging folder this tree has; the bundle is the same in each
const target = presentTargets(root)[0];
const dist = target ? join(root, target.dir, 'dist/index.js') : undefined;
if (!dist || !existsSync(dist)) { console.error('the built bundle is missing — run npm run build first'); process.exit(1); }

// Is it there at all? (Report unreachable instead of a confusing tool failure.)
try {
  const r = await fetch(`http://${ip}/api`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`UNREACHABLE: ${ip} did not answer GET /api (${e instanceof Error ? e.message : e})`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'lamp-mcp-smoke-'));
const transport = new StdioClientTransport({
  command: process.execPath, args: [dist],
  env: { ...process.env, PLAIIIN_LAMPS_DIR: dir },
  stderr: 'inherit',
});
const client = new Client({ name: 'plaiiin-lamps-smoke', version: '0.0.0' });

let failed = false;
const ok = (msg) => console.log(`  ok   ${msg}`);
function check(cond, msg) {
  if (!cond) throw new Error(`check failed: ${msg}`);
  ok(msg);
}
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === 'text')?.text;
  const body = text ? JSON.parse(text) : undefined;
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return { body, content: r.content };
}

let lamp, restoreBrightness;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`server up — ${tools.length} tools`);

  console.log('lamps_discover');
  const disc = (await call('lamps_discover')).body;
  const found = [...disc.added, ...disc.known].find((l) => l.host === ip);
  if (!found) {
    const paired = disc.needsKey.find((l) => l.host === ip);
    throw new Error(paired ? `${ip} is paired — this smoke test needs an unpaired lamp` : `${ip} not found by mDNS (found ${disc.found})`);
  }
  lamp = found.deviceId;
  check(found.role === 'admin', `${found.name} (${lamp}) found as admin`);

  console.log('lamp_info');
  const info = (await call('lamp_info', { lamp })).body;
  check(info.ok && info.online, `online, firmware ${info.info.firmwareVersion}, grid ${info.grid?.w}×${info.grid?.h}, form ${info.form}`);
  const before = info.state.brightness;
  check(typeof before === 'number', `brightness is ${before}`);

  console.log('lamp_brightness 40, then restore');
  restoreBrightness = before;
  const set = (await call('lamp_brightness', { lamps: lamp, value: 40 })).body.results[0];
  check(set.ok && set.brightness === 40, 'brightness set to 40');
  const mid = (await call('lamp_state', { lamps: lamp })).body.results[0];
  check(mid.ok && mid.brightness === 40, 'lamp_state reads 40');
  const back = (await call('lamp_brightness', { lamps: lamp, value: before })).body.results[0];
  restoreBrightness = undefined;
  check(back.ok && back.brightness === before, `brightness restored to ${before}`);

  const script = [
    '// @param speed 0.1..5 = 1 Speed',
    'function shade(x, y, idx, frame, base, params) {',
    '  let v = 0.5 + 0.5 * sinLUT(x * 0.5 + time * 0.003 * params.speed);',
    '  emitBright(v);',
    '}',
  ].join('\n');

  console.log('effect_preview');
  const prev = await call('effect_preview', { source: script, lamp, frames: 4 });
  const img = prev.content.find((c) => c.type === 'image');
  check(img?.mimeType === 'image/png' && img.data.length > 0, `PNG strip ${prev.body.image.width}×${prev.body.image.height}`);
  check(prev.body.params.some((p) => p.name === 'speed'), 'preview found @param speed');

  console.log('effect_validate');
  const val = (await call('effect_validate', { lamp, source: script })).body;
  check(val.ok && val.valid === true, 'the lamp accepts the script (nothing stored)');
  const bad = (await call('effect_validate', { lamp, source: 'function shade() { emit(1, 2); }' })).body;
  check(bad.ok && bad.valid === false && bad.error, `a broken script is rejected: "${bad.error}"`);

  console.log('scenes_list');
  const sc = (await call('scenes_list', { lamp })).body;
  check(sc.ok && Array.isArray(sc.scenes), `${sc.scenes.length} scene(s), active ${sc.active ?? 'none'}`);

  console.log('swarms_list');
  const sw = (await call('swarms_list')).body;
  const mine = sw.swarms.find((s) => s.members.some((m) => m.deviceId === lamp));
  const solo = sw.solo.some((m) => m.deviceId === lamp);
  check(mine || solo, mine ? `in swarm ${mine.swarmId} with ${mine.members.length} member(s) in this fleet` : 'in no swarm');

  console.log('firmware_check');
  const fw = (await call('firmware_check', { lamps: lamp })).body;
  const r = fw.results[0];
  check(r.ok && typeof fw.latest === 'string', `current ${r.current ?? '?'}, latest ${r.latest ?? '?'}, ${r.update ? `update available (${r.asset})` : r.upToDate ? 'up to date' : `no update: ${r.reason ?? JSON.stringify(r)}`}`);

  console.log('\nSMOKE PASSED');
} catch (e) {
  failed = true;
  console.error(`\nSMOKE FAILED: ${e instanceof Error ? e.message : e}`);
  if (lamp && restoreBrightness !== undefined) {
    try { await call('lamp_brightness', { lamps: lamp, value: restoreBrightness }); console.error(`(brightness restored to ${restoreBrightness})`); }
    catch { console.error(`!! could not restore brightness ${restoreBrightness} on ${lamp}`); }
  }
} finally {
  await client.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
